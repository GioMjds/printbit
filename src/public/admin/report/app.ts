import { apiFetch, setMessage, initAuth } from '../shared';

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface ReportIssueEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  title: string;
  description: string;
  category: string;
  status: 'open' | 'acknowledged' | 'resolved';
  attachmentIds: string[];
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

interface AttachmentMeta {
  id: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  timestamp: string;
}

interface ListResponse {
  total: number;
  items: ReportIssueEntry[];
}

interface DetailResponse {
  issue: ReportIssueEntry;
  attachments: AttachmentMeta[];
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const reportList = document.getElementById('reportList') as HTMLElement;
const filterBar = document.getElementById('filterBar') as HTMLElement;
const prevPageBtn = document.getElementById('prevPageBtn') as HTMLButtonElement;
const nextPageBtn = document.getElementById('nextPageBtn') as HTMLButtonElement;
const pageInfo = document.getElementById('pageInfo') as HTMLElement;
const statTotal = document.getElementById('statTotal') as HTMLElement;
const statOpen = document.getElementById('statOpen') as HTMLElement;
const statAck = document.getElementById('statAck') as HTMLElement;
const statResolved = document.getElementById('statResolved') as HTMLElement;
const openBadge = document.getElementById('openReportBadge') as HTMLElement;
const openBadgeMob = document.getElementById(
  'openReportBadgeMob',
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

// ── State ─────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;
let currentPage = 1;
let allItems: ReportIssueEntry[] = [];
let displayItems: ReportIssueEntry[] = [];
let totalItems = 0;
let activeFilter: 'all' | 'open' | 'acknowledged' | 'resolved' = 'all';
let activeDetailId: string | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function totalPages(): number {
  return Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
}

function updatePagination(): void {
  pageInfo.textContent = `Page ${currentPage} of ${totalPages()}`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= totalPages();
}

function updateStats(): void {
  const openCount = allItems.filter((e) => e.status === 'open').length;
  const ackCount = allItems.filter((e) => e.status === 'acknowledged').length;
  const resolvedCount = allItems.filter((e) => e.status === 'resolved').length;
  statTotal.textContent = String(allItems.length);
  statOpen.textContent = String(openCount);
  statAck.textContent = String(ackCount);
  statResolved.textContent = String(resolvedCount);
  openBadge.textContent = openCount > 0 ? String(openCount) : '';
  if (openBadgeMob)
    openBadgeMob.textContent = openCount > 0 ? String(openCount) : '';
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function statusBadgeHtml(status: string): string {
  return `<span class="ri-badge ri-badge--${status}">${escHtml(status)}</span>`;
}

function renderPage(): void {
  const slice = displayItems;
  reportList.innerHTML = '';

  if (slice.length === 0) {
    reportList.innerHTML =
      '<div class="ri-empty"><div class="ri-empty__icon">📋</div><p>No issue reports found.</p></div>';
    updatePagination();
    return;
  }

  for (const entry of slice) {
    const card = document.createElement('div');
    card.className = `ri-card ri-card--${entry.status}`;
    card.dataset.id = entry.id;
    card.innerHTML = `
      <div class="ri-card__accent" aria-hidden="true"></div>
      <div class="ri-card__body">
        <div class="ri-card__meta">
          <span class="ri-card__time">${new Date(entry.timestamp).toLocaleString()}</span>
          ${statusBadgeHtml(entry.status)}
          <span class="ri-badge ri-badge--cat">${escHtml(entry.category)}</span>
          ${entry.attachmentIds.length > 0 ? `<span class="ri-badge ri-badge--img">📷 ${entry.attachmentIds.length}</span>` : ''}
        </div>
        <p class="ri-card__title">${escHtml(entry.title)}</p>
        <p class="ri-card__desc">${escHtml(entry.description.slice(0, 160))}${entry.description.length > 160 ? '…' : ''}</p>
        <div class="ri-card__actions">
          <button class="ri-action-btn ri-action-btn--view" data-action="view" data-id="${escHtml(entry.id)}">View Details</button>
        </div>
      </div>
    `;
    reportList.appendChild(card);
  }

  reportList
    .querySelectorAll<HTMLButtonElement>('[data-action="view"]')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        void openDetail(btn.dataset.id!);
      });
    });

  updatePagination();
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function loadReports(): Promise<void> {
  try {
    const offset = (currentPage - 1) * PAGE_SIZE;
    const statusParam = activeFilter !== 'all' ? `&status=${activeFilter}` : '';
    const res = await apiFetch(
      `/api/admin/report-issues?limit=${PAGE_SIZE}&offset=${offset}${statusParam}`,
    );
    if (!res.ok) {
      setMessage('Failed to load reports.');
      return;
    }

    const data = (await res.json()) as ListResponse;
    displayItems = data.items;
    totalItems = data.total;
    renderPage();
    await loadAllForStats();
  } catch {
    setMessage('Network error loading reports.');
  }
}

async function loadAllForStats(): Promise<void> {
  try {
    const res = await apiFetch('/api/admin/report-issues?limit=1000');
    if (!res.ok) return;
    const data = (await res.json()) as ListResponse;
    allItems = data.items;
    updateStats();
  } catch {}
}

function applyFilter(): void {
  currentPage = 1;
  void loadReports();
}

// ── Detail modal ──────────────────────────────────────────────────────────────

async function openDetail(id: string): Promise<void> {
  activeDetailId = id;

  try {
    const res = await apiFetch(
      `/api/admin/report-issues/${encodeURIComponent(id)}`,
    );
    if (!res.ok) {
      setMessage('Failed to load report details.');
      return;
    }

    const data = (await res.json()) as DetailResponse;
    const { issue, attachments } = data;

    detailTitle.textContent = issue.title;

    const imgHtml = attachments
      .map(
        (a) =>
          `<a href="/api/admin/report-issues/attachments/${encodeURIComponent(a.id)}/file"
              target="_blank" class="ri-attachment-link">
            <img src="/api/admin/report-issues/attachments/${encodeURIComponent(a.id)}/file"
                alt="${escHtml(a.originalName)}" class="ri-attachment-thumb" />
          </a>`,
      )
      .join('');

    detailBody.innerHTML = `
      <div class="ri-detail-meta">
        ${statusBadgeHtml(issue.status)}
        <span class="ri-badge ri-badge--cat">${escHtml(issue.category)}</span>
        <span class="ri-detail-time">${new Date(issue.timestamp).toLocaleString()}</span>
      </div>
      <p class="ri-detail-desc">${escHtml(issue.description)}</p>
      ${attachments.length > 0 ? `<div class="ri-attachments-grid">${imgHtml}</div>` : '<p class="ri-no-attach">No image attachments.</p>'}
    `;

    detailAckBtn.classList.toggle('hidden', issue.status !== 'open');
    detailResolveBtn.classList.toggle('hidden', issue.status === 'resolved');
    detailReopenBtn.classList.toggle('hidden', issue.status === 'open');

    detailOverlay.classList.remove('hidden');
  } catch {
    setMessage('Network error loading report details.');
  }
}

function closeDetailModal(): void {
  detailOverlay.classList.add('hidden');
  activeDetailId = null;
}

async function updateDetailStatus(
  status: 'open' | 'acknowledged' | 'resolved',
): Promise<void> {
  if (!activeDetailId) return;
  try {
    const res = await apiFetch(
      `/api/admin/report-issues/${encodeURIComponent(activeDetailId)}/status`,
      { method: 'PATCH', body: JSON.stringify({ status }) },
    );
    if (!res.ok) {
      setMessage('Failed to update status.');
      return;
    }

    const entry = allItems.find((e) => e.id === activeDetailId);
    if (entry) entry.status = status;
    void loadReports();
    closeDetailModal();
    setMessage('Status updated.');
  } catch {
    setMessage('Network error.');
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

filterBar.querySelectorAll<HTMLButtonElement>('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeFilter = btn.dataset.filter as typeof activeFilter;
    filterBar
      .querySelectorAll('.filter-btn')
      .forEach((b) => b.classList.remove('filter-btn--active'));
    btn.classList.add('filter-btn--active');
    applyFilter();
  });
});

prevPageBtn.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    void loadReports();
  }
});
nextPageBtn.addEventListener('click', () => {
  if (currentPage < totalPages()) {
    currentPage++;
    void loadReports();
  }
});

closeDetail.addEventListener('click', closeDetailModal);
detailOverlay.addEventListener('click', (e) => {
  if (e.target === detailOverlay) closeDetailModal();
});

detailAckBtn.addEventListener(
  'click',
  () => void updateDetailStatus('acknowledged'),
);
detailResolveBtn.addEventListener(
  'click',
  () => void updateDetailStatus('resolved'),
);
detailReopenBtn.addEventListener(
  'click',
  () => void updateDetailStatus('open'),
);

// ── Init ──────────────────────────────────────────────────────────────────────

initAuth(() => loadReports());
