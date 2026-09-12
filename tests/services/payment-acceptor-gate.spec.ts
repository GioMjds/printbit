import {
  PaymentAcceptorGate,
  type PaymentLease,
} from '../../src/services/payment-acceptor-gate';

describe('PaymentAcceptorGate', () => {
  let currentTime: number;
  let powerAvailable: boolean;
  let printerReady: boolean;
  let serialConnected: boolean;
  let balance: number;
  let armCustomerPayment: jest.Mock<Promise<boolean>, []>;
  let disarmCustomerPayment: jest.Mock<Promise<boolean>, [string]>;

  const createGate = () => new PaymentAcceptorGate({
    armCustomerPayment,
    disarmCustomerPayment,
    canAcceptCustomerWork: () => powerAvailable,
    isPrinterReady: () => printerReady,
    isSerialConnected: () => serialConnected,
    getBalance: () => balance,
    now: () => currentTime,
    leaseDurationMs: 15_000,
  });

  const arm = (gate: PaymentAcceptorGate, capability: string, amount = 10) =>
    gate.arm({
      capability,
      mode: 'print',
      amount,
      sessionId: 'print-session',
    });

  beforeEach(() => {
    jest.useFakeTimers();
    currentTime = 0;
    powerAvailable = true;
    printerReady = true;
    serialConnected = true;
    balance = 0;
    armCustomerPayment = jest.fn().mockResolvedValue(true);
    disarmCustomerPayment = jest.fn().mockResolvedValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects arm without a capability', async () => {
    const gate = createGate();

    await expect(arm(gate, 'missing-capability')).resolves.toBeNull();
    expect(armCustomerPayment).not.toHaveBeenCalled();
    expect(disarmCustomerPayment).not.toHaveBeenCalled();
  });

  it('rejects arm while power, printer, serial, or balance checks fail', async () => {
    const cases = [
      () => { powerAvailable = false; },
      () => { printerReady = false; },
      () => { serialConnected = false; },
      () => { balance = 10; },
    ];

    for (const makeUnavailable of cases) {
      const gate = createGate();
      const capability = gate.issueConfirmCapability();
      makeUnavailable();

      await expect(arm(gate, capability)).resolves.toBeNull();
      expect(armCustomerPayment).not.toHaveBeenCalled();
      expect(disarmCustomerPayment).not.toHaveBeenCalled();

      powerAvailable = true;
      printerReady = true;
      serialConnected = true;
      balance = 0;
    }
  });

  it('rejects zero and non-finite amounts', async () => {
    const gate = createGate();

    for (const amount of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(arm(gate, gate.issueConfirmCapability(), amount)).resolves.toBeNull();
    }

    expect(armCustomerPayment).not.toHaveBeenCalled();
    expect(disarmCustomerPayment).not.toHaveBeenCalled();
  });

  it('expires confirmation capabilities after five minutes', async () => {
    const gate = createGate();
    const capability = gate.issueConfirmCapability();
    currentTime = 5 * 60 * 1_000;

    await expect(arm(gate, capability)).resolves.toBeNull();
    expect(armCustomerPayment).not.toHaveBeenCalled();
  });

  it('arms exactly once for a valid capability and returns a lease id', async () => {
    const gate = createGate();
    const capability = gate.issueConfirmCapability();

    const lease = await arm(gate, capability);

    expect(lease).toEqual<PaymentLease>({
      leaseId: expect.any(String),
      capability,
      mode: 'print',
      amount: 10,
      sessionId: 'print-session',
      expiresAt: 15_000,
    });
    expect(armCustomerPayment).toHaveBeenCalledTimes(1);
    expect(disarmCustomerPayment).not.toHaveBeenCalled();
  });

  it('returns the same lease for an idempotent repeated arm', async () => {
    const gate = createGate();
    const capability = gate.issueConfirmCapability();

    const firstLease = await arm(gate, capability);
    const repeatedLease = await arm(gate, capability);

    expect(repeatedLease).toEqual(firstLease);
    expect(armCustomerPayment).toHaveBeenCalledTimes(1);
    expect(disarmCustomerPayment).not.toHaveBeenCalled();
  });

  it('compensates with a disarm when hardware arm is not acknowledged', async () => {
    armCustomerPayment.mockResolvedValue(false);
    const gate = createGate();
    const capability = gate.issueConfirmCapability();

    await expect(arm(gate, capability)).resolves.toBeNull();

    expect(armCustomerPayment).toHaveBeenCalledTimes(1);
    expect(disarmCustomerPayment).toHaveBeenCalledWith('arm_failed');
  });

  it('compensates with a disarm when hardware arm rejects', async () => {
    armCustomerPayment.mockRejectedValue(new Error('worker timeout'));
    const gate = createGate();
    const capability = gate.issueConfirmCapability();

    await expect(arm(gate, capability)).resolves.toBeNull();

    expect(armCustomerPayment).toHaveBeenCalledTimes(1);
    expect(disarmCustomerPayment).toHaveBeenCalledWith('arm_failed');
  });

  it('rejects a second active lease from a different capability', async () => {
    const gate = createGate();
    const firstCapability = gate.issueConfirmCapability();
    const secondCapability = gate.issueConfirmCapability();

    const firstLease = await arm(gate, firstCapability);
    await expect(arm(gate, secondCapability)).resolves.toBeNull();

    expect(firstLease).not.toBeNull();
    expect(armCustomerPayment).toHaveBeenCalledTimes(1);
    expect(disarmCustomerPayment).not.toHaveBeenCalled();
  });

  it('refreshes expiry only for the matching heartbeat', async () => {
    const gate = createGate();
    const capability = gate.issueConfirmCapability();
    const lease = await arm(gate, capability);

    expect(lease).not.toBeNull();
    currentTime = 1_000;
    await expect(gate.heartbeat(capability, 'different-lease')).resolves.toBeNull();
    await expect(gate.heartbeat('different-capability', lease!.leaseId)).resolves.toBeNull();

    const refreshedLease = await gate.heartbeat(capability, lease!.leaseId);

    expect(refreshedLease).toEqual({ ...lease, expiresAt: 16_000 });
    expect(armCustomerPayment).toHaveBeenCalledTimes(1);
    expect(disarmCustomerPayment).not.toHaveBeenCalled();
  });

  it('disarms when the heartbeat lease expires', async () => {
    const gate = createGate();
    const capability = gate.issueConfirmCapability();
    const lease = await arm(gate, capability);

    currentTime = 15_000;
    await jest.advanceTimersByTimeAsync(15_000);

    await expect(gate.heartbeat(capability, lease!.leaseId)).resolves.toBeNull();
    expect(disarmCustomerPayment).toHaveBeenCalledTimes(1);
    expect(disarmCustomerPayment).toHaveBeenCalledWith('heartbeat_timeout');
  });

  it('does not revive an expired lease with a late heartbeat', async () => {
    const gate = createGate();
    const capability = gate.issueConfirmCapability();
    const lease = await arm(gate, capability);

    currentTime = 15_000;
    await jest.advanceTimersByTimeAsync(15_000);
    currentTime = 16_000;

    await expect(gate.heartbeat(capability, lease!.leaseId)).resolves.toBeNull();
    expect(armCustomerPayment).toHaveBeenCalledTimes(1);
    expect(disarmCustomerPayment).toHaveBeenCalledTimes(1);
    expect(disarmCustomerPayment).toHaveBeenCalledWith('heartbeat_timeout');
  });

  it('disarms an active lease on explicit cancel and shutdown', async () => {
    const gate = createGate();
    const firstLease = await arm(gate, gate.issueConfirmCapability());

    await expect(gate.disarm(firstLease!.leaseId, 'page_exit')).resolves.toBe(true);
    await expect(gate.disarm(firstLease!.leaseId, 'page_exit')).resolves.toBe(true);

    const secondLease = await arm(gate, gate.issueConfirmCapability());
    await expect(gate.shutdown()).resolves.toBe(true);

    expect(secondLease).not.toBeNull();
    expect(armCustomerPayment).toHaveBeenCalledTimes(2);
    expect(disarmCustomerPayment).toHaveBeenCalledTimes(2);
    expect(disarmCustomerPayment).toHaveBeenNthCalledWith(1, 'page_exit');
    expect(disarmCustomerPayment).toHaveBeenNthCalledWith(2, 'shutdown');
  });
});
