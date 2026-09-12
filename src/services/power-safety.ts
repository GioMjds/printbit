import { EventEmitter } from 'node:events';
import {
  powerSafetyStore,
  type PowerSafetySqliteStore,
} from '@/core/database/power-safety-store';
import { serialService } from './hardware-state-projection';

// Development-only hardware bypass. This is deliberately opt-in so a missing
// worker power event still fails closed by default. It does not bypass printer
// preflight checks or make a print possible without a printer.
const POWER_SAFETY_BYPASS_ENABLED =
  process.env.PRINTBIT_POWER_SAFETY_BYPASS?.trim().toLowerCase() === 'true';

export type PowerState =
  | 'Operational'
  | 'PowerEmergency'
  | 'Recovering'
  | 'Unknown';

export interface PowerStatus {
  acLineStatus: 'Online' | 'Offline' | 'Unknown';
  isCharging?: boolean | null;
  batteryPercentage?: number | null;
  isBatteryLow?: boolean | null;
  isBatteryCritical?: boolean | null;
}

export type WorkerPowerEventType =
  | 'PowerStatusChanged'
  | 'PowerStatusSnapshot';

export interface WorkerPowerEvent {
  type: WorkerPowerEventType;
  powerStatus: PowerStatus;
  operationalState: PowerState;
  acceptingTransactions: boolean;
  powerSourceInstanceId: string;
  powerSequence: number;
  timestampUtc: string;
}

export interface PowerSafetyState {
  operationalState: PowerState;
  acceptingTransactions: boolean;
  canAcceptCustomerWork: boolean;
  powerStatus: PowerStatus | null;
  powerSourceInstanceId: string | null;
  powerSequence: number | null;
  sourceTimestampUtc: string | null;
  receivedTimestampUtc: string | null;
}

export interface PowerSafetyServiceOptions {
  store?: PowerSafetySqliteStore;
  serialService?: {
    lockCoinSlot: (ownerId: string) => void;
    unlockOwnedCoinSlot: (ownerId: string) => boolean;
    isCoinSlotLocked?: () => boolean;
  };
  onStateChange?: (state: PowerSafetyState) => void;
}

export class PowerSafetyService extends EventEmitter {
  private readonly store: PowerSafetySqliteStore;
  private readonly serial: {
    lockCoinSlot: (ownerId: string) => void;
    unlockOwnedCoinSlot: (ownerId: string) => boolean;
    isCoinSlotLocked?: () => boolean;
  };

  private state: PowerSafetyState;

  constructor(options: PowerSafetyServiceOptions = {}) {
    super();
    this.store = options.store ?? powerSafetyStore;
    this.serial = options.serialService ?? serialService;

    if (options.onStateChange) {
      this.on('powerStatusChanged', options.onStateChange);
    }

    // Initial in-memory state on startup is unavailable / fail-closed
    this.state = {
      operationalState: 'Unknown',
      acceptingTransactions: false,
      canAcceptCustomerWork: false,
      powerStatus: null,
      powerSourceInstanceId: null,
      powerSequence: null,
      sourceTimestampUtc: null,
      receivedTimestampUtc: null,
    };

    try {
      this.serial.lockCoinSlot('power-safety');
    } catch (serialErr) {
      console.error(
        '[POWER_SAFETY] Failed to lock coin slot on startup:',
        serialErr,
      );
    }
  }

  canAcceptCustomerWork(): boolean {
    return POWER_SAFETY_BYPASS_ENABLED || this.state.canAcceptCustomerWork;
  }

  getState(): PowerSafetyState {
    return { ...this.state };
  }

  getEffectiveState(): PowerSafetyState {
    return { ...this.state };
  }

  getEffectiveEvent(): WorkerPowerEvent {
    if (POWER_SAFETY_BYPASS_ENABLED && !this.state.canAcceptCustomerWork) {
      return {
        type: 'PowerStatusSnapshot',
        powerStatus: { acLineStatus: 'Online' },
        operationalState: 'Operational',
        acceptingTransactions: true,
        powerSourceInstanceId: 'development-bypass',
        powerSequence: 0,
        timestampUtc: new Date().toISOString(),
      };
    }

    return {
      type: 'PowerStatusSnapshot',
      powerStatus: this.state.powerStatus ?? { acLineStatus: 'Unknown' },
      operationalState: this.state.operationalState,
      acceptingTransactions: this.state.acceptingTransactions,
      powerSourceInstanceId: this.state.powerSourceInstanceId ?? '',
      powerSequence: this.state.powerSequence ?? 0,
      timestampUtc: this.state.sourceTimestampUtc ?? new Date().toISOString(),
    };
  }

  applyWorkerPowerEvent(event: WorkerPowerEvent): PowerSafetyState {
    const { powerSourceInstanceId, powerSequence } = event;

    // Enforce monotonic sequence numbers per powerSourceInstanceId
    if (
      this.state.powerSourceInstanceId !== null &&
      this.state.powerSourceInstanceId === powerSourceInstanceId
    ) {
      if (
        this.state.powerSequence !== null &&
        powerSequence <= this.state.powerSequence
      ) {
        console.warn(
          `[POWER_SAFETY] Ignored stale/duplicate power event (inst: ${powerSourceInstanceId}, seq: ${powerSequence} <= ${this.state.powerSequence})`,
        );
        return this.getState();
      }
    }

    const receivedTimestampUtc = new Date().toISOString();
    const isHealthyOperational =
      event.operationalState === 'Operational' &&
      event.acceptingTransactions === true &&
      event.powerStatus?.acLineStatus === 'Online';

    if (isHealthyOperational) {
      // Healthy Operational event: persists to DB first, then updates memory state to available
      try {
        this.store.savePowerSafetyState({
          powerSourceInstanceId: event.powerSourceInstanceId,
          powerSequence: event.powerSequence,
          statusJson: JSON.stringify(event.powerStatus),
          operationalState: event.operationalState,
          acceptingTransactions: true,
          sourceTimestampUtc: event.timestampUtc,
          receivedTimestampUtc,
        });
      } catch (err) {
        console.error(
          '[POWER_SAFETY] Failed to persist operational power safety state; remaining fail-closed:',
          err,
        );
        return this.getState();
      }

      // Successful persistence: now update in-memory state to available
      this.state = {
        operationalState: 'Operational',
        acceptingTransactions: true,
        canAcceptCustomerWork: true,
        powerStatus: event.powerStatus,
        powerSourceInstanceId: event.powerSourceInstanceId,
        powerSequence: event.powerSequence,
        sourceTimestampUtc: event.timestampUtc,
        receivedTimestampUtc,
      };

      try {
        this.serial.unlockOwnedCoinSlot('power-safety');
      } catch (serialErr) {
        console.error('[POWER_SAFETY] Failed to unlock coin slot:', serialErr);
      }

      const updated = this.getState();
      this.emit('powerStatusChanged', updated);
      return updated;
    } else {
      // Emergency / Unavailable event: sets memory state to unavailable immediately, persists to DB, locks coin slot
      this.state = {
        operationalState: event.operationalState,
        acceptingTransactions: false,
        canAcceptCustomerWork: false,
        powerStatus: event.powerStatus,
        powerSourceInstanceId: event.powerSourceInstanceId,
        powerSequence: event.powerSequence,
        sourceTimestampUtc: event.timestampUtc,
        receivedTimestampUtc,
      };

      try {
        this.serial.lockCoinSlot('power-safety');
      } catch (serialErr) {
        console.error('[POWER_SAFETY] Failed to lock coin slot:', serialErr);
      }

      try {
        this.store.savePowerSafetyState({
          powerSourceInstanceId: event.powerSourceInstanceId,
          powerSequence: event.powerSequence,
          statusJson: JSON.stringify(event.powerStatus),
          operationalState: event.operationalState,
          acceptingTransactions: false,
          sourceTimestampUtc: event.timestampUtc,
          receivedTimestampUtc,
        });
      } catch (err) {
        console.error(
          '[POWER_SAFETY] Failed to persist emergency power safety state:',
          err,
        );
      }

      const updated = this.getState();
      this.emit('powerStatusChanged', updated);
      return updated;
    }
  }
}

export const powerSafetyService = new PowerSafetyService();
