import {
  SummaryResponse,
  apiFetch,
  setMessage,
  initAuth,
  updateSidebarBadges,
} from '../shared';

interface FeedbackEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  comment: string;
  category: string | null;
  rating: number | null;
  status: 'new' | 'reviewed' | 'archived' | 'open' | 'resolved';
  needsAction: boolean;
  archivedAt?: string | null;
  transactionRef?: string | null;
  resolvedAt?: string | null;
}

interface FeedbackListResponse {
  total: number;
  items: FeedbackEntry[];
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const feedbackList = document.getElementById('feedbackList') as HTMLElement;
const filterBar = document.getElementById('filterBar') as HTMLElement;
const exportCsvBtn = document.getElementById(
  'exportCsvBtn',
) as HTMLButtonElement;
const archiveReviewedBtn = document.getElementById(
  'archiveReviewedBtn',
) as HTMLButtonElement | null;
const purgeBtn = document.getElementById(
  'purgeBtn',
) as HTMLButtonElement | null;
const purgeModal = document.getElementById('purgeModal') as HTMLElement | null;
const closePurgeModalBtn = document.getElementById(
  'closePurgeModalBtn',
) as HTMLButtonElement | null;
const cancelPurgeBtn = document.getElementById(
  'cancelPurgeBtn',
) as HTMLButtonElement | null;
const confirmPurgeBtn = document.getElementById(
  'confirmPurgeBtn',
) as HTMLButtonElement | null;
const purgeConfirmInput = document.getElementById(
  'purgeConfirmInput',
) as HTMLInputElement | null;

const prevPageBtn = document.getElementById('prevPageBtn') as HTMLButtonElement;
const nextPageBtn = document.getElementById('nextPageBtn') as HTMLButtonElement;
const pageInfo = document.getElementById('pageInfo') as HTMLElement;
const statTotal = document.getElementById('statTotal') as HTMLElement;
const statOpen = document.getElementById('statOpen') as HTMLElement;
const statResolved = document.getElementById('statResolved') as HTMLElement;
const openBadge = document.getElementById('openBadge') as HTMLElement;
const openBadgeMob = document.getElementById(
  'openBadgeMob',
) as HTMLElement | null;

// ── State ─────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;
let currentPage = 1;
let totalItems = 0;
let allItems: FeedbackEntry[] = [];
let displayItems: FeedbackEntry[] = [];
let activeFilter: 'active' | 'archived' | 'all' = 'active';

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const escHtml = escapeHtml;

function starsHtml(rating: number | null): string {
  if (rating === null) return '';
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

function totalPages(): number {
  return Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
}

function updatePagination(): void {
  const pages = totalPages();
  pageInfo.textContent = `Page ${currentPage} of ${pages}`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= pages;
}

function updateStats(): void {
  const openCount = allItems.filter(
    (e) => e.status === 'open' || e.status === 'new',
  ).length;
  const resolvedCount = allItems.filter(
    (e) => e.status === 'resolved' || e.status === 'reviewed',
  ).length;
  statTotal.textContent = String(allItems.length);
  statOpen.textContent = String(openCount);
  statResolved.textContent = String(resolvedCount);
  const badgeText = openCount > 0 ? String(openCount) : '';
  openBadge.textContent = badgeText;
  if (openBadgeMob) openBadgeMob.textContent = badgeText;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderPage(): void {
  const start = (currentPage - 1) * PAGE_SIZE;
  const slice = displayItems.slice(start, start + PAGE_SIZE);
  renderItems(slice);
  updatePagination();
}

function renderItems(items: FeedbackEntry[]): void {
  feedbackList.innerHTML = '';

  if (items.length === 0) {
    feedbackList.innerHTML =
      '<div class="fb-empty"><div class="fb-empty-icon">💬</div><p>No feedback entries found.</p></div>';
    return;
  }

  for (const entry of items) {
    const card = document.createElement('div');
    const isResolvedOrReviewed =
      entry.status === 'reviewed' || entry.status === 'resolved';
    const isArchived = entry.status === 'archived';
    card.className = `fb-card${
      isResolvedOrReviewed
        ? ' fb-card--resolved'
        : isArchived
          ? ' fb-card--archived'
          : ''
    }`;
    card.dataset.id = entry.id;

    const stars = starsHtml(entry.rating);
    const catBadge = entry.category
      ? `<span class="fb-badge fb-badge--cat">${escHtml(entry.category)}</span>`
      : '';
    const ratingBadge = stars
      ? `<span class="fb-stars">${escHtml(stars)}</span>`
      : '';

    let statusChipHtml = '';
    if (entry.status === 'new' || entry.status === 'open') {
      statusChipHtml = '<span class="status-chip status-chip--new">New</span>';
    } else if (entry.status === 'reviewed' || entry.status === 'resolved') {
      statusChipHtml =
        '<span class="status-chip status-chip--reviewed">Reviewed</span>';
    } else if (entry.status === 'archived') {
      statusChipHtml =
        '<span class="status-chip status-chip--archived">Archived</span>';
    }

    if (entry.needsAction) {
      statusChipHtml +=
        ' <span class="badge-action" title="Needs Action">Action Needed</span>';
    }

    const txnHtml = entry.transactionRef
      ? `<div class="fb-card__txn">Txn: ${escHtml(entry.transactionRef)}</div>`
      : '';

    let actionsHtml = '';
    if (entry.status === 'new' || entry.status === 'open') {
      actionsHtml += `<button class="fb-action-btn fb-action-btn--review" data-action="review" data-id="${escHtml(entry.id)}" type="button">Mark Reviewed</button>`;
    }
    const actionToggleLabel = entry.needsAction
      ? 'Unmark Action'
      : 'Needs Action';
    const actionToggleClass = entry.needsAction
      ? 'fb-action-btn--action-active'
      : '';
    actionsHtml += `<button class="fb-action-btn fb-action-btn--toggle-action ${actionToggleClass}" data-action="toggle-action" data-id="${escHtml(entry.id)}" type="button">${actionToggleLabel}</button>`;

    if (!isArchived) {
      actionsHtml += `<button class="fb-action-btn fb-action-btn--archive" data-action="archive" data-id="${escHtml(entry.id)}" type="button">Archive</button>`;
    } else {
      actionsHtml += `<button class="fb-action-btn fb-action-btn--archive" data-action="archive" data-id="${escHtml(entry.id)}" type="button" disabled>Archived</button>`;
    }

    card.innerHTML = `
      <div class="fb-card__accent" aria-hidden="true"></div>
      <div class="fb-card__body">
        <div class="fb-card__meta">
          <span class="fb-card__timestamp">${new Date(entry.timestamp).toLocaleString()}</span>
          ${statusChipHtml}
          ${catBadge}
          ${ratingBadge}
        </div>
        <p class="fb-card__comment">${escHtml(entry.comment)}</p>
        ${txnHtml}
        <div class="fb-card__actions">
          ${actionsHtml}
        </div>
      </div>
    `;
    feedbackList.appendChild(card);
  }

  feedbackList
    .querySelectorAll<HTMLButtonElement>('[data-action]')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const action = btn.dataset.action!;
        const id = btn.dataset.id!;
        if (action === 'review') void handleMarkReviewed(id);
        if (action === 'archive') void handleArchive(id);
        if (action === 'toggle-action') void handleToggleAction(id);
      });
    });
}

// ── Data fetching ────────────────────────────────────────────────────────────

async function loadFeedback(): Promise<void> {
  const params = new URLSearchParams({ limit: '1000', view: activeFilter });

  try {
    const res = await apiFetch(`/api/admin/feedback?${params.toString()}`);
    if (!res.ok) {
      setMessage('Failed to load feedback.');
      return;
    }
    const data = (await res.json()) as FeedbackListResponse;
    displayItems = data.items;
    totalItems = data.total;
    currentPage = 1;
    renderPage();
    await loadAllForStats();
    await loadSummary();
  } catch {
    setMessage('Network error loading feedback.');
  }
}

async function loadAllForStats(): Promise<void> {
  try {
    const res = await apiFetch('/api/admin/feedback?limit=1000&view=all');
    if (!res.ok) return;
    const data = (await res.json()) as FeedbackListResponse;
    allItems = data.items;
    updateStats();
  } catch (error) {
    console.error('Failed to load all feedback for stats:', error);
  }
}

async function loadSummary(): Promise<void> {
  try {
    const res = await apiFetch('/api/admin/summary');
    if (!res.ok) return;
    const summary = (await res.json()) as SummaryResponse;
    updateSidebarBadges(summary);
  } catch (error) {
    console.error(`Failed to load summary data. ${error}`, { cause: error });
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function handleMarkReviewed(id: string): Promise<void> {
  try {
    const res = await apiFetch(
      `/api/admin/feedback/${encodeURIComponent(id)}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'reviewed' }),
      },
    );
    if (!res.ok) {
      setMessage('Failed to update feedback status.');
      return;
    }
    await loadFeedback();
    setMessage('Marked as reviewed.');
  } catch {
    setMessage('Network error.');
  }
}

async function handleArchive(id: string): Promise<void> {
  try {
    const res = await apiFetch(
      `/api/admin/feedback/${encodeURIComponent(id)}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({ action: 'archive' }),
      },
    );
    if (!res.ok) {
      setMessage('Failed to archive feedback.');
      return;
    }
    await loadFeedback();
    setMessage('Feedback archived.');
  } catch {
    setMessage('Network error.');
  }
}

async function handleToggleAction(id: string): Promise<void> {
  const entry =
    displayItems.find((e) => e.id === id) || allItems.find((e) => e.id === id);
  if (!entry) return;
  const nextVal = !entry.needsAction;
  try {
    const res = await apiFetch(
      `/api/admin/feedback/${encodeURIComponent(id)}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({ needsAction: nextVal }),
      },
    );
    if (!res.ok) {
      setMessage('Failed to update action status.');
      return;
    }
    await loadFeedback();
    setMessage(nextVal ? 'Marked as needing action.' : 'Action flag cleared.');
  } catch {
    setMessage('Network error.');
  }
}

async function handleArchiveReviewed(): Promise<void> {
  if (archiveReviewedBtn) archiveReviewedBtn.disabled = true;
  try {
    const res = await apiFetch('/api/admin/feedback/archive-reviewed', {
      method: 'POST',
    });
    if (!res.ok) {
      setMessage('Failed to archive reviewed feedback.');
      return;
    }
    const data = (await res.json()) as { ok: boolean; count: number };
    await loadFeedback();
    setMessage(`Archived ${data.count} reviewed feedback entries.`);
  } catch {
    setMessage('Network error archiving feedback.');
  } finally {
    if (archiveReviewedBtn) archiveReviewedBtn.disabled = false;
  }
}

function openPurgeModal(): void {
  if (!purgeModal) return;
  if (purgeConfirmInput) purgeConfirmInput.value = '';
  if (confirmPurgeBtn) confirmPurgeBtn.disabled = true;
  purgeModal.classList.remove('hidden');
  purgeConfirmInput?.focus();
}

function closePurgeModal(): void {
  if (!purgeModal) return;
  purgeModal.classList.add('hidden');
  if (purgeConfirmInput) purgeConfirmInput.value = '';
  if (confirmPurgeBtn) confirmPurgeBtn.disabled = true;
}

async function handleConfirmPurge(): Promise<void> {
  if (!confirmPurgeBtn || confirmPurgeBtn.disabled) return;
  confirmPurgeBtn.disabled = true;
  try {
    const res = await apiFetch('/api/admin/feedback', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'PURGE' }),
    });
    if (!res.ok) {
      setMessage('Failed to purge feedback.');
      confirmPurgeBtn.disabled = false;
      return;
    }
    const data = (await res.json().catch(() => ({}))) as { count?: number };
    closePurgeModal();
    await loadFeedback();
    const countMsg =
      typeof data.count === 'number' ? ` (${data.count} deleted)` : '';
    setMessage(`Feedback records permanently deleted${countMsg}.`);
  } catch {
    setMessage('Network error purging feedback.');
    confirmPurgeBtn.disabled = false;
  }
}

function handleExportCsv(): void {
  window.location.href = '/api/admin/feedback/export.csv';
}

// ── Filter bar ──────────────────────────────────────────────────────────────

filterBar.querySelectorAll<HTMLButtonElement>('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const filter = btn.dataset.filter as 'active' | 'archived' | 'all';
    activeFilter = filter;
    filterBar
      .querySelectorAll('.filter-btn')
      .forEach((b) => b.classList.remove('filter-btn--active'));
    btn.classList.add('filter-btn--active');
    void loadFeedback();
  });
});

prevPageBtn.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage -= 1;
    renderPage();
  }
});

nextPageBtn.addEventListener('click', () => {
  if (currentPage < totalPages()) {
    currentPage += 1;
    renderPage();
  }
});

exportCsvBtn.addEventListener('click', handleExportCsv);
archiveReviewedBtn?.addEventListener(
  'click',
  () => void handleArchiveReviewed(),
);

purgeBtn?.addEventListener('click', openPurgeModal);
closePurgeModalBtn?.addEventListener('click', closePurgeModal);
cancelPurgeBtn?.addEventListener('click', closePurgeModal);
confirmPurgeBtn?.addEventListener('click', () => void handleConfirmPurge());

purgeConfirmInput?.addEventListener('input', () => {
  if (confirmPurgeBtn && purgeConfirmInput) {
    confirmPurgeBtn.disabled = purgeConfirmInput.value !== 'PURGE';
  }
});

purgeConfirmInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && purgeConfirmInput.value === 'PURGE') {
    e.preventDefault();
    void handleConfirmPurge();
  }
});

purgeModal?.addEventListener('click', (e) => {
  if (e.target === purgeModal) {
    closePurgeModal();
  }
});

window.addEventListener('keydown', (e) => {
  if (
    e.key === 'Escape' &&
    purgeModal &&
    !purgeModal.classList.contains('hidden')
  ) {
    closePurgeModal();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

initAuth(() => loadFeedback());
