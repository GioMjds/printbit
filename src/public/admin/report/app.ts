import {
  SummaryResponse,
  apiFetch,
  setMessage,
  initAuth,
  updateSidebarBadges,
} from '../shared';

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
  transactionRef?: string | null;
  resolutionReason?: string | null;
  resolutionNote?: string | null;
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
const openAlertBadge = document.getElementById(
  'openAlertBadge',
) as HTMLElement | null;
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

const resolveModal = document.getElementById('resolveModal') as HTMLElement;
const resolutionReasonSelect = document.getElementById(
  'resolutionReasonSelect',
) as HTMLSelectElement;
const resolutionNoteInput = document.getElementById(
  'resolutionNoteInput',
) as HTMLTextAreaElement;
const closeResolveModalBtn = document.getElementById(
  'closeResolveModalBtn',
) as HTMLButtonElement;
const cancelResolveBtn = document.getElementById(
  'cancelResolveBtn',
) as HTMLButtonElement;
const submitResolveBtn = document.getElementById(
  'submitResolveBtn',
) as HTMLButtonElement;

// ── State ─────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;
let currentPage = 1;
let allItems: ReportIssueEntry[] = [];
let displayItems: ReportIssueEntry[] = [];
let totalItems = 0;
let activeFilter: 'active' | 'archived' | 'all' = 'active';
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

function setOpenAlertBadge(openCount: number): void {
  const text = openCount > 0 ? String(openCount) : '';
  if (openAlertBadge) openAlertBadge.textContent = text;
  if (openAlertBadgeMob) openAlertBadgeMob.textContent = text;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function statusBadgeHtml(status: string): string {
  return `<span class="ri-badge ri-badge--${status}">${escHtml(status)}</span>`;
}

function renderCard(entry: ReportIssueEntry): HTMLElement {
  const card = document.createElement('div');
  card.className = `ri-card ri-card--${entry.status}`;
  card.dataset.id = entry.id;

  const txnBadge = entry.transactionRef
    ? `<span class="badge badge-txn" title="Transaction Ref">${escHtml(entry.transactionRef)}</span>`
    : `<span class="badge badge-muted">Unlinked</span>`;

  card.innerHTML = `
    <div class="ri-card__accent" aria-hidden="true"></div>
    <div class="ri-card__body">
      <div class="ri-card__meta">
        <span class="ri-card__time">${new Date(entry.timestamp).toLocaleString()}</span>
        ${statusBadgeHtml(entry.status)}
        <span class="ri-badge ri-badge--cat">${escHtml(entry.category)}</span>
        ${txnBadge}
        ${entry.attachmentIds.length > 0 ? `<span class="ri-badge ri-badge--img">📷 ${entry.attachmentIds.length}</span>` : ''}
      </div>
      <p class="ri-card__title">${escHtml(entry.title)}</p>
      <p class="ri-card__desc">${escHtml(entry.description.slice(0, 160))}${entry.description.length > 160 ? '…' : ''}</p>
      <div class="ri-card__actions">
        <button class="ri-action-btn ri-action-btn--view" data-action="view" data-id="${escHtml(entry.id)}">View Details</button>
      </div>
    </div>
  `;
  return card;
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
    const card = renderCard(entry);
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
    const viewParam = `&view=${activeFilter}`;
    const res = await apiFetch(
      `/api/admin/report-issues?limit=${PAGE_SIZE}&offset=${offset}${viewParam}`,
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
    await loadSummary();
  } catch {
    setMessage('Network error loading reports.');
  }
}

async function loadAllForStats(): Promise<void> {
  try {
    const res = await apiFetch('/api/admin/report-issues?limit=1000&view=all');
    if (!res.ok) return;
    const data = (await res.json()) as ListResponse;
    allItems = data.items;
    updateStats();
  } catch (error) {
    console.error('Error loading all reports for stats:', error, { cause: error });
  }
}

async function loadSummary(): Promise<void> {
  try {
    const res = await apiFetch('/api/admin/summary');
    if (!res.ok) return;
    const summary = (await res.json()) as SummaryResponse;
    updateSidebarBadges(summary);
  } catch (error) {
    console.error('Error loading summary:', error, { cause: error });
  }
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

    const renderAttachment = (
      attachment: AttachmentMeta,
      linkClassName: string,
      imageClassName: string,
    ): string =>
      `<a href="/api/admin/report-issues/attachments/${encodeURIComponent(attachment.id)}/file"
          target="_blank"
          rel="noopener noreferrer"
          class="${linkClassName}">
        <img
          src="/api/admin/report-issues/attachments/${encodeURIComponent(attachment.id)}/file"
          alt="${escHtml(attachment.originalName)}"
          class="${imageClassName}"
          loading="lazy"
        />
        <span class="ri-attachment-name">${escHtml(attachment.originalName)}</span>
      </a>`;
    const featuredAttachment = attachments[0] ?? null;
    const galleryAttachments = attachments.slice(1);
    const galleryHtml = galleryAttachments
      .map((attachment) =>
        renderAttachment(
          attachment,
          'ri-attachment-link',
          'ri-attachment-thumb',
        ),
      )
      .join('');

    const txnHtml = issue.transactionRef
      ? `<a href="/admin/transactions?q=${encodeURIComponent(issue.transactionRef)}" target="_blank" rel="noopener noreferrer" class="txn-link">${escHtml(issue.transactionRef)} &nearr;</a>`
      : `<span class="ri-badge ri-badge--muted">Unlinked</span>`;

    const timelineHtml = `
      <div class="timeline-section">
        <h4 class="timeline-title">Status Timeline</h4>
        <div class="timeline-container">
          <div class="timeline-step done">
            <div class="timeline-dot"></div>
            <div class="timeline-content">
              <div class="timeline-label">Submitted</div>
              <div class="timeline-time">${new Date(issue.timestamp).toLocaleString()}</div>
            </div>
          </div>
          <div class="timeline-step ${issue.acknowledgedAt ? 'done' : 'pending'}">
            <div class="timeline-dot"></div>
            <div class="timeline-content">
              <div class="timeline-label">Acknowledged</div>
              <div class="timeline-time">${issue.acknowledgedAt ? new Date(issue.acknowledgedAt).toLocaleString() : 'Pending'}</div>
            </div>
          </div>
          <div class="timeline-step ${issue.resolvedAt ? 'done' : 'pending'}">
            <div class="timeline-dot"></div>
            <div class="timeline-content">
              <div class="timeline-label">Resolved</div>
              <div class="timeline-time">${issue.resolvedAt ? new Date(issue.resolvedAt).toLocaleString() : 'Pending'}</div>
              ${
                issue.resolutionReason
                  ? `<div class="timeline-reason">Reason: <strong>${escHtml(issue.resolutionReason)}</strong>${
                      issue.resolutionNote ? ` — <em>${escHtml(issue.resolutionNote)}</em>` : ''
                    }</div>`
                  : ''
              }
            </div>
          </div>
        </div>
      </div>
    `;

    detailBody.innerHTML = `
      <div class="ri-detail-layout">
        <section class="ri-detail-content">
          <div class="ri-detail-meta">
            ${statusBadgeHtml(issue.status)}
            <span class="ri-badge ri-badge--cat">${escHtml(issue.category)}</span>
            <span class="ri-detail-time">${new Date(issue.timestamp).toLocaleString()}</span>
          </div>
          <div class="detail-txn-row">
            <span class="detail-txn-label">Transaction Ref:</span>
            <span class="detail-txn-container">${txnHtml}</span>
          </div>
          <p class="ri-detail-desc">${escHtml(issue.description)}</p>
          ${timelineHtml}
        </section>
        <section class="ri-detail-media">
          ${
            attachments.length > 0
              ? `
                <div class="ri-detail-media__head">
                  <h4 class="ri-detail-media__title">Attachments</h4>
                  <span class="ri-detail-media__count">${attachments.length}</span>
                </div>
                ${
                  featuredAttachment
                    ? renderAttachment(
                        featuredAttachment,
                        'ri-attachment-feature',
                        'ri-attachment-feature__img',
                      )
                    : ''
                }
                ${
                  galleryAttachments.length > 0
                    ? `<div class="ri-attachments-grid">${galleryHtml}</div>`
                    : ''
                }
              `
              : '<p class="ri-no-attach">No image attachments.</p>'
          }
        </section>
      </div>
    `;

    detailAckBtn.classList.toggle('hidden', issue.status !== 'open');
    detailResolveBtn.classList.toggle('hidden', issue.status === 'resolved');
    detailReopenBtn.classList.toggle('hidden', issue.status === 'open');

    detailOverlay.classList.remove('is-leaving');
    detailOverlay.classList.remove('hidden');
  } catch {
    setMessage('Network error loading report details.');
  }
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

function openResolveModal(): void {
  if (!activeDetailId) return;
  resolutionReasonSelect.value = '';
  resolutionNoteInput.value = '';
  resolveModal.classList.remove('hidden');
}

function closeResolveModal(): void {
  resolveModal.classList.add('hidden');
}

async function submitResolution(): Promise<void> {
  if (!activeDetailId) return;
  const reason = resolutionReasonSelect.value;
  if (!reason) {
    setMessage('Please select a resolution reason.');
    return;
  }
  const note = resolutionNoteInput.value.trim() || null;

  try {
    const res = await apiFetch(
      `/api/admin/report-issues/${encodeURIComponent(activeDetailId)}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'resolved',
          resolutionReason: reason,
          resolutionNote: note,
        }),
      },
    );
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      setMessage(err?.error || 'Failed to resolve report.');
      return;
    }

    const entry = allItems.find((e) => e.id === activeDetailId);
    if (entry) {
      entry.status = 'resolved';
      entry.resolutionReason = reason;
      entry.resolutionNote = note;
      entry.resolvedAt = new Date().toISOString();
    }
    closeResolveModal();
    closeDetailModal();
    await loadReports();
    setMessage('Report marked as resolved.');
  } catch {
    setMessage('Network error resolving report.');
  }
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
    await loadReports();
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
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (resolveModal && !resolveModal.classList.contains('hidden')) {
      closeResolveModal();
    } else if (detailOverlay && !detailOverlay.classList.contains('hidden')) {
      closeDetailModal();
    }
  }
});

detailAckBtn.addEventListener(
  'click',
  () => void updateDetailStatus('acknowledged'),
);
detailResolveBtn.addEventListener(
  'click',
  openResolveModal,
);
detailReopenBtn.addEventListener(
  'click',
  () => void updateDetailStatus('open'),
);

closeResolveModalBtn?.addEventListener('click', closeResolveModal);
cancelResolveBtn?.addEventListener('click', closeResolveModal);
submitResolveBtn?.addEventListener('click', () => void submitResolution());
resolveModal?.addEventListener('click', (e) => {
  if (e.target === resolveModal) closeResolveModal();
});


// ── Init ──────────────────────────────────────────────────────────────────────

initAuth(() => loadReports());
