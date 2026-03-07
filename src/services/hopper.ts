import { randomUUID } from "node:crypto";
import { appendAdminLog } from "./admin";
import { db, type LogMeta, type OwedChangeEntry } from "./db";
import { getHopperStatus, sendHopperCommand } from "./serial";

export type HopperDispenseResult = {
  ok: boolean;
  amount: number;
  message: string;
  attempts: number;
  owedChangeId?: string;
};

function safeAmount(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Number(Math.max(0, amount).toFixed(2));
}

export async function recordOwedChange(
  amount: number,
  reason: string,
  meta?: LogMeta,
): Promise<OwedChangeEntry> {
  const entry: OwedChangeEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    amount: safeAmount(amount),
    reason,
    status: "open",
    meta,
  };

  db.data!.owedChanges.unshift(entry);
  await db.write();
  return entry;
}

export async function runHopperSelfTest(): Promise<HopperDispenseResult> {
  const command = db.data!.hopperSettings.selfTestCommand;
  const timeoutMs = db.data!.hopperSettings.timeoutMs;

  if (!db.data!.hopperSettings.enabled) {
    db.data!.hopperStats.selfTestPassed = false;
    db.data!.hopperStats.lastSelfTestAt = new Date().toISOString();
    db.data!.hopperStats.lastError = "Hopper is disabled in settings.";
    await db.write();
    return {
      ok: false,
      amount: 0,
      message: "Hopper is disabled in settings.",
      attempts: 0,
    };
  }

  const serialStatus = getHopperStatus();
  if (!serialStatus.connected) {
    db.data!.hopperStats.selfTestPassed = false;
    db.data!.hopperStats.lastSelfTestAt = new Date().toISOString();
    db.data!.hopperStats.lastError = "Serial port not connected.";
    await db.write();
    return {
      ok: false,
      amount: 0,
      message: "Serial port not connected.",
      attempts: 0,
    };
  }

  const result = await sendHopperCommand(command, timeoutMs);
  db.data!.hopperStats.selfTestPassed = result.ok;
  db.data!.hopperStats.lastSelfTestAt = new Date().toISOString();
  db.data!.hopperStats.lastError = result.ok ? null : result.message;
  await db.write();

  await appendAdminLog(
    result.ok ? "hopper_self_test_passed" : "hopper_self_test_failed",
    result.ok ? "Hopper self-test passed." : "Hopper self-test failed.",
    {
      message: result.message,
      command,
    },
  );

  return {
    ok: result.ok,
    amount: 0,
    message: result.message,
    attempts: 1,
  };
}

export async function dispenseChange(
  amount: number,
): Promise<HopperDispenseResult> {
  const requestedAmount = safeAmount(amount);
  if (requestedAmount <= 0) {
    return {
      ok: true,
      amount: 0,
      message: "No change to dispense.",
      attempts: 0,
    };
  }

  const settings = db.data!.hopperSettings;
  const stats = db.data!.hopperStats;

  if (!settings.enabled) {
    const owed = await recordOwedChange(
      requestedAmount,
      "Hopper disabled in settings.",
    );
    stats.dispenseFailures += 1;
    stats.lastError = "Hopper is disabled in settings.";
    await db.write();

    return {
      ok: false,
      amount: requestedAmount,
      message: "Hopper is disabled in settings.",
      attempts: 0,
      owedChangeId: owed.id,
    };
  }

  const serialStatus = getHopperStatus();
  if (!serialStatus.connected) {
    const owed = await recordOwedChange(
      requestedAmount,
      "Serial port not connected.",
    );
    stats.dispenseFailures += 1;
    stats.lastError = "Serial port not connected.";
    await db.write();

    return {
      ok: false,
      amount: requestedAmount,
      message: "Serial port not connected.",
      attempts: 0,
      owedChangeId: owed.id,
    };
  }

  const maxAttempts = Math.max(1, Math.floor(settings.retryCount) + 1);
  let lastMessage = "Unknown hopper failure.";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    stats.dispenseAttempts += 1;
    const command = `${settings.dispenseCommandPrefix} ${requestedAmount.toFixed(2)}`;
    const result = await sendHopperCommand(command, settings.timeoutMs);

    if (result.ok) {
      stats.dispenseSuccess += 1;
      stats.totalDispensed = Number(
        (stats.totalDispensed + requestedAmount).toFixed(2),
      );
      stats.lastDispensedAt = new Date().toISOString();
      stats.lastError = null;
      await db.write();

      return {
        ok: true,
        amount: requestedAmount,
        message: result.message,
        attempts: attempt,
      };
    }

    lastMessage = result.message;
  }

  const owed = await recordOwedChange(
    requestedAmount,
    "Hopper dispense failed.",
    {
      message: lastMessage,
    },
  );

  stats.dispenseFailures += 1;
  stats.lastError = lastMessage;
  await db.write();

  return {
    ok: false,
    amount: requestedAmount,
    message: lastMessage,
    attempts: maxAttempts,
    owedChangeId: owed.id,
  };
}
