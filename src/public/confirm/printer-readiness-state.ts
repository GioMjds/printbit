export interface PrinterReadinessState<E extends { severity: string }> {
  ready: boolean;
  statusLabel: string;
  error: E | null;
  interrupted: boolean;
}

export type PrinterReadinessEvent<E extends { severity: string }> =
  | { type: 'status-reported'; ready: boolean; label: string }
  | { type: 'status-request-failed' }
  | { type: 'recovered'; label: string }
  | { type: 'malfunction'; label: string }
  | { type: 'error-raised'; error: E }
  | { type: 'error-dismissed' }
  | { type: 'job-interrupted' }
  | { type: 'admin-cleared' }
  | { type: 'maintenance-acknowledged' };

export type PrinterKind =
  | 'interrupted'
  | 'blocked-error'
  | 'checking'
  | 'not-ready'
  | 'ready';

export function createPrinterReadinessState<
  E extends { severity: string },
>(): PrinterReadinessState<E> {
  return {
    ready: false,
    statusLabel: 'Checking...',
    error: null,
    interrupted: false,
  };
}

export function reducePrinterReadiness<E extends { severity: string }>(
  state: PrinterReadinessState<E>,
  event: PrinterReadinessEvent<E>,
): PrinterReadinessState<E> {
  switch (event.type) {
    case 'status-reported':
      return { ...state, ready: event.ready, statusLabel: event.label };
    case 'status-request-failed':
      return { ...state, ready: false };
    case 'recovered':
      if (state.error || state.interrupted) return state;
      return { ...state, ready: true, statusLabel: event.label };
    case 'malfunction':
      return { ...state, ready: false, statusLabel: event.label };
    case 'error-raised':
      return { ...state, error: event.error };
    case 'error-dismissed':
      return { ...state, error: null };
    case 'job-interrupted':
      return { ...state, interrupted: true };
    case 'admin-cleared':
      return {
        ready: true,
        statusLabel: 'Ready',
        error: null,
        interrupted: false,
      };
    case 'maintenance-acknowledged':
      return { ...state, interrupted: false };
  }
}

export function hasBlockingPrinterError<E extends { severity: string }>(
  state: PrinterReadinessState<E>,
): boolean {
  return (
    state.error?.severity === 'fatal' || state.error?.severity === 'recoverable'
  );
}

export function getPrinterKind<E extends { severity: string }>(
  state: PrinterReadinessState<E>,
): PrinterKind {
  if (state.interrupted) return 'interrupted';
  if (hasBlockingPrinterError(state)) return 'blocked-error';
  if (!state.ready) {
    return state.statusLabel.startsWith('Checking') ? 'checking' : 'not-ready';
  }
  return 'ready';
}
