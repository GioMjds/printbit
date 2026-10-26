import { randomUUID } from 'node:crypto';
import { adminService } from './admin';
import { db, type LogMeta, type OwedChangeEntry } from './db';
import {
  anomalyService,
  buildAnomalyFingerprint,
  mapHopperErrorSeverity,
} from './anomaly';
import { adminPushService } from './admin-push.service';
import { getHopperStatus } from './hardware-state-projection';
import {
  sendWorkerRequest,
  type WorkerHardwareResponse,
} from './worker-command-pipe';
export const HopperErrorCode = {
  JAM: 'JAM',
  EMPTY: 'EMPTY',
  MOTOR_TIMEOUT: 'MOTOR_TIMEOUT',
  PARTIAL: 'PARTIAL',
  SENSOR: 'SENSOR',
  UNKNOWN: 'UNKNOWN',
} as const;

export type HopperErrorCodeValue =
  (typeof HopperErrorCode)[keyof typeof HopperErrorCode];

const RETRYABLE_CODES = new Set<string>([
  HopperErrorCode.JAM,
  HopperErrorCode.MOTOR_TIMEOUT,
  HopperErrorCode.PARTIAL,
]);

export function isRetryableError(code: string): boolean {
  return RETRYABLE_CODES.has(code);
}

const REQUEST_ID_ALPHABET = 'abcdef';

export function generateRequestId(): string {
  let id = '';
  for (let i = 0; i < 4; i += 1) {
    const idx = Math.floor(Math.random() * REQUEST_ID_ALPHABET.length);
    id += REQUEST_ID_ALPHABET[idx];
  }
  return id;
}

export interface ChangeComputation {
  coins: number;
  isWholeAmount: boolean;
  effectiveChange: number;
  remainder: number;
}

export function computeDispenseCoins(changeAmount: number): ChangeComputation {
  if (!Number.isFinite(changeAmount) || changeAmount <= 0) {
    return { coins: 0, isWholeAmount: true, effectiveChange: 0, remainder: 0 };
  }

  const coins = Math.floor(changeAmount);
  const remainder = Number((changeAmount - coins).toFixed(2));

  return {
    coins,
    isWholeAmount: remainder === 0,
    effectiveChange: coins,
    remainder,
  };
}
import { getTrustedTimestamp } from './time-source';
import {
  ESP32_AP_BASE_URL,
  ESP32_COIN_BRIDGE_API_KEY,
  NETWORK_PROVIDER,
} from '@/config';
import { safeAmount } from '@/utils';

export interface HopperDispenseResult {
  ok: boolean;
  amount?: number;
  requestedCoins: number;
  dispensedCoins: number;
  message: string;
  attempts: number;
  owedChangeId?: string;
  errorCode?: HopperErrorCodeValue;
}

const ESP32_STATUS_POLL_INTERVAL_MS = 250;
const ESP32_MIN_DISPENSE_WINDOW_MS = 20_000;

type Esp32HopperStatus = {
  dispensing: boolean;
  targetCoins: number;
  dispensedCoins: number;
  activeRequestId: string;
  lastRequestId: string;
  lastOutcome: string;
  lastError: string;
};

type Esp32DispenseAttemptResult = {
  ok: boolean;
  dispensedCoins: number;
  message: string;
  errorCode?: HopperErrorCodeValue;
};

class HopperService {
  private normalizeDispensedCoins(
    dispensed: number | undefined,
    remainingCoins: number,
  ): number {
    if (typeof dispensed !== 'number' || !Number.isFinite(dispensed)) return 0;
    return Math.max(0, Math.min(Math.floor(dispensed), remainingCoins));
  }

  private async recordOwedChange(
    amount: number,
    reason: string,
    meta?: LogMeta,
  ): Promise<OwedChangeEntry> {
    const trusted = getTrustedTimestamp();
    const entry: OwedChangeEntry = {
      id: randomUUID(),
      timestamp: trusted.timestamp,
      timestampMeta: trusted.meta,
      amount: safeAmount(amount),
      reason,
      status: 'open',
      meta,
    };

    db.data!.owedChanges.unshift(entry);
    await db.write();
    return entry;
  }

  private isEsp32Mode(): boolean {
    return NETWORK_PROVIDER === 'esp32';
  }

  private mapEsp32ErrorCode(rawMessage: string): HopperErrorCodeValue {
    const upper = rawMessage.toUpperCase();
    if (upper.includes('JAM')) return HopperErrorCode.JAM;
    if (upper.includes('EMPTY')) return HopperErrorCode.EMPTY;
    if (upper.includes('TIMEOUT') || upper.includes('ABORT')) {
      return HopperErrorCode.MOTOR_TIMEOUT;
    }
    if (upper.includes('PARTIAL')) return HopperErrorCode.PARTIAL;
    if (upper.includes('SENSOR')) return HopperErrorCode.SENSOR;
    return HopperErrorCode.UNKNOWN;
  }

  private async fetchEsp32(
    routePath: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const requestUrl = new URL(routePath, `${ESP32_AP_BASE_URL}/`);
    const normalizedTimeout = Number.isFinite(timeoutMs)
      ? Math.max(1_000, Math.floor(timeoutMs))
      : 8_000;
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      normalizedTimeout,
    );

    try {
      return await fetch(requestUrl, {
        ...init,
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseEsp32HopperStatus(payload: unknown): Esp32HopperStatus | null {
    if (!payload || typeof payload !== 'object') return null;
    const record = payload as Record<string, unknown>;
    return {
      dispensing: record.dispensing === true,
      targetCoins:
        typeof record.targetCoins === 'number' &&
        Number.isFinite(record.targetCoins)
          ? Math.max(0, Math.floor(record.targetCoins))
          : 0,
      dispensedCoins:
        typeof record.dispensedCoins === 'number' &&
        Number.isFinite(record.dispensedCoins)
          ? Math.max(0, Math.floor(record.dispensedCoins))
          : 0,
      activeRequestId:
        typeof record.activeRequestId === 'string'
          ? record.activeRequestId
          : '',
      lastRequestId:
        typeof record.lastRequestId === 'string' ? record.lastRequestId : '',
      lastOutcome:
        typeof record.lastOutcome === 'string' ? record.lastOutcome : '',
      lastError: typeof record.lastError === 'string' ? record.lastError : '',
    };
  }

  private async readEsp32Status(timeoutMs: number): Promise<{
    ok: boolean;
    message: string;
    status?: Esp32HopperStatus;
  }> {
    try {
      const response = await this.fetchEsp32(
        `/hopper/status?token=${encodeURIComponent(ESP32_COIN_BRIDGE_API_KEY)}`,
        {
          method: 'GET',
          headers: {
            'x-hopper-token': ESP32_COIN_BRIDGE_API_KEY,
          },
        },
        timeoutMs,
      );
      const bodyText = (await response.text()).trim();
      if (!response.ok) {
        return {
          ok: false,
          message:
            bodyText.length > 0
              ? `ESP32 hopper status check failed (${response.status}): ${bodyText}`
              : `ESP32 hopper status check failed (${response.status}).`,
        };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        return {
          ok: false,
          message: 'ESP32 hopper status endpoint returned invalid JSON.',
        };
      }

      const parsed = this.parseEsp32HopperStatus(payload);
      if (!parsed) {
        return {
          ok: false,
          message: 'ESP32 hopper status payload is missing required fields.',
        };
      }

      return {
        ok: true,
        status: parsed,
        message: 'ESP32 hopper bridge reachable.',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        message: `ESP32 hopper status check failed: ${message}`,
      };
    }
  }

  private async startEsp32Dispense(
    coins: number,
    requestId: string,
    timeoutMs: number,
  ): Promise<{
    ok: boolean;
    message: string;
    errorCode?: HopperErrorCodeValue;
  }> {
    const body = new URLSearchParams({
      token: ESP32_COIN_BRIDGE_API_KEY,
      coins: String(coins),
      requestId,
    });

    try {
      const response = await this.fetchEsp32(
        '/hopper/dispense',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-hopper-token': ESP32_COIN_BRIDGE_API_KEY,
          },
          body: body.toString(),
        },
        timeoutMs,
      );
      const bodyText = (await response.text()).trim();
      if (response.status === 202 || response.ok) {
        return {
          ok: true,
          message: 'ESP32 hopper accepted dispense request.',
        };
      }

      const message =
        bodyText.length > 0
          ? bodyText
          : `ESP32 hopper dispense request failed (${response.status}).`;
      return {
        ok: false,
        message,
        errorCode: this.mapEsp32ErrorCode(message),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        message: `ESP32 hopper dispense request failed: ${message}`,
        errorCode: this.mapEsp32ErrorCode(message),
      };
    }
  }

  private async waitForEsp32Dispense(
    requestId: string,
    coins: number,
    timeoutMs: number,
  ): Promise<Esp32DispenseAttemptResult> {
    const waitWindowMs = Math.max(
      Number.isFinite(timeoutMs)
        ? Math.max(1_000, Math.floor(timeoutMs))
        : 8_000,
      ESP32_MIN_DISPENSE_WINDOW_MS,
    );
    const statusTimeoutMs = Math.max(
      1_000,
      Number.isFinite(timeoutMs) ? Math.floor(timeoutMs / 2) : 4_000,
    );
    const startedAt = Date.now();
    let lastDispensedCoins = 0;

    while (Date.now() - startedAt <= waitWindowMs) {
      const statusResult = await this.readEsp32Status(statusTimeoutMs);
      if (!statusResult.ok || !statusResult.status) {
        return {
          ok: false,
          dispensedCoins: lastDispensedCoins,
          message: statusResult.message,
          errorCode: this.mapEsp32ErrorCode(statusResult.message),
        };
      }

      const status = statusResult.status;
      const requestMatched =
        status.activeRequestId === requestId ||
        status.lastRequestId === requestId;

      if (requestMatched) {
        lastDispensedCoins = Math.max(
          lastDispensedCoins,
          status.dispensedCoins,
        );
      }

      if (status.dispensing) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, ESP32_STATUS_POLL_INTERVAL_MS),
        );
        continue;
      }

      if (!requestMatched) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, ESP32_STATUS_POLL_INTERVAL_MS),
        );
        continue;
      }

      const outcome = status.lastOutcome.trim().toLowerCase();
      if (outcome === 'done') {
        const dispensed = Math.max(lastDispensedCoins, status.dispensedCoins);
        return {
          ok: true,
          dispensedCoins: dispensed > 0 ? dispensed : coins,
          message: `ESP32 hopper dispensed ${dispensed > 0 ? dispensed : coins} coin(s).`,
        };
      }

      const detail = status.lastError.trim();
      const failureMessage =
        detail.length > 0
          ? `ESP32 hopper reported ${status.lastOutcome || 'failed'}: ${detail}`
          : `ESP32 hopper reported ${status.lastOutcome || 'failed'}.`;
      return {
        ok: false,
        dispensedCoins: lastDispensedCoins,
        message: failureMessage,
        errorCode: this.mapEsp32ErrorCode(detail || status.lastOutcome),
      };
    }

    return {
      ok: false,
      dispensedCoins: lastDispensedCoins,
      message: 'ESP32 hopper timed out while dispensing change.',
      errorCode: HopperErrorCode.MOTOR_TIMEOUT,
    };
  }

  private async dispenseChangeViaEsp32(
    requestedAmount: number,
    coins: number,
  ): Promise<HopperDispenseResult> {
    const settings = db.data!.hopperSettings;
    const stats = db.data!.hopperStats;
    const maxAttempts = Math.max(1, Math.floor(settings.retryCount) + 1);
    let lastMessage = 'ESP32 hopper dispense failed.';
    let lastErrorCode: HopperErrorCodeValue | undefined =
      HopperErrorCode.UNKNOWN;
    let totalDispensedCoins = 0;
    let remainingCoins = coins;
    let performedAttempts = 0;

    for (
      let attempt = 1;
      attempt <= maxAttempts && remainingCoins > 0;
      attempt += 1
    ) {
      performedAttempts = attempt;
      stats.dispenseAttempts += 1;
      const requestId = generateRequestId();
      const startResult = await this.startEsp32Dispense(
        remainingCoins,
        requestId,
        settings.timeoutMs,
      );
      if (!startResult.ok) {
        lastMessage = startResult.message;
        lastErrorCode = startResult.errorCode;
        if (
          lastErrorCode &&
          lastErrorCode !== HopperErrorCode.UNKNOWN &&
          !isRetryableError(lastErrorCode)
        ) {
          break;
        }
        continue;
      }

      const attemptResult = await this.waitForEsp32Dispense(
        requestId,
        remainingCoins,
        settings.timeoutMs,
      );
      if (attemptResult.ok) {
        const dispensed = attemptResult.dispensedCoins;
        totalDispensedCoins += dispensed;
        remainingCoins -= dispensed;
        stats.dispenseSuccess += 1;
        stats.totalDispensed += totalDispensedCoins;
        stats.lastDispensedAt = new Date().toISOString();
        stats.lastError = null;
        await db.write();

        return {
          ok: true,
          amount: requestedAmount,
          requestedCoins: coins,
          dispensedCoins: totalDispensedCoins,
          message: attemptResult.message,
          attempts: performedAttempts,
        };
      }

      lastMessage = attemptResult.message;
      lastErrorCode = attemptResult.errorCode;
      const dispensedThisAttempt = this.normalizeDispensedCoins(
        attemptResult.dispensedCoins,
        remainingCoins,
      );
      if (dispensedThisAttempt > 0) {
        totalDispensedCoins += dispensedThisAttempt;
        remainingCoins -= dispensedThisAttempt;
      }
      if (
        lastErrorCode &&
        lastErrorCode !== HopperErrorCode.UNKNOWN &&
        !isRetryableError(lastErrorCode)
      ) {
        break;
      }
    }

    if (remainingCoins <= 0) {
      stats.dispenseSuccess += 1;
      stats.totalDispensed += totalDispensedCoins;
      stats.lastDispensedAt = new Date().toISOString();
      stats.lastError = null;
      await db.write();

      return {
        ok: true,
        amount: requestedAmount,
        requestedCoins: coins,
        dispensedCoins: totalDispensedCoins,
        message:
          lastMessage.length > 0
            ? `${lastMessage} (Full payout reached.)`
            : 'Hopper dispensed full change.',
        attempts: performedAttempts,
      };
    }

    const remainingAmount = Math.max(0, requestedAmount - totalDispensedCoins);
    const owed =
      remainingAmount > 0
        ? await this.recordOwedChange(
            remainingAmount,
            'ESP32 hopper dispense failed.',
            {
              message: lastMessage,
              requestedCoins: coins,
              dispensedCoins: totalDispensedCoins,
              remainingCoins,
              errorCode: lastErrorCode ?? null,
            },
          )
        : undefined;

    stats.totalDispensed += totalDispensedCoins;
    stats.dispenseFailures += 1;
    stats.lastError = lastMessage;
    await db.write();
    await anomalyService.report({
      type: 'hopper_dispense_failed',
      source: 'hopper',
      category: 'hopper',
      severity: mapHopperErrorSeverity(lastErrorCode),
      message: `ESP32 hopper dispense failed: ${lastMessage}`,
      fingerprint: buildAnomalyFingerprint([
        'hopper',
        'dispense-failed',
        'esp32',
        lastErrorCode ?? 'unknown',
        lastMessage,
      ]),
      context: {
        amount: requestedAmount,
        requestedCoins: coins,
        dispensedCoins: totalDispensedCoins,
        remainingCoins,
        remainingAmount,
        errorCode: lastErrorCode ?? null,
        attempts: performedAttempts,
        provider: 'esp32',
      },
    });

    return {
      ok: false,
      amount: requestedAmount,
      requestedCoins: coins,
      dispensedCoins: totalDispensedCoins,
      message: lastMessage,
      attempts: performedAttempts,
      owedChangeId: owed?.id,
      errorCode: lastErrorCode,
    };
  }

  async dispenseChange(amount: number): Promise<HopperDispenseResult> {
    const requestedAmount = safeAmount(amount);
    if (requestedAmount <= 0) {
      return {
        ok: true,
        amount: 0,
        requestedCoins: 0,
        dispensedCoins: 0,
        message: 'No change to dispense.',
        attempts: 0,
      };
    }

    const { coins, isWholeAmount } = computeDispenseCoins(requestedAmount);
    if (!isWholeAmount) {
      console.warn(
        `[HOPPER] ⚠ Change amount ₱${requestedAmount} is not a whole peso — this indicates a pricing configuration issue.`,
      );
    }

    if (coins <= 0) {
      return {
        ok: true,
        amount: requestedAmount,
        requestedCoins: 0,
        dispensedCoins: 0,
        message: 'No coins to dispense (amount below 1 peso).',
        attempts: 0,
      };
    }

    const settings = db.data!.hopperSettings;
    const stats = db.data!.hopperStats;

    if (!settings.enabled) {
      const owed = await this.recordOwedChange(
        requestedAmount,
        'Hopper disabled in settings.',
        {
          requestedCoins: coins,
        },
      );
      stats.dispenseFailures += 1;
      stats.lastError = 'Hopper is disabled in settings.';
      await db.write();
      await anomalyService.report({
        type: 'hopper_dispense_disabled',
        source: 'hopper',
        category: 'hopper',
        severity: 'warning',
        message:
          'Hopper dispense failed because hopper is disabled in settings.',
        fingerprint: buildAnomalyFingerprint([
          'hopper',
          'dispense',
          'disabled',
        ]),
        context: {
          amount: requestedAmount,
          requestedCoins: coins,
        },
      });

      return {
        ok: false,
        amount: requestedAmount,
        requestedCoins: coins,
        dispensedCoins: 0,
        message: 'Hopper is disabled in settings.',
        attempts: 0,
        owedChangeId: owed.id,
      };
    }

    if (this.isEsp32Mode()) {
      return this.dispenseChangeViaEsp32(requestedAmount, coins);
    }

    const serialStatus = getHopperStatus();
    if (!serialStatus.connected) {
      const owed = await this.recordOwedChange(
        requestedAmount,
        'Serial port not connected.',
        {
          requestedCoins: coins,
        },
      );
      stats.dispenseFailures += 1;
      stats.lastError = 'Serial port not connected.';
      await db.write();
      await anomalyService.report({
        type: 'hopper_dispense_serial_disconnected',
        source: 'hopper',
        category: 'hopper',
        severity: 'critical',
        message: 'Hopper dispense failed because serial is disconnected.',
        fingerprint: buildAnomalyFingerprint([
          'hopper',
          'dispense',
          'serial-disconnected',
        ]),
        context: {
          amount: requestedAmount,
          requestedCoins: coins,
        },
      });

      return {
        ok: false,
        amount: requestedAmount,
        requestedCoins: coins,
        dispensedCoins: 0,
        message: 'Serial port not connected.',
        attempts: 0,
        owedChangeId: owed.id,
      };
    }

    const maxAttempts = Math.max(1, Math.floor(settings.retryCount) + 1);
    let lastMessage = 'Unknown hopper failure.';
    let lastErrorCode: HopperErrorCodeValue | undefined = undefined;
    let totalDispensedCoins = 0;
    let remainingCoins = coins;
    let performedAttempts = 0;

    for (
      let attempt = 1;
      attempt <= maxAttempts && remainingCoins > 0;
      attempt += 1
    ) {
      performedAttempts = attempt;
      stats.dispenseAttempts += 1;
      const requestId = generateRequestId();
      const result = await sendWorkerRequest<WorkerHardwareResponse>({
        type: 'DispenseCoins',
        requestId,
        coinCount: remainingCoins,
        timeoutMs: settings.timeoutMs,
      });

      if (result && result.success) {
        const dispensed = this.normalizeDispensedCoins(
          result.dispensedCoins ?? remainingCoins,
          remainingCoins,
        );
        if (dispensed < remainingCoins) {
          totalDispensedCoins += dispensed;
          remainingCoins -= dispensed;
          lastErrorCode = HopperErrorCode.PARTIAL;
          lastMessage = `Hopper reported success after dispensing ${dispensed}/${remainingCoins + dispensed} coin(s).`;
          continue;
        }
        totalDispensedCoins += dispensed;
        remainingCoins -= dispensed;
        stats.dispenseSuccess += 1;
        stats.totalDispensed += totalDispensedCoins;
        stats.lastDispensedAt = new Date().toISOString();
        stats.lastError = null;
        await db.write();

        return {
          ok: true,
          amount: requestedAmount,
          requestedCoins: coins,
          dispensedCoins: totalDispensedCoins,
          message: result.message || 'Hopper dispensed full change.',
          attempts: performedAttempts,
        };
      }

      lastMessage = result?.message || 'Hopper command failed or timed out.';
      lastErrorCode =
        (result?.errorCode as HopperErrorCodeValue) || HopperErrorCode.UNKNOWN;
      const dispensedThisAttempt = this.normalizeDispensedCoins(
        result?.dispensedCoins,
        remainingCoins,
      );
      if (dispensedThisAttempt > 0) {
        totalDispensedCoins += dispensedThisAttempt;
        remainingCoins -= dispensedThisAttempt;
      }

      // Only retry on retryable error codes; abort immediately for non-retryable
      if (lastErrorCode && !isRetryableError(lastErrorCode)) {
        break;
      }
    }

    if (remainingCoins <= 0) {
      stats.dispenseSuccess += 1;
      stats.totalDispensed += totalDispensedCoins;
      stats.lastDispensedAt = new Date().toISOString();
      stats.lastError = null;
      await db.write();

      return {
        ok: true,
        amount: requestedAmount,
        requestedCoins: coins,
        dispensedCoins: totalDispensedCoins,
        message:
          lastMessage.length > 0
            ? `${lastMessage} (Full payout reached.)`
            : 'Hopper dispensed full change.',
        attempts: performedAttempts,
      };
    }

    const remainingAmount = Math.max(0, requestedAmount - totalDispensedCoins);
    const owed =
      remainingAmount > 0
        ? await this.recordOwedChange(
            remainingAmount,
            'Hopper dispense failed.',
            {
              message: lastMessage,
              requestedCoins: coins,
              dispensedCoins: totalDispensedCoins,
              remainingCoins,
              errorCode: lastErrorCode ?? null,
            },
          )
        : undefined;

    stats.totalDispensed += totalDispensedCoins;
    stats.dispenseFailures += 1;
    stats.lastError = lastMessage;
    await db.write();
    await anomalyService.report({
      type: 'hopper_dispense_failed',
      source: 'hopper',
      category: 'hopper',
      severity: mapHopperErrorSeverity(lastErrorCode),
      message: `Hopper dispense failed: ${lastMessage}`,
      fingerprint: buildAnomalyFingerprint([
        'hopper',
        'dispense-failed',
        lastErrorCode ?? 'unknown',
        lastMessage,
      ]),
      context: {
        amount: requestedAmount,
        requestedCoins: coins,
        dispensedCoins: totalDispensedCoins,
        remainingCoins,
        remainingAmount,
        errorCode: lastErrorCode ?? null,
        attempts: performedAttempts,
      },
    });

    if (lastErrorCode === HopperErrorCode.EMPTY) {
      void adminPushService.broadcastCriticalAlert({
        code: 'HOPPER_EMPTY',
        title: '⚠️ Coin Hopper Empty!',
        message: 'Kiosk coin hopper is empty. Change cannot be dispensed.',
        severity: 'critical',
      });
    }

    return {
      ok: false,
      amount: requestedAmount,
      requestedCoins: coins,
      dispensedCoins: totalDispensedCoins,
      message: lastMessage,
      attempts: performedAttempts,
      owedChangeId: owed?.id,
      errorCode: lastErrorCode,
    };
  }

  async runSelfTest(): Promise<HopperDispenseResult> {
    const timeoutMs = db.data!.hopperSettings.timeoutMs;

    if (!db.data!.hopperSettings.enabled) {
      await anomalyService.report({
        type: 'hopper_self_test_disabled',
        source: 'hopper',
        category: 'hopper',
        severity: 'warning',
        message: 'Hopper self-test requested but hopper is disabled.',
        fingerprint: buildAnomalyFingerprint([
          'hopper',
          'self-test',
          'disabled',
        ]),
      });
      return {
        ok: false,
        amount: 0,
        requestedCoins: 0,
        dispensedCoins: 0,
        message: 'Hopper is disabled in settings.',
        attempts: 0,
      };
    }

    if (this.isEsp32Mode()) {
      const statusResult = await this.readEsp32Status(timeoutMs);
      db.data!.hopperStats.selfTestPassed = statusResult.ok;
      db.data!.hopperStats.lastSelfTestAt = new Date().toISOString();
      db.data!.hopperStats.lastError = statusResult.ok
        ? null
        : statusResult.message;
      await db.write();

      if (!statusResult.ok) {
        await anomalyService.report({
          type: 'hopper_self_test_esp32_unreachable',
          source: 'hopper',
          category: 'hopper',
          severity: 'critical',
          message: `Hopper self-test failed in ESP32 mode: ${statusResult.message}`,
          fingerprint: buildAnomalyFingerprint([
            'hopper',
            'self-test',
            'esp32-unreachable',
            statusResult.message,
          ]),
        });
      }

      await adminService.appendAdminLog(
        statusResult.ok ? 'hopper_self_test_passed' : 'hopper_self_test_failed',
        statusResult.ok
          ? 'Hopper self-test passed (ESP32 bridge reachable).'
          : 'Hopper self-test failed (ESP32 bridge unreachable).',
        {
          message: statusResult.message,
          transport: 'esp32-http',
          baseUrl: ESP32_AP_BASE_URL,
        },
      );

      return {
        ok: statusResult.ok,
        amount: 0,
        requestedCoins: 0,
        dispensedCoins: 0,
        message: statusResult.message,
        attempts: 1,
      };
    }

    const serialStatus = getHopperStatus();
    if (!serialStatus.connected) {
      db.data!.hopperStats.selfTestPassed = false;
      db.data!.hopperStats.lastSelfTestAt = new Date().toISOString();
      db.data!.hopperStats.lastError = 'Serial port not connected.';
      await db.write();
      await anomalyService.report({
        type: 'hopper_self_test_serial_disconnected',
        source: 'hopper',
        category: 'hopper',
        severity: 'critical',
        message: 'Hopper self-test failed because serial is disconnected.',
        fingerprint: buildAnomalyFingerprint([
          'hopper',
          'self-test',
          'serial-disconnected',
        ]),
      });
      return {
        ok: false,
        amount: 0,
        requestedCoins: 0,
        dispensedCoins: 0,
        message: 'Serial port not connected.',
        attempts: 0,
      };
    }

    const message = 'Hopper hardware is connected and operational.';
    db.data!.hopperStats.selfTestPassed = true;
    db.data!.hopperStats.lastSelfTestAt = new Date().toISOString();
    db.data!.hopperStats.lastError = null;
    await db.write();

    await adminService.appendAdminLog(
      'hopper_self_test_passed',
      'Hopper self-test passed.',
      {
        message,
        portPath: serialStatus.portPath,
      },
    );

    return {
      ok: true,
      amount: 0,
      requestedCoins: 0,
      dispensedCoins: 0,
      message,
      attempts: 1,
    };
  }
}

export const hopperService = new HopperService();
export const runHopperSelfTest = hopperService.runSelfTest.bind(hopperService);
