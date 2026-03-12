import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { runPowerShell } from '@/utils';
import { db } from './db';
import { adminService } from './admin';

const POLL_INTERVAL_MS = 4_000;
/** Total window to watch the spooler before giving up */
const MONITOR_WINDOW_MS = 3 * 60 * 1_000; // 3 minutes
/** How far back (in minutes) to look for print jobs when querying the spooler */
const JOB_LOOKBACK_MINUTES = 3;

// Windows JobStatus enum values (comma-separated string from PowerShell)

const TERMINAL_SUCCESS_TOKENS = new Set([
  'Printed',
  'Complete',
  'SchedulingComplete',
]);

const TERMINAL_FAILURE_TOKENS = new Set([
  'Error',
  'Deleted',
  'Offline',
  'PaperOut',
  'BlockedDevq',
  'UserIntervention',
]);

export interface SpoolerMonitorOptions {
  printerName: string;
  chargedAmount: number;
  jobDispatchedAt: string;
  io: Server;
  jobContext: Record<string, string | number | boolean | null | undefined>;
}

export interface SpoolerMonitorResult {
  detected: boolean;
  jobStatus: string | null;
  pagesPrinted: number;
  failed: boolean;
  /** ID of the created PendingRefundEntry when failed === true */
  refundId?: string;
}

interface SpoolerJobRow {
  id: number;
  status: string;
  totalPages: number;
  pagesPrinted: number;
}

// ── PowerShell helper ───────────────────────────────────────────────────────

async function queryRecentPrintJobs(
  printerName: string,
): Promise<SpoolerJobRow[]> {
  try {
    const escaped = printerName.replace(/'/g, "''").replace(/`/g, '``');
    const script =
      `$cutoff = (Get-Date).AddMinutes(-${JOB_LOOKBACK_MINUTES}); ` +
      `Get-PrintJob -PrinterName '${escaped}' -ErrorAction SilentlyContinue ` +
      `| Where-Object { $_.SubmittedTime -ge $cutoff } ` +
      `| Select-Object Id, @{N='Status';E={$_.JobStatus.ToString()}}, TotalPages, PagesPrinted ` +
      `| ConvertTo-Json -Depth 2 -Compress`;

    const json = await runPowerShell(script, 10_000);
    if (!json || json === 'null' || json === '[]') return [];

    const raw: unknown = JSON.parse(json);
    const items = Array.isArray(raw) ? raw : [raw];

    return items
      .filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object',
      )
      .map((item) => ({
        id: Number(item.Id ?? 0),
        status: String(item.Status ?? 'Unknown').trim(),
        totalPages: Number(item.TotalPages ?? 0),
        pagesPrinted: Number(item.PagesPrinted ?? 0),
      }));
  } catch {
    console.warn('[SPOOLER-MONITOR] Failed to query print jobs');
    return [];
  }
}

/** Returns true if any token in the comma/space-separated status string matches the set. */
function matchesStatusSet(status: string, set: Set<string>): boolean {
  return status.split(/[,\s]+/).some((token) => token && set.has(token));
}

/**
 * Fire-and-forget: call this AFTER settlement has completed.
 * It polls the Windows print spooler in the background.
 * On spooler-reported failure it:
 *   - creates a PendingRefundEntry in the DB
 *   - writes an admin log entry
 *   - emits `printerSpoolerFailure` over Socket.IO
 */
export async function monitorSpoolerJob(
  options: SpoolerMonitorOptions,
): Promise<SpoolerMonitorResult> {
  const { printerName, chargedAmount, jobDispatchedAt, io, jobContext } =
    options;

  if (!printerName) {
    return { detected: false, jobStatus: null, pagesPrinted: 0, failed: false };
  }

  const deadline = Date.now() + MONITOR_WINDOW_MS;
  let lastStatus: string | null = null;
  let lastPagesPrinted = 0;
  let trackedJobId: number | null = null;

  console.log(
    `[SPOOLER-MONITOR] Starting — printer="${printerName}" chargedAmount=${chargedAmount}`,
  );

  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const jobs = await queryRecentPrintJobs(printerName);
    if (jobs.length === 0) continue;

    // Latch onto the highest job ID seen (most recently submitted)
    const job: SpoolerJobRow =
      trackedJobId !== null
        ? (jobs.find((j) => j.id === trackedJobId) ??
          jobs.reduce((a, b) => (b.id > a.id ? b : a)))
        : jobs.reduce((a, b) => (b.id > a.id ? b : a));

    if (trackedJobId === null) {
      trackedJobId = job.id;
      console.log(
        `[SPOOLER-MONITOR] Latched onto spooler job #${trackedJobId}`,
      );
    }

    lastStatus = job.status;
    lastPagesPrinted = job.pagesPrinted;

    console.log(
      `[SPOOLER-MONITOR] Job #${job.id} status="${job.status}" pages=${job.pagesPrinted}/${job.totalPages}`,
    );

    if (matchesStatusSet(job.status, TERMINAL_SUCCESS_TOKENS)) {
      console.log(`[SPOOLER-MONITOR] ✓ Job #${job.id} completed successfully`);
      return {
        detected: true,
        jobStatus: job.status,
        pagesPrinted: job.pagesPrinted,
        failed: false,
      };
    }

    if (matchesStatusSet(job.status, TERMINAL_FAILURE_TOKENS)) {
      console.error(
        `[SPOOLER-MONITOR] ✗ Job #${job.id} FAILED — status="${job.status}"`,
      );

      // Build pending refund record
      const refundEntry = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        chargedAmount,
        reason: `Print spooler reported failure: ${job.status}`,
        status: 'open' as const,
        closedAt: null as string | null,
        jobContext: {
          ...Object.fromEntries(
            Object.entries(jobContext).map(([k, v]) => [k, v ?? null]),
          ),
          spoolerJobId: job.id,
          spoolerStatus: job.status,
          pagesPrinted: job.pagesPrinted,
          totalPages: job.totalPages,
          jobDispatchedAt,
          printerName,
        } as Record<string, string | number | boolean | null>,
      };

      db.data!.pendingRefunds.unshift(refundEntry);
      await db.write();

      await adminService.appendAdminLog(
        'print_spooler_job_failed',
        `Print spooler failure detected: ${job.status}. Pending refund ₱${chargedAmount} created.`,
        {
          spoolerJobId: job.id,
          spoolerStatus: job.status,
          chargedAmount,
          refundId: refundEntry.id,
          pagesPrinted: job.pagesPrinted,
          printerName,
        },
      );

      io.emit('printerSpoolerFailure', {
        jobStatus: job.status,
        chargedAmount,
        refundId: refundEntry.id,
        pagesPrinted: job.pagesPrinted,
        printerName,
      });

      return {
        detected: true,
        jobStatus: job.status,
        pagesPrinted: job.pagesPrinted,
        failed: true,
        refundId: refundEntry.id,
      };
    }
  }

  // Monitor window expired — job probably succeeded (or spooler cleared it already)
  console.log(
    `[SPOOLER-MONITOR] Window expired. Last known status: "${lastStatus ?? 'none'}"`,
  );
  return {
    detected: lastStatus !== null,
    jobStatus: lastStatus,
    pagesPrinted: lastPagesPrinted,
    failed: false,
  };
}
