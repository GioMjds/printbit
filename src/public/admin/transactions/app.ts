import {
  LogsResponse,
  SummaryResponse,
  apiFetch,
  setMessage,
  initAuth,
  updateSidebarBadges,
} from '../shared';
import {
  calculateSuggestedRefund,
  calculatePriorRefunds,
  calculateMaxRefundable,
} from './refund-calculator';
import {
  formatReportScope,
  getFulfillmentBadgeClass,
  generatePageOutputCsv,
  PageOutputSummaryResponse,
} from './page-output-report-helpers';

export {
  calculateSuggestedRefund,
  calculatePriorRefunds,
  calculateMaxRefundable,
  formatReportScope,
  getFulfillmentBadgeClass,
  generatePageOutputCsv,
};

// Topbar & Navigation
const logsBody = document.getElementById('logsBody') as HTMLElement;
const refreshBtn = document.getElementById('refreshBtn') as HTMLButtonElement;
const exportLogsBtn = document.getElementById(
  'exportLogsBtn',
) as HTMLButtonElement;
const prevPageBtn = document.getElementById('prevPageBtn') as HTMLButtonElement;
const nextPageBtn = document.getElementById('nextPageBtn') as HTMLButtonElement;
const pageInfo = document.getElementById('pageInfo') as HTMLElement;

// KPI Ribbon Elements
const kpiTotalCount = document.getElementById('kpiTotalCount');
const kpiTotalAmount = document.getElementById('kpiTotalAmount');
const kpiDiscrepancyCount = document.getElementById('kpiDiscrepancyCount');
const txToast = document.getElementById('txToast');

// Filters & Search
const applyFiltersBtn = document.getElementById(
  'applyFiltersBtn',
) as HTMLButtonElement;
const clearFiltersBtn = document.getElementById(
  'clearFiltersBtn',
) as HTMLButtonElement;
const activeFilterCount = document.getElementById(
  'activeFilterCount',
) as HTMLElement | null;
const txFiltersPanel = document.getElementById(
  'txFiltersPanel',
) as HTMLDetailsElement | null;
const quickChips = document.querySelectorAll<HTMLButtonElement>('.tx-chip');

const transactionIdInput = document.getElementById(
  'transactionIdInput',
) as HTMLInputElement;
const modeFilter = document.getElementById('modeFilter') as HTMLSelectElement;
const statusFilter = document.getElementById(
  'statusFilter',
) as HTMLSelectElement;
const eventTypeInput = document.getElementById(
  'eventTypeInput',
) as HTMLInputElement;
const dateFromInput = document.getElementById(
  'dateFromInput',
) as HTMLInputElement;
const dateToInput = document.getElementById('dateToInput') as HTMLInputElement;

// Context Drawer Elements
const txDrawerBackdrop = document.getElementById(
  'txDrawerBackdrop',
) as HTMLElement | null;
const txDetailDrawer = document.getElementById(
  'txDetailDrawer',
) as HTMLElement | null;
const txDetailCloseBtn = document.getElementById(
  'txDetailCloseBtn',
) as HTMLButtonElement | null;
const txDrawerDoneBtn = document.getElementById(
  'txDrawerDoneBtn',
) as HTMLButtonElement | null;
const txReceiptPdfBtn = document.getElementById(
  'txReceiptPdfBtn',
) as HTMLButtonElement | null;
const txReportIssueBtn = document.getElementById(
  'txReportIssueBtn',
) as HTMLButtonElement | null;
const txDetailState = document.getElementById(
  'txDetailState',
) as HTMLElement | null;

const dTransactionId = document.getElementById('dTransactionId');
const dCopyTxIdBtn = document.getElementById(
  'dCopyTxIdBtn',
) as HTMLButtonElement | null;
const dMode = document.getElementById('dMode');
const dAmount = document.getElementById('dAmount');
const dStatus = document.getElementById('dStatus');
const dDocumentName = document.getElementById('dDocumentName');
const dPaperSize = document.getElementById('dPaperSize');
const dCopies = document.getElementById('dCopies');
const dPrintSides = document.getElementById('dPrintSides');
const dQuality = document.getElementById('dQuality');
const dColorPages = document.getElementById('dColorPages');
const dBwPages = document.getElementById('dBwPages');
const dPagesPrinted = document.getElementById('dPagesPrinted');
const dChangeRequested = document.getElementById('dChangeRequested');
const dChangeDispensed = document.getElementById('dChangeDispensed');
const dChangeRemaining = document.getElementById('dChangeRemaining');
const dChangeStatus = document.getElementById('dChangeStatus');
const dChangeMessage = document.getElementById('dChangeMessage');
const dSettledAt = document.getElementById('dSettledAt');
const dTerminalAt = document.getElementById('dTerminalAt');
const dGeneratedAt = document.getElementById('dGeneratedAt');
const dContextHint = document.getElementById('dContextHint');
const dMissingReasons = document.getElementById('dMissingReasons');
const dRelatedLogsBody = document.getElementById('dRelatedLogsBody');

// Drawer Enhanced Cards Elements
const dPageAuditCard = document.getElementById(
  'dPageAuditCard',
) as HTMLElement | null;
const dAuditRequestedPages = document.getElementById('dAuditRequestedPages');
const dAuditPrintedPages = document.getElementById('dAuditPrintedPages');
const dAuditUnprintedPages = document.getElementById('dAuditUnprintedPages');
const dAuditChargedAmount = document.getElementById('dAuditChargedAmount');
const dAuditSuggestedRefund = document.getElementById('dAuditSuggestedRefund');
const dAuditRefundActionBtn = document.getElementById(
  'dAuditRefundActionBtn',
) as HTMLButtonElement | null;

const dOwedChangeCard = document.getElementById(
  'dOwedChangeCard',
) as HTMLElement | null;
const dOwedChangeCardAmount = document.getElementById('dOwedChangeCardAmount');
const dOwedChangeCardId = document.getElementById('dOwedChangeCardId');
const dOwedChangeCardState = document.getElementById('dOwedChangeCardState');
const dOwedChangeCardReason = document.getElementById('dOwedChangeCardReason');
const dResolveOwedChangeBtn = document.getElementById(
  'dResolveOwedChangeBtn',
) as HTMLButtonElement | null;

const dLedgerCountBadge = document.getElementById('dLedgerCountBadge');
const dLedgerBody = document.getElementById(
  'dLedgerBody',
) as HTMLElement | null;

// Incident Report Modal Elements
const txReportModal = document.getElementById(
  'txReportModal',
) as HTMLElement | null;
const txReportCloseBtn = document.getElementById(
  'txReportCloseBtn',
) as HTMLButtonElement | null;
const txReportCancelBtn = document.getElementById(
  'txReportCancelBtn',
) as HTMLButtonElement | null;
const txReportSubmitBtn = document.getElementById(
  'txReportSubmitBtn',
) as HTMLButtonElement | null;
const txReportTitleInput = document.getElementById(
  'txReportTitleInput',
) as HTMLInputElement | null;
const txReportCategoryInput = document.getElementById(
  'txReportCategoryInput',
) as HTMLSelectElement | null;
const txReportDescriptionInput = document.getElementById(
  'txReportDescriptionInput',
) as HTMLTextAreaElement | null;

// Pending Refund Banner Elements
const dPendingRefundBanner = document.getElementById(
  'dPendingRefundBanner',
) as HTMLElement | null;
const dPendingRefundAmount = document.getElementById('dPendingRefundAmount');
const dPendingRefundReason = document.getElementById('dPendingRefundReason');
const dConfirmPendingRefundBtn = document.getElementById(
  'dConfirmPendingRefundBtn',
) as HTMLButtonElement | null;
const dDismissPendingRefundBtn = document.getElementById(
  'dDismissPendingRefundBtn',
) as HTMLButtonElement | null;

// Cash Refund Action & Modal Elements
const txIssueRefundBtn = document.getElementById(
  'txIssueRefundBtn',
) as HTMLButtonElement | null;
const txIssueRefundBtnText = document.getElementById('txIssueRefundBtnText');

const txRefundModal = document.getElementById(
  'txRefundModal',
) as HTMLElement | null;
const txRefundCloseBtn = document.getElementById(
  'txRefundCloseBtn',
) as HTMLButtonElement | null;
const txRefundCancelBtn = document.getElementById(
  'txRefundCancelBtn',
) as HTMLButtonElement | null;
const txRefundSubmitBtn = document.getElementById(
  'txRefundSubmitBtn',
) as HTMLButtonElement | null;
const txRefundAmountInput = document.getElementById(
  'txRefundAmountInput',
) as HTMLInputElement | null;
const txRefundReasonInput = document.getElementById(
  'txRefundReasonInput',
) as HTMLInputElement | null;
const txRefundMaxHint = document.getElementById('txRefundMaxHint');
const txRefundProRatedDesc = document.getElementById('txRefundProRatedDesc');
const txRefundFullDesc = document.getElementById('txRefundFullDesc');
const txRefundTypeProRated = document.getElementById(
  'txRefundTypeProRated',
) as HTMLInputElement | null;
const txRefundTypeFull = document.getElementById(
  'txRefundTypeFull',
) as HTMLInputElement | null;
const txRefundTypeCustom = document.getElementById(
  'txRefundTypeCustom',
) as HTMLInputElement | null;

// Page Output Summary Modal Elements
const pageOutputReportBtn = document.getElementById(
  'pageOutputReportBtn',
) as HTMLButtonElement | null;
const pageOutputReportModal = document.getElementById(
  'pageOutputReportModal',
) as HTMLElement | null;
const pageReportScopeText = document.getElementById('pageReportScopeText');
const pageOutputCloseBtn = document.getElementById(
  'pageOutputCloseBtn',
) as HTMLButtonElement | null;
const pageOutputDismissBtn = document.getElementById(
  'pageOutputDismissBtn',
) as HTMLButtonElement | null;
const pageOutputPrintBtn = document.getElementById(
  'pageOutputPrintBtn',
) as HTMLButtonElement | null;
const pageOutputCsvBtn = document.getElementById(
  'pageOutputCsvBtn',
) as HTMLButtonElement | null;

// Financial Reconciliation Elements
const pageReportGrossCharged = document.getElementById(
  'pageReportGrossCharged',
);
const pageReportCashRefunds = document.getElementById('pageReportCashRefunds');
const pageReportRefundCount = document.getElementById('pageReportRefundCount');
const pageReportNetCash = document.getElementById('pageReportNetCash');
const pageReportOwedChange = document.getElementById('pageReportOwedChange');
const pageReportOwedCount = document.getElementById('pageReportOwedCount');

// Page Output Elements
const pageReportPagesRequested = document.getElementById(
  'pageReportPagesRequested',
);
const pageReportPagesPrinted = document.getElementById(
  'pageReportPagesPrinted',
);
const pageReportFulfillmentRate = document.getElementById(
  'pageReportFulfillmentRate',
);
const pageReportPagesFailed = document.getElementById('pageReportPagesFailed');
const pageReportColorPages = document.getElementById('pageReportColorPages');
const pageReportBwPages = document.getElementById('pageReportBwPages');

// Hardware Incidents Elements
const pageReportSpoolerFailures = document.getElementById(
  'pageReportSpoolerFailures',
);
const pageReportHopperShortfalls = document.getElementById(
  'pageReportHopperShortfalls',
);

let activePageOutputSummary: PageOutputSummaryResponse | null = null;

type RefundModalState = {
  transactionId: string;
  chargedAmount: number;
  maxRefundable: number;
  suggestedProRated: number;
  unprintedPages?: number;
  selectedType: 'pro_rated' | 'full' | 'custom';
};

let activeRefundState: RefundModalState | null = null;

const PAGE_SIZE = 20;
let refreshTimer: number | null = null;
let toastTimer: number | null = null;
let currentPage = 1;
let totalLogs = 0;
let allLogs: LogsResponse['logs'] = [];
let activeDrawerTransactionId: string | null = null;
let reportContext: TransactionContextPayload | null = null;
const transactionContextCache = new Map<string, TransactionContextPayload>();

type TransactionContextPayload = {
  transactionId: string;
  mode: string | null;
  chargedAmount: number | null;
  colorPages: number | null;
  bwPages: number | null;
  printConfiguration?: {
    documentName: string | null;
    paperSize: string | null;
    copies: number | null;
    colorMode: string | null;
    quality: string | null;
    duplex: boolean | null;
    orientation: string | null;
    pageRange: string | null;
  } | null;
  status: string | null;
  change: {
    requested: number | null;
    dispensed: number | null;
    remaining: number | null;
    state: string | null;
    attempts: number | null;
    owedChangeId: string | null;
    message: string | null;
  };
  settledAt: string | null;
  terminalAt: string | null;
  generatedAt: string;
  receipt: {
    available: boolean;
    expired: boolean;
    source: 'snapshot' | 'derived';
  };
  contextFlags: {
    hasIncompleteContext: boolean;
    hasReceiptSnapshot: boolean;
    hasTransactionLogs: boolean;
    missingTransactionMeta: boolean;
    missingReasons: string[];
  };
  settlement: {
    spoolerPhase: string | null;
    reconciliationAction: string | null;
    pendingRefundCount: number;
    hasOutstandingReview: boolean;
    hint: string | null;
  };
  spoolerLifecycle: {
    currentState: string | null;
    queuedAt: string | null;
    processingAt: string | null;
    printedAt: string | null;
    failedAt: string | null;
    transitions: {
      state: string;
      timestamp: string;
      reason: string | null;
      printerName: string | null;
      spoolerCorrelationKey: string | null;
      spoolerJobId: number | null;
      jobStatus: string | null;
      pagesPrinted: number | null;
      totalPages: number | null;
      meta: Record<string, string | number | boolean | null>;
    }[];
  } | null;
  pendingRefunds: {
    id: string;
    status: string;
    chargedAmount: number;
    reason: string;
    closedAt: string | null;
  }[];
  ledgerEntries: {
    id: string;
    eventType: string;
    amount: number;
    referenceId?: string | null;
    timestamp: string;
    source?: string | null;
  }[];
  relatedLogs: {
    id: string;
    type: string;
    message: string;
    timestamp: string;
    meta: Record<string, string | number | boolean | null>;
  }[];
};

type FilterState = {
  transactionId: string;
  mode: '' | 'print' | 'copy' | 'scan';
  status: '' | 'created' | 'processing' | 'completed' | 'failed' | 'refund';
  eventType: string;
  dateFrom: string;
  dateTo: string;
  quickFilter: 'all' | 'attention' | 'print' | 'copy' | 'scan';
};

type ReportCategory =
  | 'hardware'
  | 'software'
  | 'print'
  | 'copy'
  | 'scan'
  | 'payment'
  | 'network'
  | 'other';

const filterState = {
  transactionId: '',
  mode: '',
  status: '',
  eventType: '',
  dateFrom: '',
  dateTo: '',
  quickFilter: 'all',
} as FilterState;

function showToast(msg: string): void {
  setMessage(msg);
  if (!txToast) return;
  txToast.textContent = msg;
  txToast.classList.remove('hidden');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    txToast?.classList.add('hidden');
  }, 3500);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function copyToClipboard(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed || trimmed === '—') return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(trimmed);
      return true;
    }
  } catch {
    // Fall back to execCommand
  }
  try {
    const textArea = document.createElement('textarea');
    textArea.value = trimmed;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    textArea.style.pointerEvents = 'none';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    return successful;
  } catch {
    return false;
  }
}

function inferMode(log: LogsResponse['logs'][number]): string {
  const mode = log.meta?.mode;
  if (mode === 'print' || mode === 'copy' || mode === 'scan') {
    return mode;
  }
  const type = log.type.toLowerCase();
  if (type.startsWith('print_')) return 'print';
  if (type.startsWith('copy_')) return 'copy';
  if (type.startsWith('scan_')) return 'scan';
  return '—';
}

function inferStatus(log: LogsResponse['logs'][number]): string {
  if (typeof log.meta?.status === 'string' && log.meta.status) {
    return log.meta.status;
  }
  const type = log.type.toLowerCase();
  if (type.includes('fail') || type.includes('error')) return 'failed';
  if (type.includes('refund')) return 'refund';
  if (type.includes('completed') || type.includes('confirmed'))
    return 'completed';
  if (type.includes('start') || type.includes('process')) return 'processing';
  return 'completed';
}

function inferAmount(log: LogsResponse['logs'][number]): number | null {
  const m = log.meta;
  if (!m) return null;
  if (typeof m.chargedAmount === 'number') return m.chargedAmount;
  if (typeof m.amount === 'number') return m.amount;
  if (typeof m.price === 'number') return m.price;
  return null;
}

function inferChangeRemaining(log: LogsResponse['logs'][number]): number | null {
  const m = log.meta;
  if (!m) return null;
  if (typeof m.remaining === 'number') return m.remaining;
  if (typeof m.changeRemaining === 'number') return m.changeRemaining;
  return null;
}

function getTransactionContextId(
  log: LogsResponse['logs'][number],
): string | null {
  const transactionId = log.meta?.transactionId;
  if (typeof transactionId !== 'string') return null;
  const trimmed = transactionId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatMode(value: string | null): string {
  if (!value) return '—';
  return value.toUpperCase();
}

function formatStatus(value: string | null): string {
  if (!value) return '—';
  if (value === 'settled_pending_terminal')
    return 'pending terminal confirmation';
  if (value === 'refunded_pending_review') return 'refund pending review';
  return value.replace(/_/g, ' ');
}

function statusCssClass(status: string | null): string {
  if (!status) return 'completed';
  const s = status.toLowerCase();
  if (s.includes('fail') || s.includes('error')) return 'failed';
  if (s.includes('refund')) return 'refund';
  if (s.includes('process') || s.includes('pend')) return 'processing';
  return 'completed';
}

function formatPeso(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `₱${value.toFixed(2)}`;
}

function formatChangeState(value: string | null): string {
  if (!value) return 'none';
  if (value === 'failed') return 'dispense failed';
  if (value === 'dispensed') return 'dispensed';
  if (value === 'none') return 'none';
  return value.replace(/_/g, ' ');
}

function setField(target: HTMLElement | null, value: string): void {
  if (target) target.textContent = value;
}

function debounce<T extends (...args: never[]) => void>(
  fn: T,
  delayMs: number,
): (...args: Parameters<T>) => void {
  let timer: number | null = null;
  return (...args: Parameters<T>) => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delayMs);
  };
}

function updateActiveFilterCount(): void {
  if (!activeFilterCount) return;
  const count = Object.values(filterState).filter(
    (value) => value !== '' && value !== 'all',
  ).length;
  if (count > 0) {
    activeFilterCount.textContent = String(count);
    activeFilterCount.classList.remove('hidden');
  } else {
    activeFilterCount.classList.add('hidden');
  }
}

async function resolveApiErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
      return payload.error;
    }
  } catch {
    // Ignore parse errors and keep fallback message
  }
  return fallback;
}

function getFilteredLogs(): LogsResponse['logs'] {
  if (filterState.quickFilter === 'all') {
    return allLogs;
  }
  if (filterState.quickFilter === 'attention') {
    return allLogs.filter((log) => {
      const status = inferStatus(log);
      const remaining = inferChangeRemaining(log);
      const type = log.type.toLowerCase();
      return (
        status === 'failed' ||
        status === 'refund' ||
        (remaining != null && remaining > 0) ||
        type.includes('fail') ||
        type.includes('error') ||
        type.includes('refund')
      );
    });
  }
  if (
    filterState.quickFilter === 'print' ||
    filterState.quickFilter === 'copy' ||
    filterState.quickFilter === 'scan'
  ) {
    return allLogs.filter(
      (log) => inferMode(log).toLowerCase() === filterState.quickFilter,
    );
  }
  return allLogs;
}

function totalPages(): number {
  const filtered = getFilteredLogs();
  return Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
}

function updatePaginationControls(): void {
  const pages = totalPages();
  pageInfo.textContent = `Page ${currentPage} of ${pages}`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= pages;
}

function updateKpiRibbon(): void {
  if (kpiTotalCount) {
    kpiTotalCount.textContent = totalLogs.toLocaleString();
  }

  let totalSettled = 0;
  let discrepancyCount = 0;

  for (const log of allLogs) {
    const amt = inferAmount(log);
    if (amt != null) totalSettled += amt;

    const status = inferStatus(log);
    const rem = inferChangeRemaining(log);
    if (status === 'failed' || status === 'refund' || (rem != null && rem > 0)) {
      discrepancyCount++;
    }
  }

  if (kpiTotalAmount) {
    kpiTotalAmount.textContent = `₱${totalSettled.toFixed(2)}`;
  }
  if (kpiDiscrepancyCount) {
    kpiDiscrepancyCount.textContent = String(discrepancyCount);
  }
}

function middleTruncate(
  value: string,
  keepStart: number,
  keepEnd: number,
): string {
  if (value.length <= keepStart + keepEnd + 1) return value;
  return `${value.slice(0, keepStart)}…${value.slice(-keepEnd)}`;
}

function renderPage(): void {
  const filtered = getFilteredLogs();
  const start = (currentPage - 1) * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);
  applyLogs(slice);
  updatePaginationControls();

  // Asynchronously hydrate visible rows with exact backend context if cached or needed
  void enrichVisibleRows(slice);
}

async function enrichVisibleRows(slice: LogsResponse['logs']): Promise<void> {
  for (const log of slice) {
    const txId = getTransactionContextId(log);
    if (!txId) continue;

    // Check if already in cache
    let ctx = transactionContextCache.get(txId);
    if (!ctx) {
      try {
        ctx = await fetchTransactionContext(txId);
      } catch {
        continue;
      }
    }

    // Update table row if still visible
    const tr = logsBody.querySelector<HTMLTableRowElement>(
      `tr[data-log-id="${log.id}"]`,
    );
    if (!tr || !ctx) continue;

    const amountCell = tr.querySelector('.logs-td--amount');
    if (amountCell && ctx.chargedAmount != null) {
      amountCell.textContent = formatPeso(ctx.chargedAmount);
    }

    const statusCell = tr.querySelector('.logs-td--status');
    if (statusCell && ctx.status) {
      statusCell.innerHTML = `
        <span class="tx-status-badge tx-status-badge--${statusCssClass(ctx.status)}">
          ${escapeHtml(formatStatus(ctx.status))}
        </span>
      `;
    }

    const changeCell = tr.querySelector('.logs-td--change');
    if (changeCell) {
      const rem = ctx.change.remaining;
      if (rem != null && rem > 0) {
        changeCell.innerHTML = `<span class="tx-shortage-badge" title="Coin hopper shortage: ₱${rem.toFixed(2)} owed">Owed ₱${rem.toFixed(2)}</span>`;
      } else {
        changeCell.innerHTML = `<span class="tx-change-ok">Exact / Settled</span>`;
      }
    }
  }
}

function applyLogs(logs: LogsResponse['logs']): void {
  logsBody.innerHTML = '';

  if (logs.length === 0) {
    const tr = document.createElement('tr');
    if (filterState.transactionId) {
      tr.innerHTML = `
        <td colspan="7" style="text-align:center;color:var(--ink-muted);padding:36px">
          No transactions found matching "<strong>${escapeHtml(filterState.transactionId)}</strong>".
          <button type="button" id="emptyClearIdBtn" class="tx-text-btn">Clear search</button>
        </td>
      `;
      logsBody.appendChild(tr);
      const clearBtn = tr.querySelector('#emptyClearIdBtn');
      clearBtn?.addEventListener('click', () => {
        transactionIdInput.value = '';
        applyFilters();
      });
    } else {
      tr.innerHTML = `<td colspan="7" style="text-align:center;color:var(--ink-muted);padding:36px">No transaction log entries found.</td>`;
      logsBody.appendChild(tr);
    }
    return;
  }

  for (const log of logs) {
    const transactionContextId = getTransactionContextId(log);
    const cached = transactionContextId
      ? transactionContextCache.get(transactionContextId)
      : null;

    const mode = cached?.mode ?? inferMode(log);
    const status = cached?.status ?? inferStatus(log);
    const amount = cached?.chargedAmount ?? inferAmount(log);
    const changeRemaining =
      cached?.change?.remaining ?? inferChangeRemaining(log);

    const transactionIdCell = transactionContextId
      ? `<div class="tx-id-badge-wrap">
          <button
            type="button"
            class="tx-id-truncate tx-id-filter-btn"
            data-action="filter-by-id"
            data-tx-id="${escapeHtml(transactionContextId)}"
            title="Click to search by ID: ${escapeHtml(transactionContextId)}"
          >
            ${escapeHtml(middleTruncate(transactionContextId, 9, 6))}
          </button>
          <button
            type="button"
            class="tx-id-copy-btn"
            data-action="copy-id"
            data-tx-id="${escapeHtml(transactionContextId)}"
            title="Copy full Transaction ID"
            aria-label="Copy full Transaction ID"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12" aria-hidden="true">
              <path d="M4 2a2 2 0 00-2 2v8a2 2 0 002 2h6a2 2 0 002-2V4a2 2 0 00-2-2H4zm0 1h6a1 1 0 011 1v8a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1z"/>
              <path d="M6 0a2 2 0 00-2 2v1h1V2a1 1 0 011-1h6a1 1 0 011 1v8a1 1 0 01-1 1h-1v1h1a2 2 0 002-2V2a2 2 0 00-2-2H6z"/>
            </svg>
          </button>
        </div>`
      : '<span class="tx-context-missing">Missing ID context</span>';

    const modeBadge = `<span class="tx-mode-badge tx-mode-badge--${escapeHtml(mode.toLowerCase())}">${escapeHtml(formatMode(mode))}</span>`;

    const statusBadge = `
      <span class="tx-status-badge tx-status-badge--${statusCssClass(status)}">
        ${escapeHtml(formatStatus(status))}
      </span>
    `;

    const changeMarkup =
      changeRemaining != null && changeRemaining > 0
        ? `<span class="tx-shortage-badge" title="Coin hopper shortage: ₱${changeRemaining.toFixed(2)} unreturned">Owed ₱${changeRemaining.toFixed(2)}</span>`
        : `<span class="tx-change-ok">Exact / Settled</span>`;

    const actionMarkup = `
      <button class="tx-action-btn" data-action="view-details" data-transaction-id="${escapeHtml(transactionContextId ?? '')}" ${transactionContextId ? '' : 'disabled'}>
        Inspect
      </button>
    `;

    const tr = document.createElement('tr');
    tr.dataset.logId = log.id;
    tr.innerHTML = `
      <td class="logs-td logs-td--ts">
        <div>${new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
        <div style="font-size:11px;opacity:0.6">${new Date(log.timestamp).toLocaleDateString()}</div>
      </td>
      <td class="logs-td logs-td--id">${transactionIdCell}</td>
      <td class="logs-td logs-td--mode">${modeBadge}</td>
      <td class="logs-td logs-td--amount">${formatPeso(amount)}</td>
      <td class="logs-td logs-td--status">${statusBadge}</td>
      <td class="logs-td logs-td--change">${changeMarkup}</td>
      <td class="logs-td logs-td--actions">${actionMarkup}</td>
    `;
    logsBody.appendChild(tr);
  }
}

function toIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function buildFilterParams(includeLimit: boolean): URLSearchParams {
  const params = new URLSearchParams();
  if (includeLimit) params.set('limit', '1000');

  if (filterState.transactionId)
    params.set('transactionId', filterState.transactionId);
  if (filterState.mode) params.set('mode', filterState.mode);
  if (filterState.status) params.set('status', filterState.status);
  if (filterState.eventType) params.set('eventType', filterState.eventType);

  const isoFrom = toIso(filterState.dateFrom);
  if (isoFrom) params.set('dateFrom', isoFrom);

  const isoTo = toIso(filterState.dateTo);
  if (isoTo) params.set('dateTo', isoTo);

  return params;
}

function applyFilterStateFromInputs(): void {
  filterState.transactionId = transactionIdInput.value.trim();
  filterState.mode = modeFilter.value as FilterState['mode'];
  filterState.status = statusFilter.value as FilterState['status'];
  filterState.eventType = eventTypeInput.value.trim();
  filterState.dateFrom = dateFromInput.value;
  filterState.dateTo = dateToInput.value;
}

function resetFilterState(): void {
  filterState.transactionId = '';
  filterState.mode = '';
  filterState.status = '';
  filterState.eventType = '';
  filterState.dateFrom = '';
  filterState.dateTo = '';
  filterState.quickFilter = 'all';

  transactionIdInput.value = '';
  modeFilter.value = '';
  statusFilter.value = '';
  eventTypeInput.value = '';
  dateFromInput.value = '';
  dateToInput.value = '';

  quickChips.forEach((chip) => {
    chip.classList.toggle('tx-chip--active', chip.dataset.chip === 'all');
  });
}

async function loadData(): Promise<void> {
  const params = buildFilterParams(true);
  const res = await apiFetch(
    `/api/admin/logs/transactions?${params.toString()}`,
  );
  if (!res.ok) {
    const errorText = await resolveApiErrorMessage(
      res,
      'Failed to load transaction logs.',
    );
    throw new Error(errorText);
  }
  const data = (await res.json()) as LogsResponse;
  allLogs = data.logs;
  totalLogs = allLogs.length;
  if (currentPage > totalPages()) currentPage = totalPages();

  updateKpiRibbon();
  renderPage();
  await loadSummary();
}

async function loadSummary(): Promise<void> {
  const res = await apiFetch('/api/admin/summary');
  if (!res.ok) return;
  const summary = (await res.json()) as SummaryResponse;
  updateSidebarBadges(summary);
}

function applyFilters(options: { silent?: boolean } = {}): void {
  applyFilterStateFromInputs();
  updateActiveFilterCount();
  currentPage = 1;
  if (!options.silent) showToast('Applying transaction filters…');
  void loadData()
    .then(() => {
      if (!options.silent) showToast('Transaction filters applied.');
    })
    .catch((error: unknown) =>
      showToast(error instanceof Error ? error.message : 'Filter failed.'),
    );
}

const debouncedApplyFilters = debounce(
  () => applyFilters({ silent: true }),
  350,
);

function openTransactionDrawerShell(): void {
  txDrawerBackdrop?.classList.remove('is-leaving');
  txDetailDrawer?.classList.remove('is-leaving');
  txDrawerBackdrop?.classList.remove('hidden');
  txDetailDrawer?.classList.remove('hidden');
}

function closeTransactionDrawer(): void {
  activeDrawerTransactionId = null;
  if (txDrawerBackdrop && !txDrawerBackdrop.classList.contains('hidden')) {
    txDrawerBackdrop.classList.add('is-leaving');
    txDetailDrawer?.classList.add('is-leaving');
    window.setTimeout(() => {
      txDrawerBackdrop?.classList.add('hidden');
      txDetailDrawer?.classList.add('hidden');
      txDrawerBackdrop?.classList.remove('is-leaving');
      txDetailDrawer?.classList.remove('is-leaving');
    }, 200);
  } else {
    txDrawerBackdrop?.classList.add('hidden');
    txDetailDrawer?.classList.add('hidden');
  }
}

function resetDrawerView(): void {
  setField(dTransactionId, '—');
  setField(dMode, '—');
  setField(dAmount, '—');
  setField(dStatus, '—');
  setField(dDocumentName, '—');
  setField(dPaperSize, '—');
  setField(dCopies, '—');
  setField(dPrintSides, '—');
  setField(dQuality, '—');
  setField(dColorPages, '—');
  setField(dBwPages, '—');
  setField(dPagesPrinted, '—');
  setField(dChangeRequested, '—');
  setField(dChangeDispensed, '—');
  setField(dChangeRemaining, '—');
  setField(dChangeStatus, '—');
  setField(dChangeMessage, '—');
  setField(dSettledAt, '—');
  setField(dTerminalAt, '—');
  setField(dGeneratedAt, '—');
  setField(dContextHint, '—');
  if (txReceiptPdfBtn) txReceiptPdfBtn.disabled = true;
  if (dMissingReasons) dMissingReasons.innerHTML = '';
  if (dRelatedLogsBody) dRelatedLogsBody.innerHTML = '';

  if (dPageAuditCard) dPageAuditCard.classList.add('hidden');
  if (dOwedChangeCard) dOwedChangeCard.classList.add('hidden');
  if (dPendingRefundBanner) dPendingRefundBanner.classList.add('hidden');
  if (dConfirmPendingRefundBtn) {
    dConfirmPendingRefundBtn.disabled = false;
    dConfirmPendingRefundBtn.onclick = null;
  }
  if (dDismissPendingRefundBtn) {
    dDismissPendingRefundBtn.disabled = false;
    dDismissPendingRefundBtn.onclick = null;
  }
  if (txIssueRefundBtn) {
    txIssueRefundBtn.disabled = true;
    if (txIssueRefundBtnText) {
      txIssueRefundBtnText.textContent = 'Issue Cash Refund';
    } else {
      txIssueRefundBtn.textContent = 'Issue Cash Refund';
    }
    txIssueRefundBtn.title = '';
  }
  if (dLedgerBody) dLedgerBody.innerHTML = '';
  if (dLedgerCountBadge) dLedgerCountBadge.textContent = '0';
  if (dResolveOwedChangeBtn) {
    dResolveOwedChangeBtn.disabled = false;
    dResolveOwedChangeBtn.onclick = null;
  }
  if (dAuditRefundActionBtn) {
    dAuditRefundActionBtn.onclick = null;
  }
}

async function fetchTransactionContext(
  transactionId: string,
): Promise<TransactionContextPayload> {
  const cached = transactionContextCache.get(transactionId);
  if (cached) return cached;

  const res = await apiFetch(
    `/api/admin/transactions/${encodeURIComponent(transactionId)}/context`,
  );
  if (!res.ok) {
    const fallback =
      res.status === 404
        ? `Transaction ${transactionId} no longer has resolvable context.`
        : 'Failed to load transaction details.';
    const message = await resolveApiErrorMessage(res, fallback);
    throw new Error(message);
  }
  const payload = (await res.json()) as TransactionContextPayload;
  transactionContextCache.set(transactionId, payload);
  return payload;
}

function resolveSpoolerPagesPrinted(context: TransactionContextPayload): {
  pagesPrinted: number | null;
  totalPages: number | null;
} {
  const transitions = context.spoolerLifecycle?.transitions ?? [];
  const lastPrinted = [...transitions]
    .reverse()
    .find((t) => t.state === 'printed' && (t.pagesPrinted != null || t.totalPages != null));
  if (lastPrinted) {
    return {
      pagesPrinted: lastPrinted.pagesPrinted ?? null,
      totalPages: lastPrinted.totalPages ?? null,
    };
  }
  const lastWithCounts = [...transitions]
    .reverse()
    .find((t) => t.pagesPrinted != null || t.totalPages != null);
  if (lastWithCounts) {
    return {
      pagesPrinted: lastWithCounts.pagesPrinted ?? null,
      totalPages: lastWithCounts.totalPages ?? null,
    };
  }
  const anyPrinted = [...transitions]
    .reverse()
    .find((t) => t.state === 'printed');
  return {
    pagesPrinted: anyPrinted?.pagesPrinted ?? null,
    totalPages: anyPrinted?.totalPages ?? null,
  };
}

function renderDrawerRelatedLogs(context: TransactionContextPayload): void {
  if (!dRelatedLogsBody) return;
  dRelatedLogsBody.innerHTML = '';
  if (context.relatedLogs.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="3" style="color:var(--ink-muted);padding:9px">No related logs found.</td>`;
    dRelatedLogsBody.appendChild(row);
    return;
  }
  for (const entry of context.relatedLogs.slice(0, 20)) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(formatDate(entry.timestamp))}</td>
      <td>${escapeHtml(entry.type)}</td>
      <td>${escapeHtml(entry.message)}</td>
    `;
    dRelatedLogsBody.appendChild(row);
  }
}

function renderDrawer(context: TransactionContextPayload): void {
  const { pagesPrinted, totalPages } = resolveSpoolerPagesPrinted(context);

  setField(dTransactionId, context.transactionId);
  setField(dMode, formatMode(context.mode));
  setField(dAmount, formatPeso(context.chargedAmount));
  setField(dStatus, formatStatus(context.status));
  setField(dDocumentName, context.printConfiguration?.documentName ?? '—');
  setField(dPaperSize, context.printConfiguration?.paperSize ?? '—');
  setField(
    dCopies,
    context.printConfiguration?.copies != null
      ? String(context.printConfiguration.copies)
      : '—',
  );
  setField(
    dPrintSides,
    context.printConfiguration?.duplex != null
      ? context.printConfiguration.duplex
        ? '2-Sided (Duplex)'
        : '1-Sided (Simplex)'
      : '—',
  );
  setField(
    dQuality,
    context.printConfiguration?.quality
      ? context.printConfiguration.quality === 'high'
        ? 'High Quality'
        : 'Standard'
      : '—',
  );
  setField(
    dColorPages,
    context.colorPages != null ? String(context.colorPages) : '—',
  );
  setField(dBwPages, context.bwPages != null ? String(context.bwPages) : '—');
  setField(
    dPagesPrinted,
    pagesPrinted != null
      ? totalPages != null
        ? `${pagesPrinted} of ${totalPages}`
        : `${pagesPrinted}`
      : '—',
  );
  setField(dChangeRequested, formatPeso(context.change.requested));
  setField(dChangeDispensed, formatPeso(context.change.dispensed));
  setField(dChangeRemaining, formatPeso(context.change.remaining));
  setField(dChangeStatus, formatChangeState(context.change.state));
  setField(dChangeMessage, context.change.message ?? '—');
  setField(dSettledAt, formatDate(context.settledAt));
  setField(dTerminalAt, formatDate(context.terminalAt));
  setField(dGeneratedAt, formatDate(context.generatedAt));
  const hint =
    context.settlement.hint ??
    (context.contextFlags.hasIncompleteContext
      ? 'Some transaction context is incomplete.'
      : 'Transaction context is complete.');
  setField(dContextHint, hint);

  // E-Receipt button state
  if (txReceiptPdfBtn) {
    txReceiptPdfBtn.disabled = !context.transactionId;
  }

  if (dMissingReasons) {
    dMissingReasons.innerHTML = '';
    if (context.contextFlags.missingReasons.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No missing context flags.';
      dMissingReasons.appendChild(li);
    } else {
      for (const reason of context.contextFlags.missingReasons) {
        const li = document.createElement('li');
        li.textContent = reason;
        dMissingReasons.appendChild(li);
      }
    }
  }

  renderDrawerPendingRefund(context);
  renderDrawerRefundAction(context);
  renderDrawerPageAudit(context, pagesPrinted, totalPages);
  renderDrawerOwedChange(context);
  renderDrawerLedger(context);
  renderDrawerRelatedLogs(context);
}

function renderDrawerPendingRefund(context: TransactionContextPayload): void {
  if (!dPendingRefundBanner) return;

  const openRefund = (context.pendingRefunds ?? []).find(
    (entry) => entry.status === 'open',
  );

  if (openRefund) {
    setField(dPendingRefundAmount, formatPeso(openRefund.chargedAmount));
    setField(
      dPendingRefundReason,
      openRefund.reason || 'Customer refund requested',
    );
    dPendingRefundBanner.classList.remove('hidden');

    if (dConfirmPendingRefundBtn) {
      dConfirmPendingRefundBtn.disabled = false;
      dConfirmPendingRefundBtn.onclick = async () => {
        dConfirmPendingRefundBtn.disabled = true;
        if (dDismissPendingRefundBtn) dDismissPendingRefundBtn.disabled = true;
        showToast('Confirming physical cash handed to customer…');

        try {
          const res = await apiFetch(
            `/api/admin/pending-refunds/${encodeURIComponent(openRefund.id)}/refund`,
            {
              method: 'POST',
              body: JSON.stringify({ restoreBalance: false }),
            },
          );

          if (!res.ok) {
            const err = await resolveApiErrorMessage(
              res,
              'Failed to process pending refund.',
            );
            showToast(err);
            dConfirmPendingRefundBtn.disabled = false;
            if (dDismissPendingRefundBtn) {
              dDismissPendingRefundBtn.disabled = false;
            }
            return;
          }

          showToast(
            `Physical cash refund of ${formatPeso(openRefund.chargedAmount)} confirmed.`,
          );
          transactionContextCache.delete(context.transactionId);
          if (activeDrawerTransactionId === context.transactionId) {
            const fresh = await fetchTransactionContext(context.transactionId);
            renderDrawer(fresh);
            reportContext = fresh;
          }
          void loadData();
        } catch (e: unknown) {
          dConfirmPendingRefundBtn.disabled = false;
          if (dDismissPendingRefundBtn) {
            dDismissPendingRefundBtn.disabled = false;
          }
          showToast(
            e instanceof Error
              ? e.message
              : 'Network error processing pending refund.',
          );
        }
      };
    }

    if (dDismissPendingRefundBtn) {
      dDismissPendingRefundBtn.disabled = false;
      dDismissPendingRefundBtn.onclick = async () => {
        if (dConfirmPendingRefundBtn) dConfirmPendingRefundBtn.disabled = true;
        dDismissPendingRefundBtn.disabled = true;
        showToast('Dismissing customer refund request…');

        try {
          const res = await apiFetch(
            `/api/admin/pending-refunds/${encodeURIComponent(openRefund.id)}/dismiss`,
            { method: 'POST' },
          );

          if (!res.ok) {
            const err = await resolveApiErrorMessage(
              res,
              'Failed to dismiss pending refund.',
            );
            showToast(err);
            if (dConfirmPendingRefundBtn) {
              dConfirmPendingRefundBtn.disabled = false;
            }
            dDismissPendingRefundBtn.disabled = false;
            return;
          }

          showToast('Customer refund request dismissed.');
          transactionContextCache.delete(context.transactionId);
          if (activeDrawerTransactionId === context.transactionId) {
            const fresh = await fetchTransactionContext(context.transactionId);
            renderDrawer(fresh);
            reportContext = fresh;
          }
          void loadData();
        } catch (e: unknown) {
          if (dConfirmPendingRefundBtn) {
            dConfirmPendingRefundBtn.disabled = false;
          }
          dDismissPendingRefundBtn.disabled = false;
          showToast(
            e instanceof Error
              ? e.message
              : 'Network error dismissing pending refund.',
          );
        }
      };
    }
  } else {
    dPendingRefundBanner.classList.add('hidden');
    if (dConfirmPendingRefundBtn) dConfirmPendingRefundBtn.onclick = null;
    if (dDismissPendingRefundBtn) dDismissPendingRefundBtn.onclick = null;
  }
}

function renderDrawerRefundAction(context: TransactionContextPayload): void {
  if (!txIssueRefundBtn) return;

  const maxRefundable = calculateMaxRefundable(
    context.chargedAmount,
    context.ledgerEntries,
    context.pendingRefunds,
    context.transactionId,
  );

  const charged = context.chargedAmount ?? 0;

  if (charged > 0 && maxRefundable <= 0) {
    if (txIssueRefundBtnText) {
      txIssueRefundBtnText.textContent = 'Fully Refunded';
    } else {
      txIssueRefundBtn.textContent = 'Fully Refunded';
    }
    txIssueRefundBtn.disabled = true;
    txIssueRefundBtn.title = 'This transaction has been fully refunded';
  } else if (charged <= 0 || !context.transactionId) {
    if (txIssueRefundBtnText) {
      txIssueRefundBtnText.textContent = 'Issue Cash Refund';
    } else {
      txIssueRefundBtn.textContent = 'Issue Cash Refund';
    }
    txIssueRefundBtn.disabled = true;
    txIssueRefundBtn.title = 'No refundable amount charged';
  } else {
    if (txIssueRefundBtnText) {
      txIssueRefundBtnText.textContent = 'Issue Cash Refund';
    } else {
      txIssueRefundBtn.textContent = 'Issue Cash Refund';
    }
    txIssueRefundBtn.disabled = false;
    txIssueRefundBtn.title = `Issue physical cash refund (Up to ${formatPeso(maxRefundable)})`;
  }
}

function renderDrawerPageAudit(
  context: TransactionContextPayload,
  pagesPrinted: number | null,
  totalPages: number | null,
): void {
  if (!dPageAuditCard) return;

  const colorPages = context.colorPages ?? 0;
  const bwPages = context.bwPages ?? 0;
  const configCopies = context.printConfiguration?.copies ?? 1;
  const requestedFromConfig =
    colorPages + bwPages > 0 ? (colorPages + bwPages) * configCopies : null;

  const requested = totalPages ?? requestedFromConfig ?? null;
  const printed = pagesPrinted;

  if (
    requested != null &&
    requested > 0 &&
    printed != null &&
    printed < requested &&
    context.chargedAmount != null &&
    context.chargedAmount > 0
  ) {
    const unprinted = Math.max(0, requested - printed);
    const suggestedRefund = calculateSuggestedRefund(
      requested,
      printed,
      context.chargedAmount,
    );
    const maxRefundable = calculateMaxRefundable(
      context.chargedAmount,
      context.ledgerEntries,
      context.pendingRefunds,
      context.transactionId,
    );

    setField(dAuditRequestedPages, String(requested));
    setField(dAuditPrintedPages, String(printed));
    setField(
      dAuditUnprintedPages,
      `${unprinted} page${unprinted === 1 ? '' : 's'}`,
    );
    setField(dAuditChargedAmount, formatPeso(context.chargedAmount));
    setField(dAuditSuggestedRefund, formatPeso(suggestedRefund));

    dPageAuditCard.dataset.suggestedRefund = String(suggestedRefund);
    dPageAuditCard.dataset.unprintedPages = String(unprinted);
    dPageAuditCard.classList.remove('hidden');

    if (dAuditRefundActionBtn) {
      if (maxRefundable <= 0) {
        dAuditRefundActionBtn.disabled = true;
        dAuditRefundActionBtn.textContent = 'Fully Refunded';
        dAuditRefundActionBtn.onclick = null;
      } else {
        dAuditRefundActionBtn.disabled = false;
        dAuditRefundActionBtn.textContent = 'Issue Pro-Rated Refund';
        dAuditRefundActionBtn.onclick = () => {
          window.dispatchEvent(
            new CustomEvent('printbit:initiate-refund', {
              detail: {
                transactionId: context.transactionId,
                suggestedAmount: suggestedRefund,
                unprintedPages: unprinted,
                reason: `Print shortfall: ${unprinted} of ${requested} pages unprinted`,
              },
            }),
          );
        };
      }
    }
  } else {
    dPageAuditCard.classList.add('hidden');
    if (dAuditRefundActionBtn) dAuditRefundActionBtn.onclick = null;
  }
}

function renderDrawerOwedChange(context: TransactionContextPayload): void {
  if (!dOwedChangeCard) return;

  const remaining = context.change.remaining ?? 0;
  const owedChangeId = context.change.owedChangeId;

  if (remaining > 0 && owedChangeId) {
    setField(dOwedChangeCardAmount, formatPeso(remaining));
    setField(dOwedChangeCardId, owedChangeId);
    setField(dOwedChangeCardState, formatChangeState(context.change.state));
    setField(
      dOwedChangeCardReason,
      context.change.message ?? 'Coin hopper shortfall',
    );
    dOwedChangeCard.classList.remove('hidden');

    if (dResolveOwedChangeBtn) {
      dResolveOwedChangeBtn.disabled = false;
      dResolveOwedChangeBtn.onclick = async () => {
        dResolveOwedChangeBtn.disabled = true;
        showToast('Resolving owed change…');
        try {
          const res = await apiFetch(
            `/api/admin/owed-changes/${encodeURIComponent(owedChangeId)}/resolve`,
            { method: 'POST' },
          );
          if (!res.ok) {
            const err = await resolveApiErrorMessage(
              res,
              'Failed to resolve owed change.',
            );
            showToast(err);
            dResolveOwedChangeBtn.disabled = false;
            return;
          }
          showToast(
            `Owed change of ${formatPeso(remaining)} marked as handed to customer.`,
          );
          transactionContextCache.delete(context.transactionId);
          if (activeDrawerTransactionId === context.transactionId) {
            const fresh = await fetchTransactionContext(context.transactionId);
            renderDrawer(fresh);
            reportContext = fresh;
          }
          void loadData();
        } catch (e: unknown) {
          dResolveOwedChangeBtn.disabled = false;
          showToast(
            e instanceof Error
              ? e.message
              : 'Network error while resolving owed change.',
          );
        }
      };
    }
  } else {
    dOwedChangeCard.classList.add('hidden');
    if (dResolveOwedChangeBtn) dResolveOwedChangeBtn.onclick = null;
  }
}

function renderDrawerLedger(context: TransactionContextPayload): void {
  if (!dLedgerBody) return;
  dLedgerBody.innerHTML = '';
  const entries = context.ledgerEntries ?? [];
  if (dLedgerCountBadge) {
    dLedgerCountBadge.textContent = String(entries.length);
  }

  if (entries.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="4" style="color:var(--ink-muted);padding:9px;text-align:center">No financial ledger entries recorded for this transaction.</td>`;
    dLedgerBody.appendChild(row);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement('tr');
    const isRefund = entry.eventType === 'refund_issued';
    const amountClass = isRefund
      ? 'tx-ledger-amount--refund'
      : 'tx-ledger-amount--credit';
    const amountPrefix = isRefund ? '- ' : '+ ';
    row.innerHTML = `
      <td>${escapeHtml(formatDate(entry.timestamp))}</td>
      <td><span class="tx-ledger-badge tx-ledger-badge--${escapeHtml(entry.eventType)}">${escapeHtml(entry.eventType.replace(/_/g, ' '))}</span></td>
      <td class="${amountClass}">${amountPrefix}${escapeHtml(formatPeso(entry.amount))}</td>
      <td>${escapeHtml(entry.source ?? 'financial_ledger')}</td>
    `;
    dLedgerBody.appendChild(row);
  }
}

async function openTransactionDrawer(transactionId: string): Promise<void> {
  activeDrawerTransactionId = transactionId;
  openTransactionDrawerShell();
  resetDrawerView();
  if (txDetailState) txDetailState.textContent = 'Loading transaction context…';

  try {
    const context = await fetchTransactionContext(transactionId);
    if (activeDrawerTransactionId !== transactionId) return;
    renderDrawer(context);
    reportContext = context;
    if (txDetailState) {
      txDetailState.textContent = context.contextFlags.hasIncompleteContext
        ? 'Context loaded with missing fields flagged below.'
        : 'Context loaded.';
    }
  } catch (error: unknown) {
    if (activeDrawerTransactionId !== transactionId) return;
    if (txDetailState) {
      txDetailState.textContent =
        error instanceof Error ? error.message : 'Failed to load context.';
    }
    showToast(
      error instanceof Error
        ? error.message
        : 'Failed to load transaction context.',
    );
  }
}

function openReportModal(): void {
  if (!txReportModal) return;
  txReportModal.classList.remove('is-leaving');
  txReportModal.classList.remove('hidden');

  if (reportContext) {
    if (txReportTitleInput) {
      txReportTitleInput.value = `[${reportContext.transactionId}] Hardware / settlement anomaly`;
    }
    if (txReportDescriptionInput) {
      txReportDescriptionInput.value = `Transaction: ${reportContext.transactionId}\nMode: ${reportContext.mode ?? 'unknown'}\nCharged: ${formatPeso(reportContext.chargedAmount)}\nOwed: ${formatPeso(reportContext.change.remaining)}\nStatus: ${reportContext.status ?? 'unknown'}\n\nStudent / Machine notes: `;
    }
  }
}

function closeReportModal(): void {
  if (txReportModal && !txReportModal.classList.contains('hidden')) {
    txReportModal.classList.add('is-leaving');
    window.setTimeout(() => {
      txReportModal?.classList.add('hidden');
      txReportModal?.classList.remove('is-leaving');
    }, 200);
  } else {
    txReportModal?.classList.add('hidden');
  }
}

async function submitQuickReport(): Promise<void> {
  if (!reportContext) {
    showToast('No transaction context loaded for report creation.');
    return;
  }
  const title = txReportTitleInput?.value.trim() ?? '';
  const description = txReportDescriptionInput?.value.trim() ?? '';
  const category = (txReportCategoryInput?.value ?? 'other') as ReportCategory;
  if (!title) {
    showToast('Report title is required.');
    return;
  }
  if (!description) {
    showToast('Report description is required.');
    return;
  }

  if (txReportSubmitBtn) txReportSubmitBtn.disabled = true;
  showToast('Submitting escalation report…');
  try {
    const transactionId = reportContext.transactionId;
    const response = await apiFetch('/api/admin/report-issues', {
      method: 'POST',
      body: JSON.stringify({
        title,
        description,
        category,
        meta: {
          source: 'admin_transaction_logs',
          transactionId: reportContext.transactionId,
          mode: reportContext.mode,
          status: reportContext.status,
          chargedAmount: reportContext.chargedAmount,
          settledAt: reportContext.settledAt,
          terminalAt: reportContext.terminalAt,
          hasIncompleteContext: reportContext.contextFlags.hasIncompleteContext,
          pendingRefundCount: reportContext.settlement.pendingRefundCount,
        },
      }),
    });

    if (!response.ok) {
      const message = await resolveApiErrorMessage(
        response,
        'Failed to submit report.',
      );
      showToast(message);
      if (txReportSubmitBtn) txReportSubmitBtn.disabled = false;
      return;
    }

    closeReportModal();
    showToast(`Report created for transaction ${transactionId}.`);
    if (txReportSubmitBtn) txReportSubmitBtn.disabled = false;
  } catch {
    if (txReportSubmitBtn) txReportSubmitBtn.disabled = false;
    showToast('Network error while submitting report.');
  }
}

function setRefundRadioType(type: 'pro_rated' | 'full' | 'custom'): void {
  if (txRefundTypeProRated) txRefundTypeProRated.checked = type === 'pro_rated';
  if (txRefundTypeFull) txRefundTypeFull.checked = type === 'full';
  if (txRefundTypeCustom) txRefundTypeCustom.checked = type === 'custom';
  if (activeRefundState) {
    activeRefundState.selectedType = type;
  }
}

function handleRefundRadioChange(type: 'pro_rated' | 'full' | 'custom'): void {
  if (!activeRefundState) return;
  activeRefundState.selectedType = type;
  const max = activeRefundState.maxRefundable;

  if (type === 'pro_rated') {
    const amount = Math.min(activeRefundState.suggestedProRated, max);
    if (txRefundAmountInput) txRefundAmountInput.value = amount.toFixed(2);
    if (txRefundReasonInput) {
      txRefundReasonInput.value = activeRefundState.unprintedPages
        ? `Print shortfall: ${activeRefundState.unprintedPages} pages unprinted`
        : 'Print shortfall cash refund';
    }
    validateRefundAmount();
  } else if (type === 'full') {
    if (txRefundAmountInput) txRefundAmountInput.value = max.toFixed(2);
    if (txRefundReasonInput) {
      txRefundReasonInput.value = 'Full cash refund';
    }
    validateRefundAmount();
  } else if (type === 'custom') {
    if (txRefundAmountInput) {
      txRefundAmountInput.focus();
      txRefundAmountInput.select();
    }
    validateRefundAmount();
  }
}

function handleRefundAmountInput(): void {
  if (!activeRefundState) return;
  const val = parseFloat(txRefundAmountInput?.value ?? '');
  const max = activeRefundState.maxRefundable;
  const proRated = Math.min(activeRefundState.suggestedProRated, max);

  if (Number.isFinite(val)) {
    if (Math.abs(val - max) < 0.001) {
      setRefundRadioType('full');
    } else if (
      activeRefundState.suggestedProRated > 0 &&
      Math.abs(val - proRated) < 0.001
    ) {
      setRefundRadioType('pro_rated');
    } else {
      setRefundRadioType('custom');
    }
  }
  validateRefundAmount();
}

function validateRefundAmount(): boolean {
  if (!activeRefundState) return false;
  const max = activeRefundState.maxRefundable;
  const raw = txRefundAmountInput?.value ?? '';
  const amount = parseFloat(raw);

  if (!raw || !Number.isFinite(amount) || amount <= 0) {
    if (txRefundMaxHint) {
      txRefundMaxHint.textContent = `Max refundable: ${formatPeso(max)}`;
      txRefundMaxHint.classList.remove('tx-refund-max-hint--error');
    }
    if (txRefundSubmitBtn) txRefundSubmitBtn.disabled = true;
    return false;
  }

  if (Math.round(amount * 100) > Math.round(max * 100)) {
    if (txRefundMaxHint) {
      txRefundMaxHint.textContent = `Exceeds max refundable (${formatPeso(max)})`;
      txRefundMaxHint.classList.add('tx-refund-max-hint--error');
    }
    if (txRefundSubmitBtn) txRefundSubmitBtn.disabled = true;
    return false;
  }

  if (txRefundMaxHint) {
    txRefundMaxHint.textContent = `Max refundable: ${formatPeso(max)}`;
    txRefundMaxHint.classList.remove('tx-refund-max-hint--error');
  }
  if (txRefundSubmitBtn) txRefundSubmitBtn.disabled = false;
  return true;
}

function openRefundModal(options?: {
  suggestedAmount?: number;
  unprintedPages?: number;
  reason?: string;
  mode?: 'pro_rated' | 'full' | 'custom';
}): void {
  if (!reportContext) {
    showToast('No transaction context loaded for refund.');
    return;
  }
  const tx = reportContext;
  const maxRefundable = calculateMaxRefundable(
    tx.chargedAmount,
    tx.ledgerEntries,
    tx.pendingRefunds,
    tx.transactionId,
  );

  if (maxRefundable <= 0) {
    showToast('This transaction is already fully refunded.');
    return;
  }

  // Determine suggested pro-rated amount and unprinted pages if shortfall
  const { pagesPrinted, totalPages } = resolveSpoolerPagesPrinted(tx);
  const colorPages = tx.colorPages ?? 0;
  const bwPages = tx.bwPages ?? 0;
  const configCopies = tx.printConfiguration?.copies ?? 1;
  const requestedFromConfig =
    colorPages + bwPages > 0 ? (colorPages + bwPages) * configCopies : null;
  const requested = totalPages ?? requestedFromConfig ?? null;
  const printed = pagesPrinted;

  let suggestedProRated = options?.suggestedAmount ?? 0;
  let unprintedPages = options?.unprintedPages;

  if (
    suggestedProRated <= 0 &&
    requested != null &&
    requested > 0 &&
    printed != null &&
    printed < requested &&
    tx.chargedAmount != null &&
    tx.chargedAmount > 0
  ) {
    unprintedPages = Math.max(0, requested - printed);
    suggestedProRated = calculateSuggestedRefund(
      requested,
      printed,
      tx.chargedAmount,
    );
  }

  // Determine default mode
  let initialMode: 'pro_rated' | 'full' | 'custom' = options?.mode ?? 'custom';
  if (!options?.mode) {
    if (suggestedProRated > 0 && suggestedProRated <= maxRefundable) {
      initialMode = 'pro_rated';
    } else {
      initialMode = 'full';
    }
  }

  activeRefundState = {
    transactionId: tx.transactionId,
    chargedAmount: tx.chargedAmount ?? 0,
    maxRefundable,
    suggestedProRated,
    unprintedPages,
    selectedType: initialMode,
  };

  // Configure UI hints and labels
  if (txRefundMaxHint) {
    txRefundMaxHint.textContent = `Max refundable: ${formatPeso(maxRefundable)}`;
    txRefundMaxHint.classList.remove('tx-refund-max-hint--error');
  }

  if (txRefundFullDesc) {
    txRefundFullDesc.textContent = formatPeso(maxRefundable);
  }

  if (txRefundProRatedDesc) {
    if (suggestedProRated > 0) {
      txRefundProRatedDesc.textContent = `${formatPeso(Math.min(suggestedProRated, maxRefundable))} (${unprintedPages ?? 0} unprinted)`;
      if (txRefundTypeProRated) txRefundTypeProRated.disabled = false;
    } else {
      txRefundProRatedDesc.textContent = 'No page shortfall';
      if (txRefundTypeProRated) {
        txRefundTypeProRated.disabled = true;
        if (initialMode === 'pro_rated') initialMode = 'full';
      }
    }
  }

  setRefundRadioType(initialMode);

  const initialAmount =
    initialMode === 'pro_rated'
      ? Math.min(suggestedProRated, maxRefundable)
      : initialMode === 'full'
        ? maxRefundable
        : Math.min(
            suggestedProRated > 0 ? suggestedProRated : maxRefundable,
            maxRefundable,
          );

  if (txRefundAmountInput) {
    txRefundAmountInput.value =
      initialAmount > 0 ? initialAmount.toFixed(2) : '';
  }

  if (txRefundReasonInput) {
    if (options?.reason) {
      txRefundReasonInput.value = options.reason;
    } else if (initialMode === 'pro_rated') {
      txRefundReasonInput.value = unprintedPages
        ? `Print shortfall: ${unprintedPages} of ${requested ?? unprintedPages} pages unprinted`
        : 'Print shortfall cash refund';
    } else if (initialMode === 'full') {
      txRefundReasonInput.value = 'Full cash refund';
    } else {
      txRefundReasonInput.value = '';
    }
  }

  if (txRefundSubmitBtn) {
    txRefundSubmitBtn.disabled =
      initialAmount <= 0 || initialAmount > maxRefundable;
  }

  txRefundModal?.classList.remove('is-leaving');
  txRefundModal?.classList.remove('hidden');
}

function closeRefundModal(): void {
  activeRefundState = null;
  if (txRefundModal && !txRefundModal.classList.contains('hidden')) {
    txRefundModal.classList.add('is-leaving');
    window.setTimeout(() => {
      txRefundModal?.classList.add('hidden');
      txRefundModal?.classList.remove('is-leaving');
    }, 200);
  } else {
    txRefundModal?.classList.add('hidden');
  }
}

async function submitPhysicalCashRefund(): Promise<void> {
  if (!activeRefundState) {
    showToast('No active refund state.');
    return;
  }
  const { transactionId, maxRefundable, selectedType, unprintedPages } =
    activeRefundState;
  const rawAmount = txRefundAmountInput?.value ?? '';
  const amount = Math.round(parseFloat(rawAmount) * 100) / 100;

  if (!Number.isFinite(amount) || amount <= 0) {
    showToast('Please enter a valid refund amount greater than 0.');
    return;
  }

  if (Math.round(amount * 100) > Math.round(maxRefundable * 100)) {
    showToast(
      `Refund amount cannot exceed maximum refundable amount (${formatPeso(maxRefundable)}).`,
    );
    return;
  }

  const reason =
    txRefundReasonInput?.value.trim() || 'Admin physical cash refund';

  const body: { amount: number; reason: string; unprintedPages?: number } = {
    amount,
    reason,
  };
  if (
    selectedType === 'pro_rated' &&
    typeof unprintedPages === 'number' &&
    unprintedPages >= 0
  ) {
    body.unprintedPages = unprintedPages;
  }

  if (txRefundSubmitBtn) txRefundSubmitBtn.disabled = true;
  showToast('Processing physical cash refund…');

  try {
    const res = await apiFetch(
      `/api/admin/transactions/${encodeURIComponent(transactionId)}/refund`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const err = await resolveApiErrorMessage(
        res,
        'Failed to process cash refund.',
      );
      showToast(err);
      if (txRefundSubmitBtn) txRefundSubmitBtn.disabled = false;
      return;
    }

    const fresh = (await res.json()) as TransactionContextPayload;
    showToast(`Physical cash refund of ${formatPeso(amount)} recorded.`);
    closeRefundModal();

    transactionContextCache.set(transactionId, fresh);
    if (activeDrawerTransactionId === transactionId) {
      renderDrawer(fresh);
      reportContext = fresh;
    }
    void loadData();
  } catch (error: unknown) {
    if (txRefundSubmitBtn) txRefundSubmitBtn.disabled = false;
    showToast(
      error instanceof Error
        ? error.message
        : 'Network error processing cash refund.',
    );
  }
}

async function openPageOutputReportModal(): Promise<void> {
  if (pageOutputReportBtn) pageOutputReportBtn.disabled = true;
  showToast('Loading page output summary…');

  try {
    const params = buildFilterParams(false);
    const queryString = params.toString() ? `?${params.toString()}` : '';
    const res = await apiFetch(
      `/api/admin/logs/transactions/page-output-summary${queryString}`,
    );

    if (!res.ok) {
      const err = await resolveApiErrorMessage(
        res,
        'Failed to load page output summary.',
      );
      showToast(err);
      return;
    }

    const data = (await res.json()) as PageOutputSummaryResponse;
    activePageOutputSummary = data;

    // Scope
    setField(pageReportScopeText, formatReportScope(data.scope));

    // Financials
    setField(pageReportGrossCharged, formatPeso(data.financials.grossCharged));
    setField(
      pageReportCashRefunds,
      formatPeso(data.financials.cashRefundsIssued),
    );
    setField(
      pageReportRefundCount,
      `${data.financials.refundCount} ${data.financials.refundCount === 1 ? 'refund' : 'refunds'}`,
    );
    setField(pageReportNetCash, formatPeso(data.financials.netCashRetained));
    setField(
      pageReportOwedChange,
      formatPeso(data.financials.unresolvedOwedChange),
    );
    setField(
      pageReportOwedCount,
      `${data.financials.unresolvedOwedChangeCount} ${data.financials.unresolvedOwedChangeCount === 1 ? 'incident' : 'incidents'}`,
    );

    // Page Production
    setField(
      pageReportPagesRequested,
      data.pages.totalRequested.toLocaleString(),
    );
    setField(
      pageReportPagesPrinted,
      data.pages.totalPrinted.toLocaleString(),
    );
    setField(
      pageReportPagesFailed,
      data.pages.totalFailed.toLocaleString(),
    );
    setField(
      pageReportColorPages,
      data.pages.colorPagesPrinted.toLocaleString(),
    );
    setField(
      pageReportBwPages,
      data.pages.bwPagesPrinted.toLocaleString(),
    );

    if (pageReportFulfillmentRate) {
      pageReportFulfillmentRate.textContent = `${data.pages.fulfillmentRatePercent}%`;
      pageReportFulfillmentRate.classList.remove(
        'page-report-rate-badge--good',
        'page-report-rate-badge--warn',
        'page-report-rate-badge--alert',
      );
      const badgeClass = getFulfillmentBadgeClass(
        data.pages.fulfillmentRatePercent,
      );
      pageReportFulfillmentRate.classList.add(badgeClass);
    }

    // Incidents
    setField(
      pageReportSpoolerFailures,
      data.hardwareIncidents.spoolerFailures.toLocaleString(),
    );
    setField(
      pageReportHopperShortfalls,
      data.hardwareIncidents.hopperShortfalls.toLocaleString(),
    );

    pageOutputReportModal?.classList.remove('is-leaving');
    pageOutputReportModal?.classList.remove('hidden');
    showToast('Page output summary loaded.');
  } catch (error: unknown) {
    showToast(
      error instanceof Error
        ? error.message
        : 'Network error loading page output summary.',
    );
  } finally {
    if (pageOutputReportBtn) pageOutputReportBtn.disabled = false;
  }
}

function closePageOutputReportModal(): void {
  if (
    pageOutputReportModal &&
    !pageOutputReportModal.classList.contains('hidden')
  ) {
    pageOutputReportModal.classList.add('is-leaving');
    window.setTimeout(() => {
      pageOutputReportModal?.classList.add('hidden');
      pageOutputReportModal?.classList.remove('is-leaving');
    }, 200);
  } else {
    pageOutputReportModal?.classList.add('hidden');
  }
}

function exportPageOutputCsv(): void {
  if (!activePageOutputSummary) {
    showToast('No page output summary data available to export.');
    return;
  }
  showToast('Preparing summary CSV export…');
  try {
    const csvContent = generatePageOutputCsv(activePageOutputSummary);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `printbit-page-output-summary-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Page output summary CSV exported.');
  } catch (error: unknown) {
    showToast(
      error instanceof Error
        ? error.message
        : 'Failed to export page output summary CSV.',
    );
  }
}

// ── Event Handlers ──────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', () => {
  showToast('Refreshing transaction logs…');
  void loadData()
    .then(() => showToast('Transaction logs refreshed.'))
    .catch((e: unknown) =>
      showToast(e instanceof Error ? e.message : 'Refresh failed.'),
    );
});

exportLogsBtn.addEventListener('click', () => {
  showToast('Preparing transaction CSV export…');
  const params = buildFilterParams(false);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  void apiFetch(`/api/admin/logs/transactions/export.csv${suffix}`)
    .then(async (response) => {
      if (!response.ok) throw new Error('Failed to export transaction logs.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `printbit-admin-transaction-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      showToast('Transaction logs CSV exported.');
    })
    .catch((error: unknown) => {
      const msg =
        error instanceof Error
          ? error.message
          : 'Failed to export transaction logs.';
      showToast(msg);
    });
});

function showRefreshError(error: unknown): void {
  showToast(
    error instanceof Error ? error.message : 'Automatic refresh failed.',
  );
}

applyFiltersBtn.addEventListener('click', () => applyFilters());

clearFiltersBtn.addEventListener('click', () => {
  resetFilterState();
  updateActiveFilterCount();
  currentPage = 1;
  showToast('Filters reset.');
  renderPage();
});

// Quick Filter Chips Handling
quickChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    const chipType = (chip.dataset.chip ?? 'all') as FilterState['quickFilter'];
    filterState.quickFilter = chipType;

    quickChips.forEach((c) => {
      c.classList.toggle('tx-chip--active', c === chip);
    });

    currentPage = 1;
    renderPage();
  });
});

// Live Debounced Search
transactionIdInput.addEventListener('input', debouncedApplyFilters);
eventTypeInput.addEventListener('input', debouncedApplyFilters);
modeFilter.addEventListener('change', () => applyFilters());
statusFilter.addEventListener('change', () => applyFilters());
dateFromInput.addEventListener('change', () => applyFilters());
dateToInput.addEventListener('change', () => applyFilters());

prevPageBtn.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    renderPage();
  }
});

nextPageBtn.addEventListener('click', () => {
  if (currentPage < totalPages()) {
    currentPage++;
    renderPage();
  }
});

logsBody.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const actionButton = target.closest<HTMLButtonElement>('[data-action]');
  if (!actionButton) return;

  const action = actionButton.dataset.action;
  const transactionId = (
    actionButton.dataset.transactionId ??
    actionButton.dataset.txId ??
    ''
  ).trim();

  if (action === 'view-details') {
    if (!transactionId) {
      showToast('Missing transaction context for this log row.');
      return;
    }
    void openTransactionDrawer(transactionId);
    return;
  }

  if (action === 'copy-id') {
    if (!transactionId) return;
    void copyToClipboard(transactionId).then((ok) => {
      if (ok) {
        actionButton.classList.add('copied');
        actionButton.title = 'Copied!';
        showToast('Transaction ID copied to clipboard.');
        window.setTimeout(() => {
          actionButton.classList.remove('copied');
          actionButton.title = 'Copy full Transaction ID';
        }, 1500);
      } else {
        showToast('Failed to copy ID to clipboard.');
      }
    });
    return;
  }

  if (action === 'filter-by-id') {
    if (!transactionId) return;
    transactionIdInput.value = transactionId;
    applyFilters();
    return;
  }
});

// Drawer Button Listeners
dCopyTxIdBtn?.addEventListener('click', () => {
  const text = (
    reportContext?.transactionId ??
    dTransactionId?.textContent ??
    ''
  ).trim();
  if (!text || text === '—') return;
  void copyToClipboard(text).then((ok) => {
    if (ok) {
      dCopyTxIdBtn.classList.add('copied');
      showToast('Transaction ID copied to clipboard.');
      window.setTimeout(() => {
        dCopyTxIdBtn?.classList.remove('copied');
      }, 1500);
    } else {
      showToast('Failed to copy ID to clipboard.');
    }
  });
});
txDetailCloseBtn?.addEventListener('click', closeTransactionDrawer);
txDrawerDoneBtn?.addEventListener('click', closeTransactionDrawer);
txDrawerBackdrop?.addEventListener('click', closeTransactionDrawer);

txReceiptPdfBtn?.addEventListener('click', () => {
  if (!reportContext?.transactionId) return;
  const url = `/api/admin/transactions/${encodeURIComponent(reportContext.transactionId)}/receipt/pdf`;
  window.open(url, '_blank');
});

txReportIssueBtn?.addEventListener('click', () => {
  openReportModal();
});

txIssueRefundBtn?.addEventListener('click', () => {
  openRefundModal();
});

window.addEventListener('printbit:initiate-refund', ((event: CustomEvent) => {
  const detail = event.detail as
    | {
        transactionId?: string;
        suggestedAmount?: number;
        unprintedPages?: number;
        reason?: string;
      }
    | undefined;

  if (
    detail?.transactionId &&
    reportContext?.transactionId !== detail.transactionId
  ) {
    void openTransactionDrawer(detail.transactionId).then(() => {
      openRefundModal({
        suggestedAmount: detail?.suggestedAmount,
        unprintedPages: detail?.unprintedPages,
        reason: detail?.reason,
        mode: detail?.suggestedAmount ? 'pro_rated' : 'full',
      });
    });
    return;
  }

  openRefundModal({
    suggestedAmount: detail?.suggestedAmount,
    unprintedPages: detail?.unprintedPages,
    reason: detail?.reason,
    mode: detail?.suggestedAmount ? 'pro_rated' : 'full',
  });
}) as EventListener);

// Incident Report Modal Listeners
txReportCloseBtn?.addEventListener('click', closeReportModal);
txReportCancelBtn?.addEventListener('click', closeReportModal);
txReportModal?.addEventListener('click', (event) => {
  if (event.target === txReportModal) closeReportModal();
});
txReportSubmitBtn?.addEventListener('click', () => void submitQuickReport());

// Physical Cash Refund Modal Listeners
txRefundCloseBtn?.addEventListener('click', closeRefundModal);
txRefundCancelBtn?.addEventListener('click', closeRefundModal);
txRefundModal?.addEventListener('click', (event) => {
  if (event.target === txRefundModal) closeRefundModal();
});
txRefundSubmitBtn?.addEventListener('click', () => void submitPhysicalCashRefund());

txRefundTypeProRated?.addEventListener('change', () => {
  if (txRefundTypeProRated.checked) handleRefundRadioChange('pro_rated');
});
txRefundTypeFull?.addEventListener('change', () => {
  if (txRefundTypeFull.checked) handleRefundRadioChange('full');
});
txRefundTypeCustom?.addEventListener('change', () => {
  if (txRefundTypeCustom.checked) handleRefundRadioChange('custom');
});

txRefundAmountInput?.addEventListener('input', handleRefundAmountInput);

const handleRefundInputKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void submitPhysicalCashRefund();
  }
};
txRefundAmountInput?.addEventListener('keydown', handleRefundInputKeydown);
txRefundReasonInput?.addEventListener('keydown', handleRefundInputKeydown);

// Page Output Summary Modal Listeners
pageOutputReportBtn?.addEventListener('click', () => {
  void openPageOutputReportModal();
});
pageOutputCloseBtn?.addEventListener('click', closePageOutputReportModal);
pageOutputDismissBtn?.addEventListener('click', closePageOutputReportModal);
pageOutputReportModal?.addEventListener('click', (event) => {
  if (event.target === pageOutputReportModal) closePageOutputReportModal();
});
pageOutputPrintBtn?.addEventListener('click', () => {
  window.print();
});
pageOutputCsvBtn?.addEventListener('click', exportPageOutputCsv);

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (
      pageOutputReportModal &&
      !pageOutputReportModal.classList.contains('hidden')
    ) {
      closePageOutputReportModal();
    } else if (txReportModal && !txReportModal.classList.contains('hidden')) {
      closeReportModal();
    } else if (txRefundModal && !txRefundModal.classList.contains('hidden')) {
      closeRefundModal();
    } else if (
      txDrawerBackdrop &&
      !txDrawerBackdrop.classList.contains('hidden')
    ) {
      closeTransactionDrawer();
    }
  }
});

// On mobile, collapse filters panel by default
if (txFiltersPanel && window.matchMedia('(max-width: 700px)').matches) {
  txFiltersPanel.open = false;
}

initAuth(async (signal) => {
  await loadData();
  if (signal.aborted) return;
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(
    () => void loadData().catch(showRefreshError),
    10_000,
  );
});
