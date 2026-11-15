export type LeasePhase = 'idle' | 'arming' | 'arming-stale' | 'armed';

export interface PaymentLeaseState {
  phase: LeasePhase;
  /** Non-null only when phase is 'armed'. */
  leaseId: string | null;
  finalizationLeaseId: string | null;
}

export type PaymentLeaseEvent =
  | { type: 'arm-started' }
  | { type: 'arm-succeeded'; leaseId: string; stillEligible: boolean }
  | { type: 'arm-failed' }
  | { type: 'heartbeat-failed'; leaseId: string }
  | { type: 'released'; reason: string }
  | { type: 'session-cleared' };

export function createPaymentLeaseState(): PaymentLeaseState {
  return { phase: 'idle', leaseId: null, finalizationLeaseId: null };
}

function finalizationAfterRelease(
  state: PaymentLeaseState,
  reason: string,
): string | null {
  if (reason === 'target_reached' && state.leaseId) return state.leaseId;
  if (reason !== 'confirm_payment') return null;
  return state.finalizationLeaseId;
}

export function reducePaymentLease(
  state: PaymentLeaseState,
  event: PaymentLeaseEvent,
): PaymentLeaseState {
  switch (event.type) {
    case 'arm-started':
      if (state.phase !== 'idle') return state;
      return { ...state, phase: 'arming' };

    case 'arm-succeeded':
      if (state.phase === 'arming' && event.stillEligible) {
        return {
          phase: 'armed',
          leaseId: event.leaseId,
          finalizationLeaseId: null,
        };
      }
      if (state.phase === 'arming' || state.phase === 'arming-stale') {
        return { ...state, phase: 'idle', leaseId: null };
      }
      return state;

    case 'arm-failed':
      return { ...state, phase: 'idle', leaseId: null };

    case 'heartbeat-failed':
      if (state.phase !== 'armed' || state.leaseId !== event.leaseId) {
        return state;
      }
      return { ...state, phase: 'idle', leaseId: null };

    case 'released': {
      const finalizationLeaseId = finalizationAfterRelease(state, event.reason);
      const phase: LeasePhase =
        state.phase === 'arming' || state.phase === 'arming-stale'
          ? 'arming-stale'
          : 'idle';
      return { phase, leaseId: null, finalizationLeaseId };
    }

    case 'session-cleared':
      return { ...state, finalizationLeaseId: null };
  }
}

export function canStartArm(state: PaymentLeaseState): boolean {
  return state.phase === 'idle';
}

export function getFinalLeaseId(state: PaymentLeaseState): string | null {
  return state.finalizationLeaseId ?? state.leaseId;
}
