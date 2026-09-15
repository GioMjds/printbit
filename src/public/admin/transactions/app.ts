import {
  LogsResponse,
  SummaryResponse,
  apiFetch,
  setMessage,
  initAuth,
  updateSidebarBadges,
} from '../shared';

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
    transitions: Array<{
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
    }>;
  } | null;
  pendingRefunds: Array<{
    id: string;
    status: string;
    chargedAmount: number;
    reason: string;
    closedAt: string | null;
  }>;
  ledgerEntries: Array<{
    id: string;
    eventType: string;
    amount: number;
    timestamp: string;
  }>;
  relatedLogs: Array<{
    id: string;
    type: string;
    message: string;
    timestamp: string;
    meta: Record<string, string | number | boolean | null>;
  }>;
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

const filterState: FilterState = {
  transactionId: '',
  mode: '',
  status: '',
  eventType: '',
  dateFrom: '',
  dateTo: '',
  quickFilter: 'all',
};

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
    .find((t) => t.state === 'printed');
  return {
    pagesPrinted: lastPrinted?.pagesPrinted ?? null,
    totalPages: lastPrinted?.totalPages ?? null,
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

  renderDrawerRelatedLogs(context);
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

// Modal Listeners
txReportCloseBtn?.addEventListener('click', closeReportModal);
txReportCancelBtn?.addEventListener('click', closeReportModal);
txReportModal?.addEventListener('click', (event) => {
  if (event.target === txReportModal) closeReportModal();
});
txReportSubmitBtn?.addEventListener('click', () => void submitQuickReport());

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (txReportModal && !txReportModal.classList.contains('hidden')) {
      closeReportModal();
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
