import { randomUUID } from 'node:crypto';

export const CONFIRM_CAPABILITY_COOKIE = 'printbit_confirm_capability';
export const CUSTOMER_PAYMENT_LOCK_OWNER = 'customer-payment';

export interface PaymentArmInput {
  capability: string;
  mode: 'print' | 'copy';
  amount: number;
  sessionId: string | null;
}

export interface PaymentLease {
  leaseId: string;
  capability: string;
  mode: 'print' | 'copy';
  amount: number;
  sessionId: string | null;
  expiresAt: number;
}

export interface PaymentAcceptorHardware {
  armCustomerPayment: () => Promise<boolean>;
  disarmCustomerPayment: (reason: string) => Promise<boolean>;
}

export interface PaymentAcceptorGateChecks {
  canAcceptCustomerWork: () => boolean;
  isPrinterReady: () => boolean;
  isSerialConnected: () => boolean;
  getBalance: () => number;
}

interface PaymentAcceptorGateDeps
  extends PaymentAcceptorHardware, PaymentAcceptorGateChecks {
  now?: () => number;
  leaseDurationMs?: number;
}

const CAPABILITY_DURATION_MS = 5 * 60 * 1_000;
const DEFAULT_LEASE_DURATION_MS = 15_000;

export class PaymentAcceptorGate {
  private readonly capabilities = new Map<string, number>();

  private readonly now: () => number;

  private readonly leaseDurationMs: number;

  private activeLease: PaymentLease | null = null;

  private expiryTimer: NodeJS.Timeout | null = null;

  private transition: Promise<void> = Promise.resolve();

  public constructor(private readonly deps: PaymentAcceptorGateDeps) {
    this.now = deps.now ?? Date.now;
    this.leaseDurationMs = deps.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  }

  public issueConfirmCapability(): string {
    this.purgeExpiredCapabilities();
    const capability = randomUUID();
    this.capabilities.set(capability, this.now() + CAPABILITY_DURATION_MS);
    return capability;
  }

  public arm(input: PaymentArmInput): Promise<PaymentLease | null> {
    return this.enqueue(() => this.armInternal(input));
  }

  public heartbeat(
    capability: string,
    leaseId: string,
  ): Promise<PaymentLease | null> {
    return this.enqueue(async () => {
      const lease = this.activeLease;
      if (!lease || lease.capability !== capability || lease.leaseId !== leaseId) {
        return null;
      }
      if (lease.expiresAt <= this.now() || !this.hasValidCapability(capability)) {
        await this.disarmForSafetyInternal('heartbeat_timeout');
        return null;
      }

      const expiresAt = this.now() + this.leaseDurationMs;
      this.activeLease = { ...lease, expiresAt };
      this.capabilities.set(capability, this.now() + CAPABILITY_DURATION_MS);
      this.scheduleExpiry(expiresAt);
      return this.activeLease;
    });
  }

  public disarm(leaseId: string | null | undefined, reason: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.activeLease) return true;
      if (this.activeLease.leaseId !== leaseId) return false;
      return this.disarmForSafetyInternal(reason);
    });
  }

  public disarmForSafety(reason: string): Promise<boolean> {
    return this.enqueue(() => this.disarmForSafetyInternal(reason));
  }

  public shutdown(): Promise<boolean> {
    return this.disarmForSafety('shutdown');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation, operation);
    this.transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async armInternal(input: PaymentArmInput): Promise<PaymentLease | null> {
    if (!this.hasValidCapability(input.capability)) return null;
    if (!Number.isFinite(input.amount) || input.amount <= 0) return null;
    if (!this.deps.canAcceptCustomerWork()) return null;
    if (!this.deps.isPrinterReady()) return null;
    if (!this.deps.isSerialConnected()) return null;

    const balance = this.deps.getBalance();
    if (!Number.isFinite(balance) || balance >= input.amount) return null;

    if (this.activeLease) {
      return this.activeLease.capability === input.capability
        ? this.activeLease
        : null;
    }

    let armed = false;
    try {
      armed = await this.deps.armCustomerPayment() === true;
    } catch {
      // The arm command may have reached hardware before its reply failed.
    }
    if (!armed) {
      try {
        await this.deps.disarmCustomerPayment('arm_failed');
      } catch {
        // Task 1's disarm path retains the customer lock before dispatching.
      }
      return null;
    }

    const lease: PaymentLease = {
      leaseId: randomUUID(),
      capability: input.capability,
      mode: input.mode,
      amount: input.amount,
      sessionId: input.sessionId,
      expiresAt: this.now() + this.leaseDurationMs,
    };
    this.activeLease = lease;
    this.scheduleExpiry(lease.expiresAt);
    return lease;
  }

  private hasValidCapability(capability: string): boolean {
    const expiresAt = this.capabilities.get(capability);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.capabilities.delete(capability);
      return false;
    }
    return true;
  }

  private purgeExpiredCapabilities(): void {
    const now = this.now();
    for (const [capability, expiresAt] of this.capabilities) {
      if (expiresAt <= now) this.capabilities.delete(capability);
    }
  }

  private scheduleExpiry(expiresAt: number): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => {
      void this.disarmForSafety('heartbeat_timeout');
    }, Math.max(0, expiresAt - this.now()));
  }

  private async disarmForSafetyInternal(reason: string): Promise<boolean> {
    const lease = this.activeLease;
    if (!lease) return true;

    this.activeLease = null;
    this.capabilities.delete(lease.capability);
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }

    try {
      return await this.deps.disarmCustomerPayment(reason);
    } catch {
      return false;
    }
  }
}
