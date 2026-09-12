import {
  CUSTOMER_PAYMENT_LOCK_OWNER,
  HardwareStateProjection,
} from '../../src/services/hardware-state-projection';

const successfulCommand = async () => ({ success: true });

describe('customer payment coin-slot lock', () => {
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
});
