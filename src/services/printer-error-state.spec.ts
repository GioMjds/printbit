import { PrinterErrorStateManager } from './printer-error-state';

describe('PrinterErrorStateManager', () => {
  let manager: PrinterErrorStateManager;

  beforeEach(() => {
    manager = new PrinterErrorStateManager({
      debouncePollCount: 2,
      repeatWindowMs: 300_000, // 5 minutes
      maxRepeatsBeforeLockout: 2,
    });
  });

  it('records a new error and sets active status', () => {
    const state = manager.recordError('E_COVER_OPEN');
    expect(state.status).toBe('active');
    expect(state.occurrences).toBe(1);
    expect(state.locksCoinSlot).toBe(true);
  });

  it('auto-clears customer tier after consecutive healthy polls', () => {
    manager.recordError('E_COVER_OPEN');

    const poll1 = manager.recordHealthyPoll();
    expect(poll1.cleared).toBe(false);

    const poll2 = manager.recordHealthyPoll();
    expect(poll2.cleared).toBe(true);
    expect(manager.getActiveError()).toBeNull();
  });

  it('does NOT auto-clear staff tier errors on healthy poll', () => {
    manager.recordError('E_PAPER_SETUP');

    manager.recordHealthyPoll();
    manager.recordHealthyPoll();
    manager.recordHealthyPoll();

    expect(manager.getActiveError()?.status).toBe('active');
    expect(manager.getActiveError()?.code).toBe('E_PAPER_SETUP');

    manager.clearStaffResolution('staff_user');
    expect(manager.getActiveError()).toBeNull();
  });

  it('retains jobRequiresStaff if error occurred during job', () => {
    manager.recordError('E_COVER_OPEN', 'PB-1234');
    expect(manager.getActiveError()?.jobRequiresStaff).toBe(true);

    manager.recordHealthyPoll();
    const poll2 = manager.recordHealthyPoll();
    expect(poll2.cleared).toBe(true);
    expect(poll2.state?.jobRequiresStaff).toBe(true);
  });

  it('transitions kiosk to out_of_service after 2 repeats within 5 minutes', () => {
    manager.recordError('E_COVER_OPEN');
    manager.recordHealthyPoll();
    manager.recordHealthyPoll(); // cleared 1st time

    manager.recordError('E_COVER_OPEN');
    manager.recordHealthyPoll();
    manager.recordHealthyPoll(); // cleared 2nd time

    const state3 = manager.recordError('E_COVER_OPEN');
    expect(state3.status).toBe('out_of_service');
    expect(manager.isKioskOutOfService()).toBe(true);
  });

  it('handles healthy poll when no error is active', () => {
    const poll = manager.recordHealthyPoll();
    expect(poll.cleared).toBe(false);
    expect(poll.state).toBeNull();
  });

  it('does not auto-clear when out of service', () => {
    manager.recordError('E_COVER_OPEN');
    manager.recordHealthyPoll();
    manager.recordHealthyPoll();
    manager.recordError('E_COVER_OPEN');
    manager.recordHealthyPoll();
    manager.recordHealthyPoll();
    manager.recordError('E_COVER_OPEN'); // out of service

    const poll = manager.recordHealthyPoll();
    expect(poll.cleared).toBe(false);
    expect(poll.state?.status).toBe('out_of_service');
  });

  it('clears out of service status via staff resolution', () => {
    manager.recordError('E_COVER_OPEN');
    manager.recordHealthyPoll();
    manager.recordHealthyPoll();
    manager.recordError('E_COVER_OPEN');
    manager.recordHealthyPoll();
    manager.recordHealthyPoll();
    manager.recordError('E_COVER_OPEN'); // out of service
    expect(manager.isKioskOutOfService()).toBe(true);

    manager.clearStaffResolution('tech_admin');
    expect(manager.isKioskOutOfService()).toBe(false);
    expect(manager.getActiveError()).toBeNull();
  });

  it('does not increase repeat occurrences or lockout on continuous polls of same active error', () => {
    for (let i = 0; i < 10; i++) {
      const state = manager.recordError('E_COVER_OPEN');
      expect(state.occurrences).toBe(1);
      expect(state.status).toBe('active');
    }
    expect(manager.isKioskOutOfService()).toBe(false);
  });

  it('expires faults older than repeatWindowMs so they do not cause lockout', () => {
    jest.useFakeTimers();
    try {
      manager.recordError('E_COVER_OPEN');
      manager.recordHealthyPoll();
      manager.recordHealthyPoll(); // cleared

      jest.advanceTimersByTime(10_000);
      manager.recordError('E_COVER_OPEN');
      manager.recordHealthyPoll();
      manager.recordHealthyPoll(); // cleared

      // Advance past 5-minute repeat window for all prior errors
      jest.advanceTimersByTime(350_000);

      // 3rd error: older occurrences have expired
      const state = manager.recordError('E_COVER_OPEN');
      expect(state.occurrences).toBe(1);
      expect(state.status).toBe('active');
      expect(manager.isKioskOutOfService()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves out_of_service lockout if another error code arrives', () => {
    manager.recordError('E_COVER_OPEN');
    manager.recordHealthyPoll();
    manager.recordHealthyPoll();
    manager.recordError('E_COVER_OPEN');
    manager.recordHealthyPoll();
    manager.recordHealthyPoll();
    manager.recordError('E_COVER_OPEN');
    expect(manager.isKioskOutOfService()).toBe(true);

    const newState = manager.recordError('E_NO_PAPER');
    expect(newState.status).toBe('out_of_service');
    expect(manager.isKioskOutOfService()).toBe(true);
  });

  it('resets firstSeenAt when error code changes', () => {
    jest.useFakeTimers();
    try {
      const err1 = manager.recordError('E_COVER_OPEN');
      const firstSeen1 = err1.firstSeenAt;

      jest.advanceTimersByTime(5_000);
      const sameErr = manager.recordError('E_COVER_OPEN');
      expect(sameErr.firstSeenAt).toBe(firstSeen1);

      jest.advanceTimersByTime(5_000);
      const diffErr = manager.recordError('E_NO_PAPER');
      expect(diffErr.firstSeenAt).not.toBe(firstSeen1);
      expect(diffErr.firstSeenAt).toBe(new Date(Date.now()).toISOString());
    } finally {
      jest.useRealTimers();
    }
  });
});
