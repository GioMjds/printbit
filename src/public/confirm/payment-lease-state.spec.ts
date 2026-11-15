import {
  canStartArm,
  createPaymentLeaseState,
  getFinalLeaseId,
  reducePaymentLease,
  type PaymentLeaseState,
} from './payment-lease-state';

function armed(leaseId = 'L1'): PaymentLeaseState {
  let state = createPaymentLeaseState();
  state = reducePaymentLease(state, { type: 'arm-started' });
  return reducePaymentLease(state, {
    type: 'arm-succeeded',
    leaseId,
    stillEligible: true,
  });
}

describe('payment-lease-state', () => {
  it('starts idle with no ids', () => {
    const state = createPaymentLeaseState();
    expect(state).toEqual({
      phase: 'idle',
      leaseId: null,
      finalizationLeaseId: null,
    });
    expect(canStartArm(state)).toBe(true);
    expect(getFinalLeaseId(state)).toBeNull();
  });

  it('arm-started moves idle to arming and blocks a second arm', () => {
    const state = reducePaymentLease(createPaymentLeaseState(), {
      type: 'arm-started',
    });
    expect(state.phase).toBe('arming');
    expect(canStartArm(state)).toBe(false);
    expect(reducePaymentLease(state, { type: 'arm-started' })).toBe(state);
  });

  it('arm-succeeded while eligible arms and clears the finalization id', () => {
    let state: PaymentLeaseState = {
      phase: 'idle',
      leaseId: null,
      finalizationLeaseId: 'OLD',
    };
    state = reducePaymentLease(state, { type: 'arm-started' });
    state = reducePaymentLease(state, {
      type: 'arm-succeeded',
      leaseId: 'L1',
      stillEligible: true,
    });
    expect(state).toEqual({
      phase: 'armed',
      leaseId: 'L1',
      finalizationLeaseId: null,
    });
    expect(canStartArm(state)).toBe(false);
  });

  it('arm-succeeded while no longer eligible returns to idle without a lease', () => {
    let state = reducePaymentLease(createPaymentLeaseState(), {
      type: 'arm-started',
    });
    state = reducePaymentLease(state, {
      type: 'arm-succeeded',
      leaseId: 'L1',
      stillEligible: false,
    });
    expect(state.phase).toBe('idle');
    expect(state.leaseId).toBeNull();
  });

  it('a release during arming makes the arm result stale', () => {
    let state = reducePaymentLease(createPaymentLeaseState(), {
      type: 'arm-started',
    });
    state = reducePaymentLease(state, {
      type: 'released',
      reason: 'printer_failure',
    });
    expect(state.phase).toBe('arming-stale');
    expect(canStartArm(state)).toBe(false);

    state = reducePaymentLease(state, {
      type: 'arm-succeeded',
      leaseId: 'L1',
      stillEligible: true,
    });
    expect(state.phase).toBe('idle');
    expect(state.leaseId).toBeNull();
    expect(canStartArm(state)).toBe(true);
  });

  it('arm-failed returns to idle from arming and arming-stale', () => {
    const arming = reducePaymentLease(createPaymentLeaseState(), {
      type: 'arm-started',
    });
    expect(reducePaymentLease(arming, { type: 'arm-failed' }).phase).toBe(
      'idle',
    );
    const stale = reducePaymentLease(arming, {
      type: 'released',
      reason: 'cancel',
    });
    expect(reducePaymentLease(stale, { type: 'arm-failed' }).phase).toBe(
      'idle',
    );
  });

  it('arm-failed keeps the finalization id', () => {
    let state: PaymentLeaseState = {
      phase: 'idle',
      leaseId: null,
      finalizationLeaseId: 'F1',
    };
    state = reducePaymentLease(state, { type: 'arm-started' });
    state = reducePaymentLease(state, { type: 'arm-failed' });
    expect(state.finalizationLeaseId).toBe('F1');
  });

  it('heartbeat-failed for the held lease drops it', () => {
    const state = reducePaymentLease(armed('L1'), {
      type: 'heartbeat-failed',
      leaseId: 'L1',
    });
    expect(state.phase).toBe('idle');
    expect(state.leaseId).toBeNull();
  });

  it('heartbeat-failed for an old lease id is ignored', () => {
    const current = armed('L2');
    expect(
      reducePaymentLease(current, { type: 'heartbeat-failed', leaseId: 'L1' }),
    ).toBe(current);
  });

  it('release with target_reached keeps the lease id for finalization', () => {
    const state = reducePaymentLease(armed('L1'), {
      type: 'released',
      reason: 'target_reached',
    });
    expect(state).toEqual({
      phase: 'idle',
      leaseId: null,
      finalizationLeaseId: 'L1',
    });
    expect(getFinalLeaseId(state)).toBe('L1');
  });

  it('release with confirm_payment leaves the finalization id unchanged', () => {
    let state = reducePaymentLease(armed('L1'), {
      type: 'released',
      reason: 'target_reached',
    });
    state = reducePaymentLease(state, {
      type: 'released',
      reason: 'confirm_payment',
    });
    expect(state.finalizationLeaseId).toBe('L1');
  });

  it('getFinalLeaseId falls back to the held lease', () => {
    expect(getFinalLeaseId(armed('L9'))).toBe('L9');
  });

  // Known quirk 4: cancel (Back to Paper Check, tray issue) clears the id.
  it('release with any other reason clears the finalization id', () => {
    let state = reducePaymentLease(armed('L1'), {
      type: 'released',
      reason: 'target_reached',
    });
    state = reducePaymentLease(state, { type: 'released', reason: 'cancel' });
    expect(state.finalizationLeaseId).toBeNull();
  });

  // Known quirk 6: a second target_reached with no held lease clears the id.
  it('a repeated target_reached with no held lease clears the finalization id', () => {
    let state = reducePaymentLease(armed('L1'), {
      type: 'released',
      reason: 'target_reached',
    });
    state = reducePaymentLease(state, {
      type: 'released',
      reason: 'target_reached',
    });
    expect(state.finalizationLeaseId).toBeNull();
  });

  it('release while idle keeps the phase', () => {
    const state = reducePaymentLease(createPaymentLeaseState(), {
      type: 'released',
      reason: 'pagehide',
    });
    expect(state.phase).toBe('idle');
  });

  it('session-cleared clears only the finalization id', () => {
    const released = reducePaymentLease(armed('L1'), {
      type: 'released',
      reason: 'target_reached',
    });
    expect(reducePaymentLease(released, { type: 'session-cleared' })).toEqual({
      phase: 'idle',
      leaseId: null,
      finalizationLeaseId: null,
    });

    const held = armed('L2');
    expect(reducePaymentLease(held, { type: 'session-cleared' })).toEqual({
      phase: 'armed',
      leaseId: 'L2',
      finalizationLeaseId: null,
    });
  });
});
