import {
  canArmLease,
  deriveConfirmGate,
  sanitizeStatusBadgeMessage,
  type ConfirmGate,
} from './confirm-gate';
import { createPricingState, reducePricing } from './pricing-state';
import {
  createPrinterReadinessState,
  type PrinterReadinessState,
} from './printer-readiness-state';

type Err = {
  severity: 'warning' | 'recoverable' | 'fatal';
  userMessage: string;
};
type Mode = 'print' | 'copy' | 'scan';

interface Flags {
  mode: Mode;
  pricingLoaded: boolean;
  pricingError: string | null;
  totalPrice: number;
  printerReady: boolean;
  label: string;
  error: Err | null;
  balance: number;
  processing: boolean;
  active: boolean;
  override: string | undefined;
}

function legacySanitize(msg: string): string {
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

function legacyCanArm(f: Flags): boolean {
  const hasBlocking =
    f.error?.severity === 'fatal' || f.error?.severity === 'recoverable';
  return (
    (f.mode === 'print' || f.mode === 'copy') &&
    f.pricingLoaded &&
    f.totalPrice > 0 &&
    f.printerReady &&
    !hasBlocking &&
    f.balance < f.totalPrice &&
    !f.processing &&
    !f.active
  );
}

function legacyGate(f: Flags): ConfirmGate {
  if (f.processing) {
    return {
      confirmEnabled: false,
      badge: 'waiting',
      message: null,
      highlightReady: null,
    };
  }
  if (
    f.error &&
    (f.error.severity === 'fatal' || f.error.severity === 'recoverable')
  ) {
    return {
      confirmEnabled: false,
      badge: 'error',
      message: legacySanitize(f.override ?? f.error.userMessage),
      highlightReady: null,
    };
  }
  if (!f.pricingLoaded) {
    return {
      confirmEnabled: false,
      badge: 'waiting',
      message: f.override ?? f.pricingError ?? 'Loading pricing...',
      highlightReady: null,
    };
  }
  if (!f.printerReady) {
    return {
      confirmEnabled: false,
      badge: f.label.startsWith('Checking') ? 'waiting' : 'error',
      message:
        f.override ??
        `Printer not ready (${f.label}). Please wait before inserting coins.`,
      highlightReady: null,
    };
  }
  if (f.balance >= f.totalPrice) {
    return {
      confirmEnabled: true,
      badge: 'ready',
      message:
        f.override ?? 'Sufficient balance detected. You can confirm now.',
      highlightReady: true,
    };
  }
  const needed = f.totalPrice - f.balance;
  return {
    confirmEnabled: false,
    badge: f.override ? 'error' : 'waiting',
    message: legacySanitize(
      f.override ?? `Insert more coins: ₱ ${needed} remaining.`,
    ),
    highlightReady: false,
  };
}

function toInput(f: Flags) {
  let pricing = createPricingState<null>();
  if (f.pricingLoaded) {
    pricing = reducePricing(pricing, {
      type: 'quote-loaded',
      totalPrice: f.totalPrice,
      quote: null,
    });
  } else if (f.pricingError !== null) {
    pricing = reducePricing(pricing, {
      type: 'quote-failed',
      message: f.pricingError,
    });
  }
  const printer: PrinterReadinessState<Err> = {
    ...createPrinterReadinessState<Err>(),
    ready: f.printerReady,
    statusLabel: f.label,
    error: f.error,
  };
  return { pricing, printer, jobProcessing: f.processing, balance: f.balance };
}

const errors: (Err | null)[] = [
  null,
  { severity: 'warning', userMessage: 'Low ink' },
  { severity: 'recoverable', userMessage: 'Cover open' },
  { severity: 'fatal', userMessage: 'Hardware error | post-clear guard' },
];
const pricings: Pick<Flags, 'pricingLoaded' | 'pricingError' | 'totalPrice'>[] =
  [
    { pricingLoaded: false, pricingError: null, totalPrice: 0 },
    { pricingLoaded: false, pricingError: 'Quote failed', totalPrice: 0 },
    { pricingLoaded: true, pricingError: null, totalPrice: 10 },
    { pricingLoaded: true, pricingError: null, totalPrice: 0 },
  ];

function* allFlags(): Generator<Flags> {
  for (const mode of ['print', 'copy', 'scan'] as Mode[])
    for (const p of pricings)
      for (const printerReady of [true, false])
        for (const label of ['Checking...', 'Checking…', 'Offline', 'Ready'])
          for (const error of errors)
            for (const balance of [0, 5, 10, 15])
              for (const processing of [true, false])
                for (const active of [true, false])
                  for (const override of [undefined, '', 'Boom'])
                    yield {
                      mode,
                      ...p,
                      printerReady,
                      label,
                      error,
                      balance,
                      processing,
                      active,
                      override,
                    };
}

describe('confirm-gate', () => {
  it('canArmLease matches the legacy expression for every combination', () => {
    let count = 0;
    for (const f of allFlags()) {
      const actual = canArmLease({
        ...toInput(f),
        mode: f.mode,
        jobActive: f.active,
      });
      if (actual !== legacyCanArm(f)) {
        throw new Error(`canArmLease mismatch for ${JSON.stringify(f)}`);
      }
      count += 1;
    }
    expect(count).toBeGreaterThan(10_000);
  });

  it('deriveConfirmGate matches the legacy branches for every combination', () => {
    for (const f of allFlags()) {
      const actual = deriveConfirmGate({
        ...toInput(f),
        statusOverride: f.override,
      });
      expect({ flags: f, gate: actual }).toEqual({
        flags: f,
        gate: legacyGate(f),
      });
    }
  });

  it('uses an empty-string override as the message but not as an error badge', () => {
    const gate = deriveConfirmGate({
      ...toInput({
        mode: 'print',
        pricingLoaded: true,
        pricingError: null,
        totalPrice: 10,
        printerReady: true,
        label: 'Ready',
        error: null,
        balance: 0,
        processing: false,
        active: false,
        override: '',
      }),
      statusOverride: '',
    });
    expect(gate.message).toBe('');
    expect(gate.badge).toBe('waiting');
  });

  it('sanitizes long or technical messages', () => {
    expect(sanitizeStatusBadgeMessage('short')).toBe('short');
    expect(sanitizeStatusBadgeMessage('a|b')).toBe(
      'Printer attention needed. See instructions.',
    );
    expect(sanitizeStatusBadgeMessage('x'.repeat(51))).toBe(
      'Printer attention needed. See instructions.',
    );
    expect(sanitizeStatusBadgeMessage('')).toBe('');
  });
});
