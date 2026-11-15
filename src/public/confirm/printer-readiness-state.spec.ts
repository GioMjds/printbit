import {
  createPrinterReadinessState,
  getPrinterKind,
  hasBlockingPrinterError,
  reducePrinterReadiness,
  type PrinterReadinessState,
} from './printer-readiness-state';

type Err = { severity: 'warning' | 'recoverable' | 'fatal'; code: string };

const fatal: Err = { severity: 'fatal', code: 'JAM' };
const recoverable: Err = { severity: 'recoverable', code: 'X' };
const warning: Err = { severity: 'warning', code: 'LOW_INK' };

function start(): PrinterReadinessState<Err> {
  return createPrinterReadinessState<Err>();
}

describe('printer-readiness-state', () => {
  it('starts not ready, checking, with no error', () => {
    expect(start()).toEqual({
      ready: false,
      statusLabel: 'Checking...',
      error: null,
      interrupted: false,
    });
    expect(getPrinterKind(start())).toBe('checking');
  });

  it('status-reported sets ready and label', () => {
    const state = reducePrinterReadiness(start(), {
      type: 'status-reported',
      ready: true,
      label: 'Ready',
    });
    expect(state.ready).toBe(true);
    expect(state.statusLabel).toBe('Ready');
    expect(getPrinterKind(state)).toBe('ready');
  });

  it('status-request-failed clears ready and keeps the label', () => {
    const ready = reducePrinterReadiness(start(), {
      type: 'status-reported',
      ready: true,
      label: 'Ready',
    });
    const failed = reducePrinterReadiness(ready, {
      type: 'status-request-failed',
    });
    expect(failed.ready).toBe(false);
    expect(failed.statusLabel).toBe('Ready');
    expect(getPrinterKind(failed)).toBe('not-ready');
  });

  it('malfunction clears ready and sets the label', () => {
    const state = reducePrinterReadiness(start(), {
      type: 'malfunction',
      label: 'Error',
    });
    expect(state).toMatchObject({ ready: false, statusLabel: 'Error' });
  });

  it('treats both ellipsis spellings as checking', () => {
    const ascii = reducePrinterReadiness(start(), {
      type: 'status-reported',
      ready: false,
      label: 'Checking...',
    });
    const unicode = reducePrinterReadiness(start(), {
      type: 'status-reported',
      ready: false,
      label: 'Checking…',
    });
    expect(getPrinterKind(ascii)).toBe('checking');
    expect(getPrinterKind(unicode)).toBe('checking');
  });

  it('fatal and recoverable errors block; warnings do not', () => {
    const base = reducePrinterReadiness(start(), {
      type: 'status-reported',
      ready: true,
      label: 'Ready',
    });
    for (const error of [fatal, recoverable]) {
      const state = reducePrinterReadiness(base, {
        type: 'error-raised',
        error,
      });
      expect(hasBlockingPrinterError(state)).toBe(true);
      expect(getPrinterKind(state)).toBe('blocked-error');
    }
    const warned = reducePrinterReadiness(base, {
      type: 'error-raised',
      error: warning,
    });
    expect(hasBlockingPrinterError(warned)).toBe(false);
    expect(getPrinterKind(warned)).toBe('ready');
  });

  it('error-raised does not touch ready (ready and blocked can coexist)', () => {
    const base = reducePrinterReadiness(start(), {
      type: 'status-reported',
      ready: true,
      label: 'Ready',
    });
    const state = reducePrinterReadiness(base, {
      type: 'error-raised',
      error: fatal,
    });
    expect(state.ready).toBe(true);
  });

  it('error-dismissed clears only the error', () => {
    const errored = reducePrinterReadiness(start(), {
      type: 'error-raised',
      error: fatal,
    });
    const cleared = reducePrinterReadiness(errored, {
      type: 'error-dismissed',
    });
    expect(cleared.error).toBeNull();
    expect(cleared.ready).toBe(false);
  });

  // Known quirk 5: recovery is ignored while ANY error is shown, warnings included.
  it('recovered is ignored while any error is present', () => {
    for (const error of [fatal, recoverable, warning]) {
      const errored = reducePrinterReadiness(start(), {
        type: 'error-raised',
        error,
      });
      const next = reducePrinterReadiness(errored, {
        type: 'recovered',
        label: 'Idle',
      });
      expect(next).toBe(errored);
    }
  });

  it('recovered is ignored while interrupted', () => {
    const interrupted = reducePrinterReadiness(start(), {
      type: 'job-interrupted',
    });
    const next = reducePrinterReadiness(interrupted, {
      type: 'recovered',
      label: 'Ready',
    });
    expect(next).toBe(interrupted);
  });

  it('recovered sets ready and label when clean', () => {
    const next = reducePrinterReadiness(start(), {
      type: 'recovered',
      label: 'Idle',
    });
    expect(next).toMatchObject({ ready: true, statusLabel: 'Idle' });
  });

  it('interrupted outranks every other kind', () => {
    let state = reducePrinterReadiness(start(), {
      type: 'status-reported',
      ready: true,
      label: 'Ready',
    });
    state = reducePrinterReadiness(state, {
      type: 'error-raised',
      error: fatal,
    });
    state = reducePrinterReadiness(state, { type: 'job-interrupted' });
    expect(getPrinterKind(state)).toBe('interrupted');
  });

  it('admin-cleared resets everything to ready', () => {
    let state = reducePrinterReadiness(start(), {
      type: 'error-raised',
      error: fatal,
    });
    state = reducePrinterReadiness(state, { type: 'job-interrupted' });
    state = reducePrinterReadiness(state, { type: 'admin-cleared' });
    expect(state).toEqual({
      ready: true,
      statusLabel: 'Ready',
      error: null,
      interrupted: false,
    });
  });

  it('maintenance-acknowledged clears only interrupted', () => {
    let state = reducePrinterReadiness(start(), {
      type: 'error-raised',
      error: fatal,
    });
    state = reducePrinterReadiness(state, { type: 'job-interrupted' });
    state = reducePrinterReadiness(state, { type: 'maintenance-acknowledged' });
    expect(state.interrupted).toBe(false);
    expect(state.error).toBe(fatal);
  });
});
