import {
  SummaryResponse,
  apiFetch,
  initAuth,
  setMessage,
  updateSidebarBadges,
} from '../shared';

interface AnomalyIncident {
  id: string;
  type: string;
  source: string;
  category:
    | 'printer'
    | 'spooler'
    | 'serial'
    | 'hopper'
    | 'network'
    | 'security';
  severity: 'warning' | 'critical';
  status: 'open' | 'acknowledged' | 'resolved';
  message: string;
  context?: Record<string, string | number | boolean | null>;
  occurrenceCount: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

interface AnomalyListResponse {
  total: number;
  openCount: number;
  acknowledgedCount: number;
  resolvedCount: number;
  items: AnomalyIncident[];
}

const incidentList = document.getElementById('incidentList') as HTMLElement;
const filterBar = document.getElementById('filterBar') as HTMLElement;
const refreshBtn = document.getElementById('refreshBtn') as HTMLButtonElement;
const prevPageBtn = document.getElementById('prevPageBtn') as HTMLButtonElement;
const nextPageBtn = document.getElementById('nextPageBtn') as HTMLButtonElement;
const pageInfo = document.getElementById('pageInfo') as HTMLElement;
const statTotal = document.getElementById('statTotal') as HTMLElement;
const statOpen = document.getElementById('statOpen') as HTMLElement;
const statAck = document.getElementById('statAck') as HTMLElement;
const statResolved = document.getElementById('statResolved') as HTMLElement;
const openAlertBadge = document.getElementById('openAlertBadge') as HTMLElement;
const openAlertBadgeMob = document.getElementById(
  'openAlertBadgeMob',
) as HTMLElement | null;

const detailOverlay = document.getElementById('detailOverlay') as HTMLElement;
const detailTitle = document.getElementById('detailTitle') as HTMLElement;
const detailBody = document.getElementById('detailBody') as HTMLElement;
const closeDetail = document.getElementById('closeDetail') as HTMLButtonElement;
const detailAckBtn = document.getElementById(
  'detailAckBtn',
) as HTMLButtonElement;
const detailResolveBtn = document.getElementById(
  'detailResolveBtn',
) as HTMLButtonElement;
const detailReopenBtn = document.getElementById(
  'detailReopenBtn',
) as HTMLButtonElement;

const PAGE_SIZE = 10;
let currentPage = 1;
let totalItems = 0;
let activeFilter: 'active' | 'archived' | 'all' = 'active';
let activeDetailId: string | null = null;
let poller: number | null = null;

function escHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showRefreshError(error: unknown): void {
  setMessage(
    error instanceof Error ? error.message : 'Automatic refresh failed.',
  );
}

function totalPages(): number {
  return Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
}

function updatePagination(): void {
  pageInfo.textContent = `Page ${currentPage} of ${totalPages()}`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= totalPages();
}

function updateStats(data: AnomalyListResponse): void {
  statTotal.textContent = String(data.total);
  statOpen.textContent = String(data.openCount);
  statAck.textContent = String(data.acknowledgedCount);
  statResolved.textContent = String(data.resolvedCount);
  const openText = data.openCount > 0 ? String(data.openCount) : '';
  openAlertBadge.textContent = openText;
  if (openAlertBadgeMob) openAlertBadgeMob.textContent = openText;
}

function renderIncidents(items: AnomalyIncident[]): void {
  incidentList.innerHTML = '';
  if (items.length === 0) {
    incidentList.innerHTML =
      '<div class="ri-empty"><div class="ri-empty__icon">📟</div><p>No anomalies found.</p></div>';
    return;
  }

  for (const item of items) {
    const card = document.createElement('div');
    card.className = `ri-card ri-card--${item.severity}`;
    card.innerHTML = `
      <div class="ri-card__accent"></div>
      <div class="ri-card__body">
        <div class="ri-card__meta">
          <span class="ri-card__time">${new Date(item.lastDetectedAt).toLocaleString()}</span>
          <span class="ri-badge ri-badge--${item.status}">${escHtml(item.status)}</span>
          <span class="ri-badge ri-badge--${item.severity}">${escHtml(item.severity)}</span>
          <span class="ri-badge ri-badge--cat">${escHtml(item.category)}</span>
        </div>
        <p class="ri-card__title">${escHtml(item.type)}</p>
        <p class="ri-card__desc">${escHtml(item.message)}</p>
        <div class="ri-card__actions">
          <button class="ri-action-btn" data-action="view" data-id="${escHtml(item.id)}">View</button>
        </div>
      </div>
    `;
    incidentList.appendChild(card);
  }

  incidentList
    .querySelectorAll<HTMLButtonElement>('[data-action="view"]')
    .forEach((button) => {
      button.addEventListener('click', () => {
        void openDetail(button.dataset.id!).catch(showRefreshError);
      });
    });
}

async function loadData(): Promise<void> {
  const offset = (currentPage - 1) * PAGE_SIZE;
  const viewParam = `&view=${activeFilter}`;
  const response = await apiFetch(
    `/api/admin/anomaly-incidents?limit=${PAGE_SIZE}&offset=${offset}${viewParam}`,
  );
  if (!response.ok) {
    throw new Error('Failed to load anomaly incidents.');
  }

  const data = (await response.json()) as AnomalyListResponse;
  totalItems = data.total;
  const lastPage = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  if (currentPage > lastPage) {
    currentPage = lastPage;
    return loadData();
  }
  renderIncidents(data.items);
  updateStats(data);
  updatePagination();
  await loadSummary();
}

async function loadSummary(): Promise<void> {
  try {
    const res = await apiFetch('/api/admin/summary');
    if (!res.ok) return;
    const summary = (await res.json()) as SummaryResponse;
    updateSidebarBadges(summary);
  } catch (error) {
    console.error('Error loading summary in alerts:', error, { cause: error });
  }
}

async function openDetail(id: string): Promise<void> {
  activeDetailId = id;
  const response = await apiFetch(`/api/admin/anomaly-incidents/${id}`);
  if (!response.ok) {
    setMessage('Failed to load incident detail.');
    return;
  }
  const payload = (await response.json()) as { incident: AnomalyIncident };
  const incident = payload.incident;
  detailTitle.textContent = `${incident.type} (${incident.status})`;
  detailBody.innerHTML = `
    <dl class="ri-detail-grid">
      <dt>Type</dt><dd>${escHtml(incident.type)}</dd>
      <dt>Message</dt><dd>${escHtml(incident.message)}</dd>
      <dt>Severity</dt><dd>${escHtml(incident.severity)}</dd>
      <dt>Status</dt><dd>${escHtml(incident.status)}</dd>
      <dt>Category</dt><dd>${escHtml(incident.category)}</dd>
      <dt>Source</dt><dd>${escHtml(incident.source)}</dd>
      <dt>Occurrences</dt><dd>${incident.occurrenceCount}</dd>
      <dt>First seen</dt><dd>${new Date(incident.firstDetectedAt).toLocaleString()}</dd>
      <dt>Last seen</dt><dd>${new Date(incident.lastDetectedAt).toLocaleString()}</dd>
      <dt>Acknowledged</dt><dd>${incident.acknowledgedAt ? new Date(incident.acknowledgedAt).toLocaleString() : '—'}</dd>
      <dt>Resolved</dt><dd>${incident.resolvedAt ? new Date(incident.resolvedAt).toLocaleString() : '—'}</dd>
    </dl>
    ${
      incident.context
        ? `<pre class="ri-context">${escHtml(
            JSON.stringify(incident.context, null, 2),
          )}</pre>`
        : ''
    }
  `;

  detailAckBtn.classList.toggle('hidden', incident.status !== 'open');
  detailResolveBtn.classList.toggle('hidden', incident.status === 'resolved');
  detailReopenBtn.classList.toggle('hidden', incident.status === 'open');

  detailOverlay.classList.remove('is-leaving');
  detailOverlay.classList.remove('hidden');
}

async function updateStatus(
  status: 'open' | 'acknowledged' | 'resolved',
): Promise<void> {
  if (!activeDetailId) return;
  const response = await apiFetch(
    `/api/admin/anomaly-incidents/${activeDetailId}/status`,
    { method: 'PATCH', body: JSON.stringify({ status }) },
  );
  if (!response.ok) {
    setMessage('Failed to update status.');
    return;
  }
  await loadData();
  closeDetailModal();
  setMessage('Incident status updated.');
}

function closeDetailModal(): void {
  activeDetailId = null;
  if (detailOverlay && !detailOverlay.classList.contains('hidden')) {
    detailOverlay.classList.add('is-leaving');
    window.setTimeout(() => {
      detailOverlay.classList.add('hidden');
      detailOverlay.classList.remove('is-leaving');
    }, 200);
  } else {
    detailOverlay?.classList.add('hidden');
  }
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && detailOverlay && !detailOverlay.classList.contains('hidden')) {
    closeDetailModal();
  }
});

refreshBtn.addEventListener('click', () => {
  setMessage('Refreshing...');
  void loadData()
    .then(() => setMessage('Alerts refreshed.'))
    .catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : 'Refresh failed.'),
    );
});

filterBar
  .querySelectorAll<HTMLButtonElement>('.filter-btn')
  .forEach((button) => {
    button.addEventListener('click', () => {
      activeFilter = button.dataset.filter as typeof activeFilter;
      currentPage = 1;
      filterBar
        .querySelectorAll('.filter-btn')
        .forEach((btn) => btn.classList.remove('filter-btn--active'));
      button.classList.add('filter-btn--active');
      void loadData().catch(showRefreshError);
    });
  });

prevPageBtn.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage -= 1;
    void loadData().catch(showRefreshError);
  }
});

nextPageBtn.addEventListener('click', () => {
  if (currentPage < totalPages()) {
    currentPage += 1;
    void loadData().catch(showRefreshError);
  }
});

closeDetail.addEventListener('click', closeDetailModal);
detailOverlay.addEventListener('click', (event) => {
  if (event.target === detailOverlay) closeDetailModal();
});

detailAckBtn.addEventListener('click', () => {
  void updateStatus('acknowledged').catch(showRefreshError);
});
detailResolveBtn.addEventListener('click', () => {
  void updateStatus('resolved').catch(showRefreshError);
});
detailReopenBtn.addEventListener('click', () => {
  void updateStatus('open').catch(showRefreshError);
});

interface AdminAlertsSocket {
  on(event: string, cb: (...args: unknown[]) => void): void;
  off?(event: string, cb: (...args: unknown[]) => void): void;
  disconnect(): void;
}

declare const io: (opts?: {
  auth?: Record<string, string>;
  reconnectionDelay?: number;
}) => AdminAlertsSocket;

let socket: AdminAlertsSocket | null = null;

const handleSocketIncident = (): void => {
  void loadData().catch(showRefreshError);
};

const handleSocketCount = (payload: unknown): void => {
  const openCount =
    payload &&
    typeof payload === 'object' &&
    'openCount' in payload &&
    typeof (payload as { openCount: unknown }).openCount === 'number'
      ? (payload as { openCount: number }).openCount
      : 0;
  const openText = openCount > 0 ? String(openCount) : '';
  openAlertBadge.textContent = openText;
  if (openAlertBadgeMob) openAlertBadgeMob.textContent = openText;
};

function disconnectSocket(target: AdminAlertsSocket | null): void {
  if (!target) return;
  target.off?.('adminAnomalyIncident', handleSocketIncident);
  target.off?.('adminAnomalyCount', handleSocketCount);
  target.disconnect();
}

function cleanupLiveUpdates(): void {
  if (poller !== null) {
    window.clearInterval(poller);
    poller = null;
  }
  disconnectSocket(socket);
  socket = null;
}

function connectSocket(): void {
  if (socket) return;

  // Defensive: if a stale socket slipped through, tear it down before recreating.
  cleanupLiveUpdates();
  if (socket) return;

  const token = sessionStorage.getItem('adminSessionToken') ?? '';
  const nextSocket = io({ auth: { token }, reconnectionDelay: 2000 });
  nextSocket.on('adminAnomalyIncident', handleSocketIncident);
  nextSocket.on('adminAnomalyCount', handleSocketCount);
  socket = nextSocket;
}

initAuth(async (signal) => {
  cleanupLiveUpdates();
  await loadData();
  if (signal.aborted) return;
  connectSocket();
  poller = window.setInterval(
    () => void loadData().catch(showRefreshError),
    10_000,
  );
});

document
  .getElementById('logoutBtn')
  ?.addEventListener('click', cleanupLiveUpdates);
window.addEventListener('pagehide', cleanupLiveUpdates);
