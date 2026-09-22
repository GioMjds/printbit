import type { Server } from 'socket.io';
import { db, withBalanceLock } from './db';
import { adminService } from './admin';
import { hopperService, type HopperDispenseResult } from './hopper';
import { assertTrustedTimeForFinancialOperation } from './time-source';

export interface SettlementInput {
  requiredAmount: number;
  io: Server;
  jobContext: {
    mode: 'print' | 'copy' | 'scan';
    jobId?: string;
    [key: string]: string | number | boolean | null | undefined;
  };
}

export interface SettlementResult {
  ok: boolean;
  chargedAmount: number;
  previousBalance: number;
  remainingBalance: number;
  earnings: number;
  change: {
    requested: number;
    dispensed: number;
    state: 'none' | 'dispensing' | 'dispensed' | 'failed';
    attempts?: number;
    owedChangeId?: string | null;
    message?: string;
  };
  error?: string;
}

class SettlementService {
  async settle(input: SettlementInput): Promise<SettlementResult> {
    const { requiredAmount, io, jobContext } = input;
    assertTrustedTimeForFinancialOperation(`settlement:${jobContext.mode}`);
    const transactionId =
      typeof jobContext.transactionId === 'string'
        ? jobContext.transactionId
        : null;
    const spoolerCorrelationKey =
      typeof jobContext.spoolerCorrelationKey === 'string' &&
      jobContext.spoolerCorrelationKey.trim().length > 0
        ? jobContext.spoolerCorrelationKey.trim()
        : null;

    return withBalanceLock(async () => {
      const currentBalance = db.data?.balance ?? 0;

      if (currentBalance < requiredAmount) {
        void adminService.appendAdminLog(
          'payment_failed',
          `Settlement failed: insufficient balance after ${jobContext.mode} dispatch.`,
          {
            balance: currentBalance,
            requiredAmount,
            mode: jobContext.mode,
            jobId: jobContext.jobId ?? null,
          },
        );
        return {
          ok: false,
          chargedAmount: 0,
          previousBalance: currentBalance,
          remainingBalance: currentBalance,
          earnings: db.data!.earnings,
          change: { requested: 0, dispensed: 0, state: 'none' as const },
          error: 'Insufficient balance',
        };
      }

      const previousBalance = db.data!.balance;
      const changeAmount = previousBalance - requiredAmount;
      db.data!.balance = 0;
      db.data!.earnings += requiredAmount;
      await db.write();
      io.emit('balance', 0);

      if (changeAmount <= 0) {
        return {
          ok: true,
          chargedAmount: requiredAmount,
          previousBalance,
          remainingBalance: 0,
          earnings: db.data!.earnings,
          change: { requested: 0, dispensed: 0, state: 'none' as const },
        };
      }

      io.emit('changeDispenseStatus', {
        state: 'dispensing',
        amount: changeAmount,
        mode: jobContext.mode,
        transactionId,
        spoolerCorrelationKey,
      });

      const dispenseResult: HopperDispenseResult =
        await hopperService.dispenseChange(changeAmount);
      const dispensedAmount = Math.max(
        0,
        Math.min(changeAmount, Math.floor(dispenseResult.dispensedCoins)),
      );

      if (dispenseResult.ok) {
        io.emit('changeDispenseStatus', {
          state: 'dispensed',
          amount: changeAmount,
          dispensed: dispensedAmount,
          attempts: dispenseResult.attempts,
          mode: jobContext.mode,
          transactionId,
          spoolerCorrelationKey,
        });
        return {
          ok: true,
          chargedAmount: requiredAmount,
          previousBalance,
          remainingBalance: 0,
          earnings: db.data!.earnings,
          change: {
            requested: changeAmount,
            dispensed: dispensedAmount,
            state: 'dispensed' as const,
            attempts: dispenseResult.attempts,
          },
        };
      }

      io.emit('changeDispenseStatus', {
        state: 'failed',
        amount: changeAmount,
        dispensed: dispensedAmount,
        attempts: dispenseResult.attempts,
        owedChangeId: dispenseResult.owedChangeId ?? null,
        message: dispenseResult.message,
        mode: jobContext.mode,
        transactionId,
        spoolerCorrelationKey,
      });
      return {
        ok: true,
        chargedAmount: requiredAmount,
        previousBalance,
        remainingBalance: 0,
        earnings: db.data!.earnings,
        change: {
          requested: changeAmount,
          dispensed: dispensedAmount,
          state: 'failed' as const,
          attempts: dispenseResult.attempts,
          owedChangeId: dispenseResult.owedChangeId ?? null,
          message: dispenseResult.message,
        },
      };
    });
  }
}

export const settlementService = new SettlementService();
