import type { Server } from 'socket.io';
import { db, withBalanceLock } from './db';
import { adminService } from './admin';
import { hopperService, type HopperDispenseResult } from './hopper';

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
      });

      const dispenseResult: HopperDispenseResult =
        await hopperService.dispenseChange(changeAmount);

      if (dispenseResult.ok) {
        io.emit('changeDispenseStatus', {
          state: 'dispensed',
          amount: changeAmount,
          attempts: dispenseResult.attempts,
        });
        return {
          ok: true,
          chargedAmount: requiredAmount,
          previousBalance,
          remainingBalance: 0,
          earnings: db.data!.earnings,
          change: {
            requested: changeAmount,
            dispensed: changeAmount,
            state: 'dispensed' as const,
            attempts: dispenseResult.attempts,
          },
        };
      }

      io.emit('changeDispenseStatus', {
        state: 'failed',
        amount: changeAmount,
        attempts: dispenseResult.attempts,
        owedChangeId: dispenseResult.owedChangeId ?? null,
        message: dispenseResult.message,
      });
      return {
        ok: true,
        chargedAmount: requiredAmount,
        previousBalance,
        remainingBalance: 0,
        earnings: db.data!.earnings,
        change: {
          requested: changeAmount,
          dispensed: 0,
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
