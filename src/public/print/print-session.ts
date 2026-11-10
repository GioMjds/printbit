// Pure helpers for the kiosk /print page. Kept free of DOM access so they can
// be unit tested under jest's node environment.

export type UploadedFile = {
  documentId?: string;
  filename: string;
  size?: number;
  sizeBytes?: number;
  analysisStatus?: 'pending' | 'completed' | 'failed';
  analysisError?: string | null;
  pageCount?: number;
  analysis?: {
    pageCount?: number;
    totalPages?: number;
    isEntirelyBlank?: boolean;
    blankPages?: number[];
    blankPageCount?: number;
    pages?: {
      index: number;
      isBlank?: boolean;
      classification?: string;
      coverage?: number;
    }[];
  };
};

// ── File list signature ───────────────────────────────────────────────────────

export function fileKey(file: UploadedFile): string {
  const bytes = file.size ?? file.sizeBytes ?? -1;
  const pageCount =
    typeof file.pageCount === 'number'
      ? file.pageCount
      : typeof file.analysis?.pageCount === 'number'
        ? file.analysis.pageCount
        : typeof file.analysis?.totalPages === 'number'
          ? file.analysis.totalPages
          : -1;
  return `${file.documentId || file.filename}::${file.filename}::${bytes}::${pageCount}::${file.analysisStatus ?? ''}`;
}

/**
 * Identifies what the list currently shows. The max-pages limit is part of it
 * because each row renders an over-limit badge from that limit.
 */
export function filesSignature(
  files: UploadedFile[],
  maxPagesPerSession: number,
): string {
  return `max:${maxPagesPerSession}#${files.map(fileKey).join('|')}`;
}

// ── Analysis state ────────────────────────────────────────────────────────────

export const ANALYSIS_FAILED_TEXT =
  '⚠ Could not prepare this file. Tap Continue to retry.';
export const ANALYSIS_PREPARING_TEXT = 'Preparing pages…';

export type AnalysisBadge = { state: 'analyzing' | 'failed'; text: string };

/** Badge for a row, derived from session data so it survives list re-renders. */
export function getAnalysisBadge(file: UploadedFile): AnalysisBadge | null {
  if (file.analysisStatus === 'pending') {
    return { state: 'analyzing', text: ANALYSIS_PREPARING_TEXT };
  }
  if (file.analysisStatus === 'failed') {
    return { state: 'failed', text: ANALYSIS_FAILED_TEXT };
  }
  return null;
}

export type ContinueAction = 'proceed' | 'wait' | 'retry-then-wait';

/**
 * A failed analysis cannot be quoted by the server (ANALYSIS_FAILED), so
 * Continue must re-queue it instead of waiting on a result that never changes.
 */
export function decideContinueAction(
  file: UploadedFile | null | undefined,
): ContinueAction {
  if (file?.analysisStatus === 'completed') return 'proceed';
  if (file?.analysisStatus === 'failed') return 'retry-then-wait';
  return 'wait';
}

/** Above the server's 120 s document-conversion timeout. */
export const ANALYSIS_WAIT_TIMEOUT_MS = 150_000;
export const ANALYSIS_POLL_INTERVAL_MS = 750;

export type AnalysisWaitResult =
  | {
      ready: true;
      analysis?: UploadedFile['analysis'];
      document?: UploadedFile;
    }
  | { ready: false; message: string };

export type SessionDocumentsFetch =
  | { ok: true; documents: UploadedFile[] }
  | { ok: false };

export async function pollDocumentAnalysis(opts: {
  documentId: string;
  fetchSession: () => Promise<SessionDocumentsFetch>;
  isCancelled: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  intervalMs?: number;
  timeoutMs?: number;
}): Promise<AnalysisWaitResult> {
  const intervalMs = opts.intervalMs ?? ANALYSIS_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? ANALYSIS_WAIT_TIMEOUT_MS;
  const deadline = opts.now() + timeoutMs;

  while (!opts.isCancelled()) {
    if (opts.now() >= deadline) {
      return {
        ready: false,
        message:
          'Preparing is taking longer than expected. Tap Continue to try again.',
      };
    }

    try {
      const session = await opts.fetchSession();
      if (!session.ok) {
        return {
          ready: false,
          message:
            'Your session expired. Start a new session and upload again.',
        };
      }

      const document = session.documents.find(
        (candidate) =>
          (candidate.documentId || candidate.filename) === opts.documentId,
      );
      if (!document) {
        return {
          ready: false,
          message: 'The selected file is no longer available.',
        };
      }
      if (document.analysisStatus === 'completed') {
        return { ready: true, analysis: document.analysis, document };
      }
      if (document.analysisStatus === 'failed') {
        return {
          ready: false,
          message:
            document.analysisError ||
            'Document could not be prepared. Choose another file or try again.',
        };
      }
    } catch {
      // A transient network failure must not abandon a conversion still running
      // in the worker; the next poll will refresh the state. The deadline above
      // bounds how long we keep trying.
    }
    await opts.sleep(intervalMs);
  }

  return { ready: false, message: '' };
}

// ── Polling guard ─────────────────────────────────────────────────────────────

/**
 * Serialises an async job.
 * - `runIfIdle`: timer ticks. Skipped while a run is in flight, so a slow
 *   network cannot stack requests.
 * - `run`: event-driven refreshes (socket, delete). If a run is in flight, one
 *   more run happens right after it, and the returned promise covers both.
 */
export function createCoalescedRunner(fn: () => Promise<void>): {
  run: () => Promise<void>;
  runIfIdle: () => Promise<void>;
} {
  let current: Promise<void> | null = null;
  let rerun = false;

  const start = (): Promise<void> => {
    current = (async () => {
      try {
        do {
          rerun = false;
          await fn();
        } while (rerun);
      } finally {
        current = null;
        rerun = false;
      }
    })();
    return current;
  };

  return {
    run: () => {
      if (current) {
        rerun = true;
        return current;
      }
      return start();
    },
    runIfIdle: () => current ?? start(),
  };
}

// ── Socket ────────────────────────────────────────────────────────────────────

export type SocketLike = {
  on: (e: string, cb: (...a: unknown[]) => void) => void;
  emit: (e: string, ...a: unknown[]) => void;
  connect?: () => void;
  disconnect?: () => void;
};

/**
 * One socket and one set of handlers for the page's lifetime. `io()` returns a
 * cached socket, so creating it per session stacks duplicate handlers, and the
 * server has no leave event. Reconnecting drops the old session's room.
 */
export function createSessionSocket(
  ioFactory: (() => SocketLike) | undefined,
  registerHandlers: (socket: SocketLike) => void,
): { attach: (sessionId: string) => void } {
  let socket: SocketLike | null = null;
  let attachedSessionId: string | null = null;

  return {
    attach(sessionId: string): void {
      if (typeof ioFactory !== 'function') return;
      if (attachedSessionId === sessionId) return;

      if (!socket) {
        socket = ioFactory();
        registerHandlers(socket);
      } else {
        socket.disconnect?.();
        socket.connect?.();
      }
      attachedSessionId = sessionId;
      socket.emit('joinSession', sessionId);
    },
  };
}
