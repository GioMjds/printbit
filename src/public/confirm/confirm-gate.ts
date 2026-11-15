import {
  getPricingMessage,
  getTotalPrice,
  isPricingReady,
  type PricingState,
} from './pricing-state';
import {
  hasBlockingPrinterError,
  type PrinterReadinessState,
} from './printer-readiness-state';

export type GateError = { severity: string; userMessage: string };

export interface GateInput<Q, E extends GateError> {
  pricing: PricingState<Q>;
  printer: PrinterReadinessState<E>;
  jobProcessing: boolean;
  balance: number;
}

export interface ConfirmGate {
  confirmEnabled: boolean;
  badge: 'waiting' | 'error' | 'ready';
  /** null = leave the status text as is. */
  message: string | null;
  /** null = leave the is-ready class as is. */
  highlightReady: boolean | null;
}

export function sanitizeStatusBadgeMessage(msg: string): string {
  if (!msg) return msg;
  if (
    msg.length > 50 ||
    msg.includes('|') ||
    msg.toLowerCase().includes('post-clear') ||
    msg.toLowerCase().includes('hardware error') ||
    msg.toLowerCase().includes('epson popup')
  ) {
    return 'Printer attention needed. See instructions.';
  }
  return msg;
}

export function canArmLease<Q, E extends GateError>(
  input: GateInput<Q, E> & {
    mode: 'print' | 'copy' | 'scan';
    jobActive: boolean;
  },
): boolean {
  const totalPrice = getTotalPrice(input.pricing);
  return (
    (input.mode === 'print' || input.mode === 'copy') &&
    isPricingReady(input.pricing) &&
    totalPrice > 0 &&
    input.printer.ready &&
    !hasBlockingPrinterError(input.printer) &&
    input.balance < totalPrice &&
    !input.jobProcessing &&
    !input.jobActive
  );
}

export function deriveConfirmGate<Q, E extends GateError>(
  input: GateInput<Q, E> & { statusOverride?: string },
): ConfirmGate {
  const { pricing, printer, statusOverride } = input;

  if (input.jobProcessing) {
    return {
      confirmEnabled: false,
      badge: 'waiting',
      message: null,
      highlightReady: null,
    };
  }

  if (printer.error && hasBlockingPrinterError(printer)) {
    return {
      confirmEnabled: false,
      badge: 'error',
      message: sanitizeStatusBadgeMessage(
        statusOverride ?? printer.error.userMessage,
      ),
      highlightReady: null,
    };
  }

  if (!isPricingReady(pricing)) {
    return {
      confirmEnabled: false,
      badge: 'waiting',
      message:
        statusOverride ?? getPricingMessage(pricing) ?? 'Loading pricing...',
      highlightReady: null,
    };
  }

  if (!printer.ready) {
    return {
      confirmEnabled: false,
      badge: printer.statusLabel.startsWith('Checking') ? 'waiting' : 'error',
      message:
        statusOverride ??
        `Printer not ready (${printer.statusLabel}). Please wait before inserting coins.`,
      highlightReady: null,
    };
  }

  const totalPrice = getTotalPrice(pricing);
  if (input.balance >= totalPrice) {
    return {
      confirmEnabled: true,
      badge: 'ready',
      message:
        statusOverride ?? 'Sufficient balance detected. You can confirm now.',
      highlightReady: true,
    };
  }

  const needed = totalPrice - input.balance;
  return {
    confirmEnabled: false,
    badge: statusOverride ? 'error' : 'waiting',
    message: sanitizeStatusBadgeMessage(
      statusOverride ?? `Insert more coins: ₱ ${needed} remaining.`,
    ),
    highlightReady: false,
  };
}
