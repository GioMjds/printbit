import { initKioskLocalization } from '../shared/kiosk-i18n';

type ReceiptPrintConfiguration = {
  copies: number | null;
  colorMode: 'monochrome' | 'colored' | null;
  paperSize: string | null;
  quality: 'standard' | 'high' | null;
  duplex: boolean | null;
  orientation: 'portrait' | 'landscape' | null;
  pageRange: string | null;
};

type ReceiptPayload = {
  transactionId: string;
  mode: 'print' | 'copy' | string | null;
  chargedAmount: number | null;
  status: string | null;
  change?: {
    requested: number;
    dispensed: number;
    remaining: number;
    state: string | null;
    attempts: number;
    owedChangeId: string | null;
    message: string | null;
  };
  settledAt: string | null;
  terminalAt: string | null;
  generatedAt: string;
  colorPages: number | null;
  bwPages: number | null;
  pagesPrinted: number | null;
  totalPages: number | null;
  coinsInserted?: number | null;
  documentName?: string | null;
  printConfiguration?: ReceiptPrintConfiguration | null;
};

type ReceiptLookup =
  | { kind: 'token'; value: string }
  | { kind: 'transaction'; value: string };

/* ── DOM references ─────────────────────────────────────────────── */
const receiptCard = document.getElementById(
  'receiptCard',
) as HTMLElement | null;
const receiptBody = document.getElementById(
  'receiptBody',
) as HTMLElement | null;
const receiptDisclaimer = document.getElementById(
  'receiptDisclaimer',
) as HTMLElement | null;
const receiptMessage = document.getElementById(
  'receiptMessage',
) as HTMLElement | null;
const receiptActions = document.getElementById(
  'receiptActions',
) as HTMLElement | null;
const downloadBtn = document.getElementById(
  'downloadBtn',
) as HTMLButtonElement | null;

const rows = {
  documentName: document.getElementById('rowDocumentName') as HTMLElement | null,
  sepPrintConfig: document.getElementById('sepPrintConfig') as HTMLElement | null,
  copies: document.getElementById('rowCopies') as HTMLElement | null,
  colorMode: document.getElementById('rowColorMode') as HTMLElement | null,
  paperSize: document.getElementById('rowPaperSize') as HTMLElement | null,
  quality: document.getElementById('rowQuality') as HTMLElement | null,
  duplex: document.getElementById('rowDuplex') as HTMLElement | null,
  orientation: document.getElementById('rowOrientation') as HTMLElement | null,
  pageRange: document.getElementById('rowPageRange') as HTMLElement | null,
  coinsInserted: document.getElementById('rowCoinsInserted') as HTMLElement | null,
};

const fields = {
  transactionId: document.getElementById(
    'rTransactionId',
  ) as HTMLElement | null,
  mode: document.getElementById('rMode') as HTMLElement | null,
  documentName: document.getElementById(
    'rDocumentNameText',
  ) as HTMLElement | null,
  copies: document.getElementById('rCopies') as HTMLElement | null,
  colorMode: document.getElementById('rColorMode') as HTMLElement | null,
  paperSize: document.getElementById('rPaperSize') as HTMLElement | null,
  quality: document.getElementById('rQuality') as HTMLElement | null,
  duplex: document.getElementById('rDuplex') as HTMLElement | null,
  orientation: document.getElementById('rOrientation') as HTMLElement | null,
  pageRange: document.getElementById('rPageRange') as HTMLElement | null,
  coinsInserted: document.getElementById('rCoinsInserted') as HTMLElement | null,
  amount: document.getElementById('rAmount') as HTMLElement | null,
  colorPages: document.getElementById('rColorPages') as HTMLElement | null,
  bwPages: document.getElementById('rBwPages') as HTMLElement | null,
  pagesPrinted: document.getElementById('rPagesPrinted') as HTMLElement | null,
  changeRequested: document.getElementById(
    'rChangeRequested',
  ) as HTMLElement | null,
  changeDispensed: document.getElementById(
    'rChangeDispensed',
  ) as HTMLElement | null,
  changeRemaining: document.getElementById(
    'rChangeRemaining',
  ) as HTMLElement | null,
  changeStatus: document.getElementById('rChangeStatus') as HTMLElement | null,
  changeMessage: document.getElementById(
    'rChangeMessage',
  ) as HTMLElement | null,
  status: document.getElementById('rStatus') as HTMLElement | null,
  settledAt: document.getElementById('rSettledAt') as HTMLElement | null,
  generatedAt: document.getElementById('rGeneratedAt') as HTMLElement | null,
};

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;
const TERMINAL_STATUSES = new Set([
  'printed',
  'failed',
  'refunded',
  'refunded_pending_review',
]);

/* ── Helpers ────────────────────────────────────────────────────── */
function setField(el: HTMLElement | null, value: string): void {
  if (el) el.textContent = value;
}

function setRowVisible(row: HTMLElement | null, visible: boolean): void {
  if (!row) return;
  if (visible) {
    row.removeAttribute('hidden');
  } else {
    row.setAttribute('hidden', '');
  }
}

function setMessage(
  message: string,
  tone: 'default' | 'pending' | 'error' = 'default',
): void {
  if (!receiptMessage) return;
  receiptMessage.textContent = message;
  receiptMessage.classList.remove(
    'receipt-message--pending',
    'receipt-message--error',
  );
  if (tone === 'pending')
    receiptMessage.classList.add('receipt-message--pending');
  if (tone === 'error') receiptMessage.classList.add('receipt-message--error');
}

function fmtDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function fmtMode(value: string | null): string {
  if (!value) return '—';
  return value.toUpperCase();
}

function fmtPeso(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `₱${value.toFixed(2)}`;
}

function fmtStatus(value: string | null): string {
  if (!value) return '—';
  if (value === 'settled_pending_terminal')
    return 'pending terminal confirmation';
  if (value === 'refunded_pending_review') return 'refund pending review';
  return value.replace(/_/g, ' ');
}

function fmtChangeState(value: string | null): string {
  if (!value) return 'none';
  if (value === 'failed') return 'dispense failed';
  if (value === 'dispensed') return 'dispensed';
  if (value === 'none') return 'none';
  return value.replace(/_/g, ' ');
}

function resolveStatusBadge(status: string | null): 'success' | 'pending' | 'error' {
  if (!status) return 'pending';
  if (status === 'printed' || status === 'completed') return 'success';
  if (status === 'failed' || status === 'refunded' || status === 'refunded_pending_review') return 'error';
  return 'pending';
}

function resolveChangeDetails(payload: ReceiptPayload): {
  requested: number;
  dispensed: number;
  remaining: number;
  state: string;
  attempts: number;
  owedChangeId: string | null;
  message: string | null;
} {
  const requestedRaw = payload.change?.requested;
  const dispensedRaw = payload.change?.dispensed;
  const remainingRaw = payload.change?.remaining;
  const requested =
    typeof requestedRaw === 'number' && Number.isFinite(requestedRaw)
      ? Math.max(0, requestedRaw)
      : 0;
  const dispensed =
    typeof dispensedRaw === 'number' && Number.isFinite(dispensedRaw)
      ? Math.max(0, Math.min(dispensedRaw, requested))
      : 0;
  const remaining =
    typeof remainingRaw === 'number' && Number.isFinite(remainingRaw)
      ? Math.max(0, remainingRaw)
      : Math.max(0, requested - dispensed);
  const attemptsRaw = payload.change?.attempts;
  const attempts =
    typeof attemptsRaw === 'number' && Number.isFinite(attemptsRaw)
      ? Math.max(0, Math.floor(attemptsRaw))
      : 0;
  const state =
    typeof payload.change?.state === 'string' && payload.change.state.trim()
      ? payload.change.state.trim()
      : 'none';
  const owedChangeId =
    typeof payload.change?.owedChangeId === 'string' &&
    payload.change.owedChangeId.trim().length > 0
      ? payload.change.owedChangeId.trim()
      : null;
  const message =
    typeof payload.change?.message === 'string' &&
    payload.change.message.trim().length > 0
      ? payload.change.message.trim()
      : null;

  return {
    requested,
    dispensed,
    remaining,
    state,
    attempts,
    owedChangeId,
    message,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── URL parsing ────────────────────────────────────────────────── */
function parseLookupFromPath(): ReceiptLookup | null {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const receiptIndex = parts.indexOf('receipt');
  if (receiptIndex < 0) return null;

  const nextPart = parts[receiptIndex + 1];
  if (!nextPart) return null;

  if (nextPart === 't') {
    const tokenPart = parts[receiptIndex + 2];
    const token = tokenPart ? decodeURIComponent(tokenPart) : '';
    if (!token) return null;
    return { kind: 'token', value: token };
  }

  const transactionId = decodeURIComponent(nextPart);
  if (!transactionId) return null;
  return { kind: 'transaction', value: transactionId };
}

function resolveEndpoint(lookup: ReceiptLookup): string {
  if (lookup.kind === 'token') {
    return `/api/receipts/by-token/${encodeURIComponent(lookup.value)}`;
  }
  return `/api/transactions/${encodeURIComponent(lookup.value)}/receipt`;
}

function resolvePdfEndpoint(lookup: ReceiptLookup): string {
  if (lookup.kind === 'token') {
    return `/api/receipts/by-token/${encodeURIComponent(lookup.value)}/pdf`;
  }
  return `/api/admin/transactions/${encodeURIComponent(lookup.value)}/receipt/pdf`;
}

function resolveTokenErrorMessage(status: number, code: string | null): string {
  if (status === 410 || code === 'RECEIPT_TOKEN_EXPIRED') {
    return 'This E-Receipt link has expired.';
  }
  if (status === 403 || code === 'RECEIPT_TOKEN_REVOKED') {
    return 'This E-Receipt link has been revoked.';
  }
  if (status === 404 || code === 'RECEIPT_TOKEN_NOT_FOUND') {
    return 'This E-Receipt link is invalid.';
  }
  return 'Failed to load receipt details.';
}

/* ── API fetch ──────────────────────────────────────────────────── */
async function fetchReceiptPayload(
  lookup: ReceiptLookup,
): Promise<
  { ok: true; payload: ReceiptPayload } | { ok: false; message: string }
> {
  try {
    const res = await fetch(resolveEndpoint(lookup));
    if (!res.ok) {
      let code: string | null = null;
      try {
        const errorPayload = (await res.json()) as { code?: string };
        code =
          typeof errorPayload.code === 'string'
            ? errorPayload.code.trim()
            : null;
      } catch {
        code = null;
      }
      if (lookup.kind === 'token') {
        return {
          ok: false,
          message: resolveTokenErrorMessage(res.status, code),
        };
      }
      return {
        ok: false,
        message:
          res.status === 404
            ? 'Receipt not found for this transaction ID.'
            : 'Failed to load receipt details.',
      };
    }

    const payload = (await res.json()) as ReceiptPayload & {
      printedAt?: string | null;
    };
    if (payload.terminalAt == null && typeof payload.printedAt === 'string') {
      payload.terminalAt = payload.printedAt;
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, message: 'Network error while loading receipt.' };
  }
}

/* ── Render receipt data ────────────────────────────────────────── */
function renderReceipt(payload: ReceiptPayload): void {
  const change = resolveChangeDetails(payload);
  const changeMessage =
    change.message ??
    (change.remaining > 0
      ? 'Remaining change is pending manual staff settlement.'
      : 'No outstanding change.');
  setField(fields.transactionId, payload.transactionId);
  setField(fields.mode, fmtMode(payload.mode));

  if (payload.documentName) {
    setRowVisible(rows.documentName, true);
    setField(fields.documentName, payload.documentName);
  } else {
    setRowVisible(rows.documentName, false);
  }

  const config = payload.printConfiguration;
  const hasCopies = config?.copies != null;
  const hasColorMode = Boolean(config?.colorMode);
  const hasPaperSize = Boolean(config?.paperSize);
  const hasQuality = Boolean(config?.quality);
  const hasDuplex = config?.duplex != null;
  const hasOrientation = Boolean(config?.orientation);
  const hasPageRange = Boolean(config?.pageRange);
  const hasAnyConfig =
    hasCopies ||
    hasColorMode ||
    hasPaperSize ||
    hasQuality ||
    hasDuplex ||
    hasOrientation ||
    hasPageRange;

  setRowVisible(rows.sepPrintConfig, hasAnyConfig);

  setRowVisible(rows.copies, hasCopies);
  if (hasCopies && config?.copies != null) {
    setField(fields.copies, String(config.copies));
  }

  setRowVisible(rows.colorMode, hasColorMode);
  if (hasColorMode && config?.colorMode) {
    setField(
      fields.colorMode,
      config.colorMode === 'colored' ? 'Color' : 'Black & White',
    );
  }

  setRowVisible(rows.paperSize, hasPaperSize);
  if (hasPaperSize && config?.paperSize) {
    setField(fields.paperSize, config.paperSize.toUpperCase());
  }

  setRowVisible(rows.quality, hasQuality);
  if (hasQuality && config?.quality) {
    setField(
      fields.quality,
      config.quality === 'high' ? 'High' : 'Standard',
    );
  }

  setRowVisible(rows.duplex, hasDuplex);
  if (hasDuplex && config?.duplex != null) {
    setField(
      fields.duplex,
      config.duplex ? 'Double-sided' : 'Single-sided',
    );
  }

  setRowVisible(rows.orientation, hasOrientation);
  if (hasOrientation && config?.orientation) {
    setField(
      fields.orientation,
      config.orientation === 'landscape' ? 'Landscape' : 'Portrait',
    );
  }

  setRowVisible(rows.pageRange, hasPageRange);
  if (hasPageRange && config?.pageRange) {
    setField(fields.pageRange, config.pageRange);
  }

  if (payload.coinsInserted != null) {
    setRowVisible(rows.coinsInserted, true);
    setField(fields.coinsInserted, fmtPeso(payload.coinsInserted));
  } else {
    setRowVisible(rows.coinsInserted, false);
  }

  setField(fields.amount, fmtPeso(payload.chargedAmount));
  setField(
    fields.colorPages,
    payload.colorPages != null ? String(payload.colorPages) : '—',
  );
  setField(
    fields.bwPages,
    payload.bwPages != null ? String(payload.bwPages) : '—',
  );
  setField(
    fields.pagesPrinted,
    payload.pagesPrinted != null
      ? payload.totalPages != null
        ? `${payload.pagesPrinted} of ${payload.totalPages} pages`
        : `${payload.pagesPrinted} pages`
      : '—',
  );
  setField(fields.changeRequested, fmtPeso(change.requested));
  setField(fields.changeDispensed, fmtPeso(change.dispensed));
  setField(fields.changeRemaining, fmtPeso(change.remaining));
  setField(fields.changeStatus, fmtChangeState(change.state));
  setField(fields.changeMessage, changeMessage);
  setField(fields.status, fmtStatus(payload.status));
  setField(fields.settledAt, fmtDate(payload.settledAt));
  setField(fields.generatedAt, fmtDate(payload.generatedAt));

  // Set status badge color
  if (fields.status) {
    fields.status.setAttribute('data-status', resolveStatusBadge(payload.status));
  }

  // Show receipt body, disclaimer, and action buttons
  receiptBody?.removeAttribute('hidden');
  receiptDisclaimer?.removeAttribute('hidden');
  receiptActions?.removeAttribute('hidden');
}

/* ── Download as PDF ────────────────────────────────────────────── */
async function downloadReceiptAsPdf(): Promise<void> {
  const lookup = parseLookupFromPath();
  if (!lookup || !downloadBtn) return;

  const originalContent = downloadBtn.innerHTML;
  downloadBtn.classList.add('is-saving');
  downloadBtn.disabled = true;
  downloadBtn.innerHTML = `
    <svg class="spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
      <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" />
    </svg>
    <span>Generating PDF…</span>
  `;

  const pdfUrl = resolvePdfEndpoint(lookup);

  try {
    const res = await fetch(pdfUrl);
    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    const txId = fields.transactionId?.textContent?.trim() || 'receipt';
    link.download = `printbit-receipt-${txId}.pdf`;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    }, 2000);
  } catch (err) {
    console.error('[RECEIPT] PDF fetch failed, falling back to direct navigation:', err);
    window.location.href = pdfUrl;
  } finally {
    downloadBtn.classList.remove('is-saving');
    downloadBtn.disabled = false;
    downloadBtn.innerHTML = originalContent;
  }
}

/* ── Event listeners ────────────────────────────────────────────── */
downloadBtn?.addEventListener('click', () => {
  void downloadReceiptAsPdf();
});

/* ── Load receipt ───────────────────────────────────────────────── */
async function loadReceipt(): Promise<void> {
  const lookup = parseLookupFromPath();
  if (!lookup) {
    setMessage('Invalid receipt URL.', 'error');
    return;
  }

  const pollingDeadline = Date.now() + POLL_TIMEOUT_MS;

  while (true) {
    const result = await fetchReceiptPayload(lookup);
    if (!result.ok) {
      setMessage(result.message, 'error');
      return;
    }

    renderReceipt(result.payload);
    const isPrintPending =
      result.payload.mode === 'print' &&
      result.payload.status === 'settled_pending_terminal';

    if (!isPrintPending) {
      const change = resolveChangeDetails(result.payload);
      if (change.state === 'failed' && change.remaining > 0) {
        const suffix = change.owedChangeId
          ? ` Owed-change ID: ${change.owedChangeId}.`
          : '';
        setMessage(
          `Change reconciliation pending. Dispensed ${fmtPeso(change.dispensed)} of ${fmtPeso(change.requested)}.${suffix}`,
          'pending',
        );
      } else if (
        result.payload.mode === 'print' &&
        result.payload.status &&
        TERMINAL_STATUSES.has(result.payload.status)
      ) {
        setMessage(`Print status: ${fmtStatus(result.payload.status)}.`);
      } else {
        setMessage('');
      }
      return;
    }

    const remainingMs = pollingDeadline - Date.now();
    if (remainingMs <= 0) {
      setMessage(
        'Payment settled. Print confirmation is still pending. Please refresh in a moment.',
        'pending',
      );
      return;
    }

    setMessage(
      `Payment settled. Waiting for printer confirmation… Refreshing automatically (${Math.ceil(
        remainingMs / 1000,
      )}s left).`,
      'pending',
    );
    await wait(Math.min(POLL_INTERVAL_MS, remainingMs));
  }
}

void initKioskLocalization();
void loadReceipt();
