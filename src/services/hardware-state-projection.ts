import type { Server, Socket } from 'socket.io';
import { db } from './db';
import { adminService } from './admin';
import { financialLedgerService } from './financial-ledger';
import type { WorkerPrintEvent } from './worker-return-pipe';
import {
  sendWorkerCommand,
  type WorkerHardwareResponse,
} from './worker-command-pipe';
import { coinSimulation } from './coin-simulation';

export const CUSTOMER_PAYMENT_LOCK_OWNER = 'customer-payment';

interface HardwareStateProjectionDeps {
  sendWorkerCommand?: (
    command: Record<string, unknown>,
  ) => Promise<WorkerHardwareResponse | null>;
  now?: () => string;
}

export interface SerialStatus {
  connected: boolean;
  portPath: string | null;
  lastError: string | null;
  apIp: string | null;
  staIp: string | null;
  kioskIp: string | null;
  coinTarget: string | null;
  portalTarget: string | null;
}

export interface HopperStatus {
  connected: boolean;
  pending: boolean;
  portPath: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
}

export class HardwareStateProjection {
  private readonly sendWorkerCommand: (
    command: Record<string, unknown>,
  ) => Promise<WorkerHardwareResponse | null>;

  private readonly now: () => string;

  private serialStatus: SerialStatus = {
    connected: false,
    portPath: null,
    lastError: null,
    apIp: null,
    staIp: null,
    kioskIp: null,
    coinTarget: null,
    portalTarget: null,
  };

  private hopperStatus: HopperStatus = {
    connected: false,
    pending: false,
    portPath: null,
    lastError: null,
    lastSuccessAt: null,
  };

  private coinSlotLocks = new Map<string, string>();
  private io: Server | Socket | { emit: (event: string, ...args: unknown[]) => void } | null = null;

  public constructor(deps: HardwareStateProjectionDeps = {}) {
    this.sendWorkerCommand = deps.sendWorkerCommand ?? (async (command) => ({
      success: await sendWorkerCommand(command as any),
    }));
    this.now = deps.now ?? (() => new Date().toISOString());
    this.coinSlotLocks.set(CUSTOMER_PAYMENT_LOCK_OWNER, this.now());
  }

  public setSocketIo(
    io: Server | Socket | { emit: (event: string, ...args: unknown[]) => void } | null,
  ): void {
    this.io = io;
  }

  public getSerialStatus(): SerialStatus {
    return { ...this.serialStatus };
  }

  public getHopperStatus(): HopperStatus {
    return { ...this.hopperStatus };
  }

  public isCoinSlotLocked(): boolean {
    return this.coinSlotLocks.size > 0;
  }

  public isCoinSlotLockedBy(ownerId: string): boolean {
    return this.coinSlotLocks.has(ownerId);
  }

  public getCoinSlotLockOwners(): string[] {
    return Array.from(this.coinSlotLocks.keys());
  }

  public getCoinSlotLockOwnerId(): string | null {
    const owners = this.getCoinSlotLockOwners();
    if (owners.length === 0) return null;
    const nonPowerSafety = owners.find((o) => o !== 'power-safety');
    return nonPowerSafety ?? owners[0];
  }

  public getCoinSlotLockedAt(): string | null {
    const first = this.coinSlotLocks.values().next();
    return first.done ? null : first.value;
  }

  public resetCoinSlotLocks(): void {
    this.coinSlotLocks.clear();
  }

  public async initializeCustomerPaymentLock(): Promise<boolean> {
    this.coinSlotLocks.set(CUSTOMER_PAYMENT_LOCK_OWNER, this.now());
    try {
      const response = await this.sendWorkerCommand({
        type: 'LockCoinSlot',
        requestId: `customer-payment-lock-${Date.now()}`,
        ownerId: CUSTOMER_PAYMENT_LOCK_OWNER,
        reason: 'customer_payment_initialize',
        timestampUtc: this.now(),
      });
      return response?.success === true;
    } catch {
      return false;
    }
  }

  public async armCustomerPayment(): Promise<boolean> {
    try {
      const response = await this.sendWorkerCommand({
        type: 'UnlockCoinSlot',
        requestId: `customer-payment-unlock-${Date.now()}`,
        ownerId: CUSTOMER_PAYMENT_LOCK_OWNER,
        reason: 'customer_payment_arm',
        timestampUtc: this.now(),
      });
      if (response?.success !== true) {
        return false;
      }
      this.coinSlotLocks.delete(CUSTOMER_PAYMENT_LOCK_OWNER);
      return true;
    } catch {
      return false;
    }
  }

  public async disarmCustomerPayment(reason: string): Promise<boolean> {
    this.coinSlotLocks.set(CUSTOMER_PAYMENT_LOCK_OWNER, this.now());
    try {
      const response = await this.sendWorkerCommand({
        type: 'LockCoinSlot',
        requestId: `customer-payment-lock-${Date.now()}`,
        ownerId: CUSTOMER_PAYMENT_LOCK_OWNER,
        reason,
        timestampUtc: this.now(),
      });
      return response?.success === true;
    } catch {
      return false;
    }
  }

  public lockCoinSlot(ownerId: string, reason?: string): void {
    this.coinSlotLocks.set(ownerId, new Date().toISOString());
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    try {
      void sendWorkerCommand({
        type: 'LockCoinSlot' as any,
        requestId: `lock-${Date.now()}`,
        ownerId,
        reason,
        timestampUtc: new Date().toISOString(),
      } as any);
    } catch {
      // Best-effort dispatch
    }
  }

  public unlockOwnedCoinSlot(ownerId: string): boolean {
    if (!this.coinSlotLocks.has(ownerId)) {
      return false;
    }
    this.coinSlotLocks.delete(ownerId);
    if (process.env.NODE_ENV === 'test') {
      return true;
    }
    try {
      void sendWorkerCommand({
        type: 'UnlockCoinSlot' as any,
        requestId: `unlock-${Date.now()}`,
        ownerId,
        timestampUtc: new Date().toISOString(),
      } as any);
    } catch {
      // Best-effort dispatch
    }
    return true;
  }

  public async sendKioskIpAnnouncement(
    ip: string,
    port: number,
    path: string,
  ): Promise<boolean> {
    try {
      const success = await sendWorkerCommand({
        type: 'AnnounceKioskIp' as any,
        requestId: `ann-${Date.now()}`,
        ip,
        port,
        path,
        timestampUtc: new Date().toISOString(),
      } as any);
      return success;
    } catch {
      return false;
    }
  }

  private async creditWorkerCoin(evt: WorkerPrintEvent): Promise<number> {
    const value = evt.coinValue ?? 0;
    if (value <= 0 || !db.data) {
      if (evt.simulated) throw new Error('Balance storage unavailable');
      return db.data?.balance ?? 0;
    }
    db.data.balance += value;
    const balance = db.data.balance;
    await db.write?.();
    await adminService.incrementCoinStats(value);
    await adminService.appendAdminLog('coin_accepted',
      `${evt.simulated ? 'Simulated' : 'Accepted'} coin: ${value}`, {
        coinValue: value, balance,
        ...(evt.simulated ? { simulated: true, requestId: evt.requestId } : {}),
      });
    await financialLedgerService.append({
      eventType: 'coin_inserted', amount: value,
      meta: {
        source: evt.simulated ? 'worker-simulation' : 'worker', balance,
        ...(evt.simulated ? { simulated: true, requestId: evt.requestId } : {}),
      },
    });
    this.io?.emit('balance', db.data.balance);
    this.io?.emit('coinAccepted', { value, balance: db.data.balance });
    return balance;
  }

  public async applyEvent(evt: WorkerPrintEvent): Promise<void> {
    if (evt.simulated === true && (evt.type === 'CoinInserted' || evt.type === 'CoinRejected')) {
      await coinSimulation.applyEvent(evt, () => this.creditWorkerCoin(evt));
      return;
    }
    switch (evt.type) {
      case 'CoinInserted': {
        await this.creditWorkerCoin(evt);
        break;
      }

      case 'CoinRejected': {
        this.io?.emit('coinRejected', {
          value: evt.coinValue,
          reason: evt.rejectReason,
        });

        await adminService.appendAdminLog(
          'coin_rejected',
          `Coin rejected: ${evt.rejectReason ?? 'unknown'}`,
          {
            coinValue: evt.coinValue ?? null,
            reason: evt.rejectReason ?? null,
          },
        );
        break;
      }

      case 'HopperProgress': {
        this.hopperStatus.pending = true;
        this.io?.emit('hopperProgress', {
          requestId: evt.requestId ?? evt.hardwareRequestId,
          dispensed: evt.dispensedCoins,
          total: evt.totalCoins,
        });
        break;
      }

      case 'HopperDispensed': {
        this.hopperStatus.pending = false;
        if (!evt.errorCode) {
          this.hopperStatus.lastSuccessAt = evt.timestampUtc;
          this.hopperStatus.lastError = null;
        } else {
          this.hopperStatus.lastError = evt.message ?? evt.errorCode;
        }
        break;
      }

      case 'HardwareStatus': {
        this.serialStatus.connected = true;
        this.io?.emit('serialStatus', this.getSerialStatus());
        break;
      }
    }
  }
}

export const hardwareStateProjection = new HardwareStateProjection();

// Top-level exported convenience functions matching legacy serial.ts
export function getSerialStatus(): SerialStatus {
  return hardwareStateProjection.getSerialStatus();
}

export function getHopperStatus(): HopperStatus {
  return hardwareStateProjection.getHopperStatus();
}

export function lockCoinSlot(ownerId: string, reason?: string): void {
  hardwareStateProjection.lockCoinSlot(ownerId, reason);
}

export function unlockOwnedCoinSlot(ownerId: string): boolean {
  return hardwareStateProjection.unlockOwnedCoinSlot(ownerId);
}

export function isCoinSlotLocked(): boolean {
  return hardwareStateProjection.isCoinSlotLocked();
}

export function isCoinSlotLockedBy(ownerId: string): boolean {
  return hardwareStateProjection.isCoinSlotLockedBy(ownerId);
}

export function getCoinSlotLockOwners(): string[] {
  return hardwareStateProjection.getCoinSlotLockOwners();
}

export function getCoinSlotLockOwnerId(): string | null {
  return hardwareStateProjection.getCoinSlotLockOwnerId();
}

export function getCoinSlotLockedAt(): string | null {
  return hardwareStateProjection.getCoinSlotLockedAt();
}

export function resetCoinSlotLocks(): void {
  hardwareStateProjection.resetCoinSlotLocks();
}

export async function initSerial(
  io?: Server | Socket | { emit: (event: string, ...args: unknown[]) => void } | null,
): Promise<void> {
  if (io) {
    hardwareStateProjection.setSocketIo(io);
  }
}

export function sendKioskIpAnnouncement(
  kioskIp?: string,
  port = 3000,
  portalPath = '/api/portal',
): Promise<boolean> {
  return hardwareStateProjection.sendKioskIpAnnouncement(
    kioskIp ?? '127.0.0.1',
    port,
    portalPath,
  );
}

export const serialService = {
  lockCoinSlot: (ownerId: string, reason?: string) =>
    hardwareStateProjection.lockCoinSlot(ownerId, reason),
  unlockOwnedCoinSlot: (ownerId: string) =>
    hardwareStateProjection.unlockOwnedCoinSlot(ownerId),
  isCoinSlotLocked: () => hardwareStateProjection.isCoinSlotLocked(),
  isCoinSlotLockedBy: (ownerId: string) =>
    hardwareStateProjection.isCoinSlotLockedBy(ownerId),
  getCoinSlotLockOwners: () => hardwareStateProjection.getCoinSlotLockOwners(),
  getCoinSlotLockOwnerId: () => hardwareStateProjection.getCoinSlotLockOwnerId(),
  getCoinSlotLockedAt: () => hardwareStateProjection.getCoinSlotLockedAt(),
  sendKioskIpAnnouncement: (
    kioskIp?: string,
    port = 3000,
    portalPath = '/api/portal',
  ) =>
    hardwareStateProjection.sendKioskIpAnnouncement(
      kioskIp ?? '127.0.0.1',
      port,
      portalPath,
    ),
  getSerialStatus: () => hardwareStateProjection.getSerialStatus(),
  getHopperStatus: () => hardwareStateProjection.getHopperStatus(),
};
