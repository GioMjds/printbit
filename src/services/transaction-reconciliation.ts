import { db } from '@/core/database/db';
import {
  transactionReconciliationStore,
  type TransactionReconciliationEntry,
  type ReconciliationSummary,
} from '@/core/database/models/transaction-reconciliation.model';
import { printJobStore } from '@/core/database/models/print-job.model';
import { receiptStore } from '@/core/database/models/receipt.model';
import { getAuthoritativeCoinStats } from '@/core/database/sqlite-storage';
import {
  financialLedgerService,
  recomputeLedgerChainHashes,
} from '@/services/financial-ledger';

export class TransactionReconciliationService {
  private reconciliationPromise: Promise<ReconciliationSummary> | null = null;

  async reconcileAll(): Promise<ReconciliationSummary> {
    if (this.reconciliationPromise) {
      return this.reconciliationPromise;
    }

    this.reconciliationPromise = (async () => {
      // 1. Ensure runtime database is loaded
      if (!db.data) {
        await db.read();
      }

      // 2. Resolve duplicate copy-job-hist-1 in financialLedger
      if (db.data?.financialLedger) {
        const entries = db.data.financialLedger;
        const copyJobEntries = entries.filter(
          (e) =>
            e.referenceId === 'copy-job-hist-1' &&
            e.eventType === 'job_completed',
        );
        const activeCopyEntries = copyJobEntries.filter(
          (e) => e.meta?.reconciliationStatus !== 'duplicate',
        );

        if (activeCopyEntries.length > 1) {
          // Canonical is the oldest entry (highest array index due to unshift)
          const canonical = activeCopyEntries[activeCopyEntries.length - 1];
          for (let i = 0; i < activeCopyEntries.length - 1; i += 1) {
            const dup = activeCopyEntries[i];
            dup.meta = {
              ...(dup.meta ?? {}),
              reconciliationStatus: 'duplicate',
              duplicateOf: canonical.id,
            };
          }
          // Recompute hash chain to preserve cryptographic audit trail
          recomputeLedgerChainHashes(entries);
          await db.write();
        }
      }

      // 3. Reconcile verified printed receipts into financialLedger
      const receiptsResult = receiptStore.listReceipts({
        limit: 1000,
        offset: 0,
      });
      const allReceipts = receiptsResult.items;

      for (const receipt of allReceipts) {
        if (receipt.status !== 'printed') continue;

        const existingLedger = db.data?.financialLedger.find(
          (e) =>
            e.referenceId === receipt.transactionId &&
            e.eventType === 'job_completed' &&
            e.meta?.reconciliationStatus !== 'duplicate',
        );

        if (!existingLedger) {
          await financialLedgerService.append({
            eventType: 'job_completed',
            amount: receipt.chargedAmount,
            referenceId: receipt.transactionId,
            meta: {
              mode: receipt.mode,
              receiptId: receipt.id,
              reconciled: true,
              source: 'receipt_reconciliation',
              changeDispensed: receipt.change.dispensed,
            },
            timestamp: receipt.createdAt,
            timestampMeta: {
              source: 'system',
              synced: true,
              offsetMs: 0,
              detail: 'Historical receipt promotion to financial ledger',
            },
          });
        }
      }

      // 4. Classify all print_jobs into transaction_reconciliation
      const allJobs = printJobStore.listAllJobs(10000);
      const receiptMap = new Map<string, (typeof allReceipts)[0]>();
      for (const r of allReceipts) {
        receiptMap.set(r.transactionId, r);
      }

      const processedTxIds = new Set<string>();

      for (const job of allJobs) {
        processedTxIds.add(job.transactionId);
        const matchingReceipt = receiptMap.get(job.transactionId);
        const matchingLedger = db.data?.financialLedger.find(
          (e) =>
            e.referenceId === job.transactionId &&
            e.eventType === 'job_completed' &&
            e.meta?.reconciliationStatus !== 'duplicate',
        );
        const existingReconcile =
          transactionReconciliationStore.getByTransactionId(job.transactionId);

        let requiredAmount = 0;
        let mode = 'print';
        try {
          const payload = JSON.parse(job.payloadJson);
          requiredAmount = Number(
            payload.financial?.requiredAmount ??
              payload.price?.total ??
              payload.requiredAmount ??
              payload.totalPrice ??
              0,
          );
          mode = payload.request?.mode || payload.mode || 'print';
        } catch {
          requiredAmount = 0;
        }

        if (matchingReceipt && matchingReceipt.status === 'printed') {
          transactionReconciliationStore.upsert({
            transactionId: job.transactionId,
            jobId: job.jobId,
            createdAt: job.createdAt,
            mode: matchingReceipt.mode || mode,
            requiredAmount: requiredAmount || matchingReceipt.chargedAmount,
            verifiedAmount: matchingReceipt.chargedAmount,
            reconciliationStatus: 'RECONCILED_COMPLETED',
            paymentEvidence: `receipt:${matchingReceipt.id}`,
            changeDispensed: matchingReceipt.change.dispensed,
            receiptId: matchingReceipt.id,
            detailsJson: matchingReceipt.details
              ? JSON.stringify(matchingReceipt.details)
              : job.payloadJson,
          });
        } else if (matchingLedger) {
          // Preserved from permanent financial ledger even when temporary receipt expired
          transactionReconciliationStore.upsert({
            transactionId: job.transactionId,
            jobId: job.jobId,
            createdAt: job.createdAt,
            mode:
              (typeof matchingLedger.meta?.mode === 'string'
                ? matchingLedger.meta.mode
                : null) || mode,
            requiredAmount: requiredAmount || matchingLedger.amount,
            verifiedAmount: matchingLedger.amount,
            reconciliationStatus: 'RECONCILED_COMPLETED',
            paymentEvidence: matchingLedger.meta?.receiptId
              ? `receipt:${matchingLedger.meta.receiptId}`
              : typeof matchingLedger.meta?.source === 'string'
                ? `ledger:${matchingLedger.meta.source}`
                : 'financial_ledger',
            changeDispensed: Number(matchingLedger.meta?.changeDispensed || 0),
            receiptId:
              (typeof matchingLedger.meta?.receiptId === 'string'
                ? matchingLedger.meta.receiptId
                : null) ||
              existingReconcile?.receiptId ||
              null,
            detailsJson:
              existingReconcile?.detailsJson ??
              JSON.stringify(matchingLedger.meta || {}),
          });
        } else if (
          existingReconcile?.reconciliationStatus === 'RECONCILED_COMPLETED'
        ) {
          // Never demote a verified transaction
          transactionReconciliationStore.upsert({
            ...existingReconcile,
            jobId: job.jobId,
            requiredAmount: requiredAmount || existingReconcile.requiredAmount,
          });
        } else if (job.state === 'failed') {
          transactionReconciliationStore.upsert({
            transactionId: job.transactionId,
            jobId: job.jobId,
            createdAt: job.createdAt,
            mode,
            requiredAmount,
            verifiedAmount: 0,
            reconciliationStatus: 'FAILED_NO_CHARGE',
            paymentEvidence: 'none',
            changeDispensed: 0,
            receiptId: null,
            detailsJson: job.payloadJson,
          });
        } else {
          transactionReconciliationStore.upsert({
            transactionId: job.transactionId,
            jobId: job.jobId,
            createdAt: job.createdAt,
            mode,
            requiredAmount,
            verifiedAmount: 0,
            reconciliationStatus: 'JOB_ONLY',
            paymentEvidence: 'unverified_historical_gap',
            changeDispensed: 0,
            receiptId: null,
            detailsJson: job.payloadJson,
          });
        }
      }

      // 5. Standalone verified receipts not in print_jobs (e.g. scan jobs)
      for (const r of allReceipts) {
        if (!processedTxIds.has(r.transactionId) && r.status === 'printed') {
          transactionReconciliationStore.upsert({
            transactionId: r.transactionId,
            jobId: null,
            createdAt: r.createdAt,
            mode: r.mode,
            requiredAmount: r.chargedAmount,
            verifiedAmount: r.chargedAmount,
            reconciliationStatus: 'RECONCILED_COMPLETED',
            paymentEvidence: `receipt:${r.id}`,
            changeDispensed: r.change.dispensed,
            receiptId: r.id,
            detailsJson: r.details ? JSON.stringify(r.details) : null,
          });
          processedTxIds.add(r.transactionId);
        }
      }

      // 6. Standalone verified ledger entries not in print_jobs (e.g. copy-job-hist-1, scan jobs whose receipt expired)
      if (db.data?.financialLedger) {
        for (const entry of db.data.financialLedger) {
          if (entry.environment === 'test') continue;
          if (entry.meta?.reconciliationStatus === 'duplicate') continue;
          if (entry.eventType !== 'job_completed') continue;

          if (!processedTxIds.has(entry.referenceId)) {
            const existingReconcile =
              transactionReconciliationStore.getByTransactionId(
                entry.referenceId,
              );
            transactionReconciliationStore.upsert({
              transactionId: entry.referenceId,
              jobId: existingReconcile?.jobId ?? null,
              createdAt: entry.timestamp,
              mode:
                (typeof entry.meta?.mode === 'string'
                  ? entry.meta.mode
                  : null) ||
                existingReconcile?.mode ||
                'print',
              requiredAmount: entry.amount,
              verifiedAmount: entry.amount,
              reconciliationStatus: 'RECONCILED_COMPLETED',
              paymentEvidence: entry.meta?.receiptId
                ? `receipt:${entry.meta.receiptId}`
                : typeof entry.meta?.source === 'string'
                  ? `ledger:${entry.meta.source}`
                  : 'financial_ledger',
              changeDispensed: Number(entry.meta?.changeDispensed || 0),
              receiptId:
                (typeof entry.meta?.receiptId === 'string'
                  ? entry.meta.receiptId
                  : null) ||
                existingReconcile?.receiptId ||
                null,
              detailsJson:
                existingReconcile?.detailsJson ??
                JSON.stringify(entry.meta || {}),
            });
            processedTxIds.add(entry.referenceId);
          }
        }
      }

      // 7. Update authoritative aggregates in runtime_state
      if (db.data) {
        db.data.jobStats = printJobStore.getJobStats();
        db.data.coinStats = getAuthoritativeCoinStats();

        let verifiedEarnings = 0;
        for (const entry of db.data.financialLedger) {
          if (entry.environment === 'test') continue;
          if (entry.meta?.reconciliationStatus === 'duplicate') continue;
          if (entry.eventType === 'job_completed') {
            verifiedEarnings += entry.amount;
          } else if (entry.eventType === 'refund_issued') {
            verifiedEarnings -= entry.amount;
          }
        }
        db.data.earnings = Number(Math.max(0, verifiedEarnings).toFixed(2));
        await db.write();
      }

      return transactionReconciliationStore.getSummary();
    })().finally(() => {
      this.reconciliationPromise = null;
    });

    return this.reconciliationPromise;
  }

  getSummary(): ReconciliationSummary {
    return transactionReconciliationStore.getSummary();
  }

  listReconciledTransactions(limit = 100): TransactionReconciliationEntry[] {
    return transactionReconciliationStore.listAll(limit);
  }

  getByTransactionId(txId: string): TransactionReconciliationEntry | null {
    return transactionReconciliationStore.getByTransactionId(txId);
  }
}

export const transactionReconciliationService =
  new TransactionReconciliationService();
