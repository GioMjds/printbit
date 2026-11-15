import {
  createJobState,
  getJobPhase,
  hasActiveJob,
  reduceJob,
  type JobState,
} from './job-state';

type Owed = { amountOwed: number };

function start(): JobState<Owed> {
  return createJobState<Owed>();
}

describe('job-state', () => {
  it('starts idle', () => {
    const state = start();
    expect(state.processing).toBe(false);
    expect(state.activeSpoolerKey).toBeNull();
    expect(state.transactionId).toBeNull();
    expect(state.owedChange).toBeNull();
    expect(state.outcome.outcome).toBe('pending');
    expect(getJobPhase(state)).toBe('idle');
    expect(hasActiveJob(state, null)).toBe(false);
  });

  it('submit-started enters submitting; processing-stopped returns to idle', () => {
    const submitting = reduceJob(start(), { type: 'submit-started' });
    expect(getJobPhase(submitting)).toBe('submitting');
    expect(hasActiveJob(submitting, null)).toBe(true);
    const stopped = reduceJob(submitting, { type: 'processing-stopped' });
    expect(getJobPhase(stopped)).toBe('idle');
  });

  // Known quirk 1: a persisted spooler key keeps the job "active" after a
  // failed submit, so the coin lease never re-arms.
  it('a persisted spooler key alone counts as an active job', () => {
    expect(hasActiveJob(start(), 'KEY')).toBe(true);
  });

  // Known quirk 2: after a hardware failure processing is false but the
  // spooler key is kept, so the job still counts as active.
  it('an activated spooler key keeps the job active after processing stops', () => {
    let state = reduceJob(start(), { type: 'submit-started' });
    state = reduceJob(state, { type: 'spooler-activated', key: 'KEY' });
    state = reduceJob(state, { type: 'processing-stopped' });
    expect(state.processing).toBe(false);
    expect(hasActiveJob(state, null)).toBe(true);
    expect(getJobPhase(state)).toBe('awaiting-worker');
  });

  it('spooler-cleared releases the active key', () => {
    let state = reduceJob(start(), { type: 'spooler-activated', key: 'KEY' });
    state = reduceJob(state, { type: 'spooler-cleared' });
    expect(state.activeSpoolerKey).toBeNull();
  });

  it('transaction-referenced trims, and maps empty or null to null', () => {
    expect(
      reduceJob(start(), { type: 'transaction-referenced', id: '  TX1 ' })
        .transactionId,
    ).toBe('TX1');
    expect(
      reduceJob(start(), { type: 'transaction-referenced', id: '   ' })
        .transactionId,
    ).toBeNull();
    expect(
      reduceJob(start(), { type: 'transaction-referenced', id: null })
        .transactionId,
    ).toBeNull();
  });

  it('records and clears owed change', () => {
    const owed = reduceJob(start(), {
      type: 'owed-change-recorded',
      notice: { amountOwed: 3 },
    });
    expect(owed.owedChange).toEqual({ amountOwed: 3 });
    expect(
      reduceJob(owed, { type: 'owed-change-cleared' }).owedChange,
    ).toBeNull();
  });

  it('terminal success for the pending identity yields succeeded', () => {
    let state = reduceJob(start(), {
      type: 'outcome-evidence',
      evidence: {
        type: 'restore-pending',
        identity: { transactionId: 'TX1', spoolerCorrelationKey: 'K1' },
      },
    });
    state = reduceJob(state, {
      type: 'outcome-evidence',
      evidence: {
        type: 'terminal-success',
        identity: { transactionId: 'TX1' },
      },
    });
    expect(state.outcome.outcome).toBe('success');
    expect(getJobPhase(state)).toBe('succeeded');
  });

  it('a success after a terminal failure does not flip the outcome', () => {
    let state = reduceJob(start(), {
      type: 'outcome-evidence',
      evidence: {
        type: 'restore-pending',
        identity: { transactionId: 'TX1', spoolerCorrelationKey: 'K1' },
      },
    });
    state = reduceJob(state, {
      type: 'outcome-evidence',
      evidence: {
        type: 'terminal-failure',
        identity: { transactionId: 'TX1' },
      },
    });
    state = reduceJob(state, {
      type: 'outcome-evidence',
      evidence: {
        type: 'terminal-success',
        identity: { transactionId: 'TX1' },
      },
    });
    expect(state.outcome.outcome).toBe('maintenance');
    expect(getJobPhase(state)).toBe('interrupted');
  });

  it('stores a receipt for the matching identity', () => {
    let state = reduceJob(start(), {
      type: 'outcome-evidence',
      evidence: { type: 'restore-pending', identity: { transactionId: 'TX1' } },
    });
    state = reduceJob(state, {
      type: 'outcome-evidence',
      evidence: {
        type: 'receipt-available',
        identity: { transactionId: 'TX1' },
        receipt: { url: '/r/1', expiresAt: null },
      },
    });
    expect(state.outcome.receipt).toEqual({ url: '/r/1', expiresAt: null });
  });

  it('session-cleared resets outcome, transaction and owed change only', () => {
    let state = reduceJob(start(), { type: 'submit-started' });
    state = reduceJob(state, { type: 'spooler-activated', key: 'K1' });
    state = reduceJob(state, { type: 'transaction-referenced', id: 'TX1' });
    state = reduceJob(state, {
      type: 'owed-change-recorded',
      notice: { amountOwed: 2 },
    });
    state = reduceJob(state, {
      type: 'outcome-evidence',
      evidence: {
        type: 'terminal-failure',
        identity: { transactionId: 'TX1' },
      },
    });
    state = reduceJob(state, { type: 'session-cleared' });
    expect(state.outcome.outcome).toBe('pending');
    expect(state.transactionId).toBeNull();
    expect(state.owedChange).toBeNull();
    expect(state.processing).toBe(true);
    expect(state.activeSpoolerKey).toBe('K1');
  });
});
