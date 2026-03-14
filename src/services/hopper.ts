import { randomUUID } from 'node:crypto';
import { adminService } from './admin';
import { db, type LogMeta, type OwedChangeEntry } from './db';
import {
  getHopperStatus,
  sendHopperCommand,
  type HopperCommandResult,
} from './serial';
import {
  buildDispenseCommand,
  buildSelfTestCommand,
  computeDispenseCoins,
  generateRequestId,
  isRetryableError,
  type HopperErrorCodeValue,
} from './hopper-protocol';
import { safeAmount } from '@/utils';

export type HopperDispenseResult = {
  ok: boolean;
  amount: number;
  requestedCoins: number;
  dispensedCoins: number;
  message: string;
  attempts: number;
  owedChangeId?: string;
  errorCode?: HopperErrorCodeValue;
};

class HopperService {
  private async recordOwedChange(
    amount: number,
    reason: string,
    meta?: LogMeta,
  ): Promise<OwedChangeEntry> {
    const entry: OwedChangeEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      amount: safeAmount(amount),
      reason,
      status: 'open',
      meta,
    };

    db.data!.owedChanges.unshift(entry);
    await db.write();
    return entry;
  }

  async runSelfTest(): Promise<HopperDispenseResult> {
    const timeoutMs = db.data!.hopperSettings.timeoutMs;

    if (!db.data!.hopperSettings.enabled) {
      db.data!.hopperStats.selfTestPassed = false;
      db.data!.hopperStats.lastSelfTestAt = new Date().toISOString();
      db.data!.hopperStats.lastError = 'Hopper is disabled in settings.';
      await db.write();
      return {
        ok: false,
        amount: 0,
        requestedCoins: 0,
        dispensedCoins: 0,
        message: 'Hopper is disabled in settings.',
        attempts: 0,
      };
    }

    const serialStatus = getHopperStatus();
    if (!serialStatus.connected) {
      db.data!.hopperStats.selfTestPassed = false;
      db.data!.hopperStats.lastSelfTestAt = new Date().toISOString();
      db.data!.hopperStats.lastError = 'Serial port not connected.';
      await db.write();
      return {
        ok: false,
        amount: 0,
        requestedCoins: 0,
        dispensedCoins: 0,
        message: 'Serial port not connected.',
        attempts: 0,
      };
    }

    const requestId = generateRequestId();
    const command = buildSelfTestCommand(requestId);
    const result = await sendHopperCommand(command, timeoutMs, requestId);

    db.data!.hopperStats.selfTestPassed = result.ok;
    db.data!.hopperStats.lastSelfTestAt = new Date().toISOString();
    db.data!.hopperStats.lastError = result.ok ? null : result.message;
    await db.write();

    await adminService.appendAdminLog(
      result.ok ? 'hopper_self_test_passed' : 'hopper_self_test_failed',
      result.ok ? 'Hopper self-test passed.' : 'Hopper self-test failed.',
      {
        message: result.message,
        command,
        requestId,
      },
    );

    return {
      ok: result.ok,
      amount: 0,
      requestedCoins: 0,
      dispensedCoins: 0,
      message: result.message,
      attempts: 1,
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
    let lastResult: HopperCommandResult | null = null;
    let performedAttempts = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      performedAttempts = attempt;
      stats.dispenseAttempts += 1;
      const requestId = generateRequestId();
      const command = buildDispenseCommand(requestId, coins);
      const result = await sendHopperCommand(
        command,
        settings.timeoutMs,
        requestId,
      );
      lastResult = result;

      if (result.ok) {
        const dispensed = result.dispensedCoins ?? coins;
        stats.dispenseSuccess += 1;
        stats.totalDispensed += dispensed;
        stats.lastDispensedAt = new Date().toISOString();
        stats.lastError = null;
        await db.write();

        return {
          ok: true,
          amount: requestedAmount,
          requestedCoins: coins,
          dispensedCoins: dispensed,
          message: result.message,
          attempts: performedAttempts,
        };
      }

      lastMessage = result.message;

      // Only retry on retryable error codes; abort immediately for non-retryable
      if (result.errorCode && !isRetryableError(result.errorCode)) {
        break;
      }
    }

    const owed = await this.recordOwedChange(
      requestedAmount,
      'Hopper dispense failed.',
      {
        message: lastMessage,
        requestedCoins: coins,
        errorCode: lastResult?.errorCode ?? null,
      },
    );

    stats.dispenseFailures += 1;
    stats.lastError = lastMessage;
    await db.write();

    return {
      ok: false,
      amount: requestedAmount,
      requestedCoins: coins,
      dispensedCoins: 0,
      message: lastMessage,
      attempts: performedAttempts,
      owedChangeId: owed.id,
      errorCode: lastResult?.errorCode,
    };
  }
}

export const hopperService = new HopperService();
export const runHopperSelfTest = hopperService.runSelfTest.bind(hopperService);
