jest.mock('../../src/services/worker-command-pipe', () => {
  const actual = jest.requireActual('../../src/services/worker-command-pipe');
  return {
    ...actual,
    sendWorkerCommand: jest.fn().mockResolvedValue(true),
    sendWorkerRequest: jest.fn(),
  };
});

import {
  CUSTOMER_PAYMENT_LOCK_OWNER,
  HardwareStateProjection,
} from '../../src/services/hardware-state-projection';
import { sendWorkerRequest } from '../../src/services/worker-command-pipe';
import type { WorkerHardwareResponse } from '../../src/services/worker-command-pipe';

const successfulCommand = async () => ({ success: true });

const mockedSendWorkerRequest = jest.mocked(sendWorkerRequest);

afterEach(() => {
  mockedSendWorkerRequest.mockReset();
});

describe('customer payment coin-slot lock', () => {
  it('initializes the customer-payment lock with an acknowledged worker command', async () => {
    const commands: Record<string, unknown>[] = [];
    const projection = new HardwareStateProjection({
      sendWorkerCommand: async (command) => {
        commands.push(command);
        return { success: true };
      },
    });

    expect(await projection.initializeCustomerPaymentLock()).toBe(true);
    expect(commands.at(-1)).toMatchObject({
      type: 'LockCoinSlot',
      ownerId: CUSTOMER_PAYMENT_LOCK_OWNER,
    });
  });

  it('retains the customer-payment lock when initialization is not acknowledged', async () => {
    const projection = new HardwareStateProjection({
      sendWorkerCommand: async () => null,
    });

    expect(await projection.initializeCustomerPaymentLock()).toBe(false);
    expect(projection.isCoinSlotLockedBy(CUSTOMER_PAYMENT_LOCK_OWNER)).toBe(
      true,
    );
  });

  it('rejects a malformed default worker reply as an arm acknowledgement', async () => {
    mockedSendWorkerRequest.mockResolvedValue({} as WorkerHardwareResponse);
    const projection = new HardwareStateProjection();

    expect(await projection.armCustomerPayment()).toBe(false);
    expect(projection.isCoinSlotLockedBy(CUSTOMER_PAYMENT_LOCK_OWNER)).toBe(
      true,
    );
  });

  it('starts locked by the customer-payment owner', () => {
    const projection = new HardwareStateProjection({
      sendWorkerCommand: successfulCommand,
    });

    expect(projection.isCoinSlotLockedBy(CUSTOMER_PAYMENT_LOCK_OWNER)).toBe(
      true,
    );
    expect(projection.isCoinSlotLocked()).toBe(true);
  });

  it('removes only the customer-payment lock after an acknowledged arm', async () => {
    const commands: Record<string, unknown>[] = [];
    const projection = new HardwareStateProjection({
      sendWorkerCommand: async (command) => {
        commands.push(command);
        return { success: true };
      },
    });
    projection.lockCoinSlot('power-safety');

    expect(await projection.armCustomerPayment()).toBe(true);

    expect(projection.isCoinSlotLockedBy(CUSTOMER_PAYMENT_LOCK_OWNER)).toBe(
      false,
    );
    expect(projection.isCoinSlotLockedBy('power-safety')).toBe(true);
    expect(commands.at(-1)).toMatchObject({
      type: 'UnlockCoinSlot',
      ownerId: CUSTOMER_PAYMENT_LOCK_OWNER,
    });
  });

  it('retains the lock when the worker does not acknowledge arm', async () => {
    const projection = new HardwareStateProjection({
      sendWorkerCommand: async () => null,
    });

    expect(await projection.armCustomerPayment()).toBe(false);
    expect(projection.isCoinSlotLockedBy(CUSTOMER_PAYMENT_LOCK_OWNER)).toBe(
      true,
    );
  });

  it('locks before returning from customer disarm', async () => {
    const projection = new HardwareStateProjection({
      sendWorkerCommand: successfulCommand,
    });
    await projection.armCustomerPayment();

    expect(await projection.disarmCustomerPayment('page_exit')).toBe(true);
    expect(projection.isCoinSlotLockedBy(CUSTOMER_PAYMENT_LOCK_OWNER)).toBe(
      true,
    );
  });

  it('serializes a delayed arm before a newer disarm', async () => {
    let resolveArm!: (response: WorkerHardwareResponse) => void;
    const commands: Record<string, unknown>[] = [];
    const projection = new HardwareStateProjection({
      sendWorkerCommand: (command) => {
        commands.push(command);
        if (command.type === 'UnlockCoinSlot') {
          return new Promise((resolve) => {
            resolveArm = resolve;
          });
        }
        return Promise.resolve({ success: true });
      },
    });

    const arm = projection.armCustomerPayment();
    const disarm = projection.disarmCustomerPayment('page_exit');

    await Promise.resolve();
    expect(commands.map((command) => command.type)).toEqual(['UnlockCoinSlot']);
    resolveArm({ success: true });
    expect(await arm).toBe(false);
    expect(await disarm).toBe(true);
    expect(commands.map((command) => command.type)).toEqual([
      'UnlockCoinSlot',
      'LockCoinSlot',
    ]);
    expect(projection.isCoinSlotLockedBy(CUSTOMER_PAYMENT_LOCK_OWNER)).toBe(
      true,
    );
  });
});
