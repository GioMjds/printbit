import {
  LogsResponse,
  SummaryResponse,
  apiFetch,
  setMessage,
  initAuth,
  updateSidebarBadges,
} from '../shared';

// Socket.io client is loaded via <script src="/socket.io/socket.io.js">
declare const io: (opts?: {
  auth?: Record<string, string>;
  reconnectionDelay?: number;
}) => {
  on(event: string, cb: (...args: unknown[]) => void): void;
  disconnect(): void;
};

const logsBody = typeof document !== 'undefined' ? (document.getElementById('logsBody') as HTMLElement) : (null as unknown as HTMLElement);
const refreshBtn = typeof document !== 'undefined' ? (document.getElementById('refreshBtn') as HTMLButtonElement) : (null as unknown as HTMLButtonElement);
const exportLogsBtn = typeof document !== 'undefined' ? (document.getElementById('exportLogsBtn') as HTMLButtonElement) : (null as unknown as HTMLButtonElement);
const clearLogsBtn = typeof document !== 'undefined' ? (document.getElementById('clearLogsBtn') as HTMLButtonElement) : (null as unknown as HTMLButtonElement);
const prevPageBtn = typeof document !== 'undefined' ? (document.getElementById('prevPageBtn') as HTMLButtonElement) : (null as unknown as HTMLButtonElement);
const nextPageBtn = typeof document !== 'undefined' ? (document.getElementById('nextPageBtn') as HTMLButtonElement) : (null as unknown as HTMLButtonElement);
const pageInfo = typeof document !== 'undefined' ? (document.getElementById('pageInfo') as HTMLElement) : (null as unknown as HTMLElement);

const PAGE_SIZE = 20;
let refreshTimer: number | null = null;
let currentPage = 1;
let allLogs: LogsResponse['logs'] = [];
let socket: ReturnType<typeof io> | null = null;

type LogFilter = 'all' | 'node' | 'worker' | 'error';
let activeFilter: LogFilter = 'all';

export function inferLogBadge(type: string, message: string): { label: string; className: string } {
  const normType = (type || '').toLowerCase();
  const normMsg = (message || '').toLowerCase();

  if (normType.includes('error') || normType.includes('fail') || normMsg.startsWith('[error]')) {
    return { label: 'ERROR', className: 'log-badge--error' };
  }
  if (normType.includes('warn') || normMsg.startsWith('[warn]')) {
    return { label: 'WARN', className: 'log-badge--warn' };
  }
  if (normType.includes('print') || normMsg.startsWith('[print]')) {
    return { label: 'PRINT', className: 'log-badge--print' };
  }
  if (normType.includes('coin') || normType.includes('bill') || normType.includes('money') || normMsg.startsWith('[coin]')) {
    return { label: 'COIN', className: 'log-badge--coin' };
  }
  if (normType.includes('info') || normMsg.startsWith('[info]')) {
    return { label: 'INFO', className: 'log-badge--info' };
  }
  const label = normType ? normType.toUpperCase() : 'SYSTEM';
  return { label, className: 'log-badge--system' };
}

export function inferLogSource(log: LogsResponse['logs'][number]): { label: string; className: string } {
  const src = (log.meta?.source as string | undefined)?.toLowerCase();
  const normType = (log.type || '').toLowerCase();

  if (
    src === 'worker' ||
    src === 'spooler' ||
    src === 'worker-return-pipe' ||
    normType.startsWith('worker_') ||
    normType.startsWith('printer_')
  ) {
    return { label: 'WORKER', className: 'log-badge--worker' };
  }

  return { label: 'NODE', className: 'log-badge--node' };
}

function matchesFilter(log: LogsResponse['logs'][number]): boolean {
  if (activeFilter === 'all') return true;
  const isWorker =
    log.meta?.source === 'Worker' ||
    log.meta?.source === 'spooler' ||
    log.meta?.source === 'worker-return-pipe' ||
    log.type.startsWith('worker_') ||
    log.type.startsWith('printer_');

  if (activeFilter === 'worker') return isWorker;
  if (activeFilter === 'node') return !isWorker;
  if (activeFilter === 'error') {
    const badge = inferLogBadge(log.type, log.message);
    return badge.label === 'ERROR' || badge.label === 'WARN';
  }
  return true;
}

function getFilteredLogs(): LogsResponse['logs'] {
  return allLogs.filter(matchesFilter);
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

function renderPage(): void {
  const filtered = getFilteredLogs();
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (currentPage > pages) currentPage = pages;
  const start = (currentPage - 1) * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);
  applyLogs(slice);
  updatePaginationControls();
}

function applyLogs(logs: LogsResponse['logs']): void {
  logsBody.innerHTML = '';

  if (logs.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'logs-empty';
    tr.innerHTML = `<td colspan="2" style="text-align:center;color:var(--ink-muted);padding:24px">No log entries matching filter.</td>`;
    logsBody.appendChild(tr);
    return;
  }

  for (const log of logs) {
    const badge = inferLogBadge(log.type, log.message);
    const source = inferLogSource(log);
    const tr = document.createElement('tr');
    tr.dataset.logId = log.id;
    tr.innerHTML = `
      <td class="logs-td logs-td--ts" data-label="Timestamp">${new Date(log.timestamp).toLocaleString()}</td>
      <td class="logs-td logs-td--msg" data-label="Message">
        <div class="logs-msg-wrap">
          <span class="log-badge ${source.className}">${escapeHtml(source.label)}</span>
          <span class="log-badge ${badge.className}">${escapeHtml(badge.label)}</span>
          <span class="logs-msg-text">${escapeHtml(log.message)}</span>
        </div>
      </td>
    `;
    logsBody.appendChild(tr);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function connectSocket(): void {
  if (typeof io !== 'function' || socket) return;
  const pin = sessionStorage.getItem('adminPin') ?? '';
  try {
    socket = io({ auth: { pin }, reconnectionDelay: 2000 });
    socket.on('admin:new_log', (entry: unknown) => {
      if (!entry || typeof entry !== 'object') return;
      const logEntry = entry as LogsResponse['logs'][number];
      // Prevent duplicates
      if (allLogs.some((l) => l.id === logEntry.id)) return;
      allLogs.unshift(logEntry);
      if (allLogs.length > 3000) allLogs.pop();
      // Render immediately if on page 1
      if (currentPage === 1) {
        renderPage();
      } else {
        updatePaginationControls();
      }
    });
  } catch (err) {
    console.warn('[LOGS] Failed to establish Socket.IO connection:', err);
  }
}

async function loadData(): Promise<void> {
  const params = new URLSearchParams({ limit: '1000' });
  const res = await apiFetch(`/api/admin/logs/system?${params.toString()}`);
  if (!res.ok) {
    if (res.status === 401) throw new Error('Invalid admin PIN.');
    throw new Error('Failed to load system logs.');
  }
  const data = (await res.json()) as LogsResponse;
  allLogs = data.logs;
  renderPage();
  await loadSummary();
}

async function loadSummary(): Promise<void> {
  const res = await apiFetch('/api/admin/summary');
  if (!res.ok) return;
  const summary = (await res.json()) as SummaryResponse;
  updateSidebarBadges(summary);
}

async function clearAllLogs(): Promise<void> {
  if (!confirm('Delete ALL system log entries? This cannot be undone.')) return;
  setMessage('Clearing system logs…');
  const res = await apiFetch('/api/admin/logs/system', { method: 'DELETE' });
  if (!res.ok) {
    setMessage('Failed to clear system logs.');
    return;
  }
  allLogs = [];
  currentPage = 1;
  renderPage();
  setMessage('All system logs cleared.');
}

function showRefreshError(error: unknown): void {
  setMessage(
    error instanceof Error ? error.message : 'Automatic refresh failed.',
  );
}

if (typeof document !== 'undefined') {
  // Filter chips
  document.querySelectorAll<HTMLButtonElement>('.logs-filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.logs-filter-chip').forEach((c) => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      activeFilter = (chip.dataset.filter as LogFilter) || 'all';
      currentPage = 1;
      renderPage();
    });
  });

  refreshBtn?.addEventListener('click', () => {
    setMessage('Refreshing...');
    void loadData()
      .then(() => setMessage('System logs refreshed.'))
      .catch((e: unknown) =>
        setMessage(e instanceof Error ? e.message : 'Refresh failed.'),
      );
  });

  exportLogsBtn?.addEventListener('click', () => {
    setMessage('Preparing system logs export...');
    void apiFetch('/api/admin/logs/system/export.csv')
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to export system logs.');
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `printbit-admin-system-logs-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        setMessage('System logs exported.');
      })
      .catch((error: unknown) => {
        const msg =
          error instanceof Error ? error.message : 'Failed to export system logs.';
        setMessage(msg);
      });
  });

  clearLogsBtn?.addEventListener('click', () => {
    void clearAllLogs().catch(showRefreshError);
  });

  prevPageBtn?.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      renderPage();
    }
  });

  nextPageBtn?.addEventListener('click', () => {
    if (currentPage < totalPages()) {
      currentPage++;
      renderPage();
    }
  });

  initAuth(async (signal) => {
    connectSocket();
    await loadData();
    if (signal.aborted) return;
    if (refreshTimer !== null) window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(
      () => void loadData().catch(showRefreshError),
      10_000,
    );
  });
}
