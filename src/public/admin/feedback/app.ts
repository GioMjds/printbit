import { apiFetch, setMessage, initAuth } from '../shared';

interface FeedbackEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  comment: string;
  category: string | null;
  rating: number | null;
  status: 'open' | 'resolved';
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
const clearAllBtn = document.getElementById('clearAllBtn') as HTMLButtonElement;
const prevPageBtn = document.getElementById('prevPageBtn') as HTMLButtonElement;
const nextPageBtn = document.getElementById('nextPageBtn') as HTMLButtonElement;
const pageInfo = document.getElementById('pageInfo') as HTMLElement;
const statTotal = document.getElementById('statTotal') as HTMLElement;
const statOpen = document.getElementById('statOpen') as HTMLElement;
const statResolved = document.getElementById('statResolved') as HTMLElement;
const openBadge = document.getElementById('openBadge') as HTMLElement;
const openBadgeMob = document.getElementById('openBadgeMob') as HTMLElement;

// ── State ─────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;
let currentPage = 1;
let totalItems = 0;
let allItems: FeedbackEntry[] = [];
let displayItems: FeedbackEntry[] = [];
let activeFilter: 'all' | 'open' | 'resolved' = 'all';

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
  const openCount = allItems.filter((e) => e.status === 'open').length;
  const resolvedCount = allItems.filter((e) => e.status === 'resolved').length;
  statTotal.textContent = String(allItems.length);
  statOpen.textContent = String(openCount);
  statResolved.textContent = String(resolvedCount);
  const badgeText = openCount > 0 ? String(openCount) : '';
  openBadge.textContent = badgeText;
  openBadgeMob.textContent = badgeText;
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
    card.className = `fb-card${entry.status === 'resolved' ? ' fb-card--resolved' : ''}`;
    card.dataset.id = entry.id;

    const stars = starsHtml(entry.rating);
    const catBadge = entry.category
      ? `<span class="fb-badge fb-badge--cat">${escapeHtml(entry.category)}</span>`
      : '';
    const ratingBadge = stars
      ? `<span class="fb-stars">${escapeHtml(stars)}</span>`
      : '';
    const statusBadge = `<span class="fb-badge fb-badge--${entry.status}">${entry.status}</span>`;
    const resolveLabel = entry.status === 'open' ? 'Mark Resolved' : 'Reopen';
    const resolveClass =
      entry.status === 'open'
        ? 'fb-action-btn--resolve'
        : 'fb-action-btn--reopen';

    card.innerHTML = `
      <div class="fb-card__accent" aria-hidden="true"></div>
      <div class="fb-card__body">
        <div class="fb-card__meta">
          <span class="fb-card__timestamp">${new Date(entry.timestamp).toLocaleString()}</span>
          ${statusBadge}
          ${catBadge}
          ${ratingBadge}
        </div>
        <p class="fb-card__comment">${escapeHtml(entry.comment)}</p>
        <div class="fb-card__actions">
          <button class="fb-action-btn ${resolveClass}" data-action="resolve" data-id="${escapeHtml(entry.id)}">${resolveLabel}</button>
          <button class="fb-action-btn fb-action-btn--delete" data-action="delete" data-id="${escapeHtml(entry.id)}">Delete</button>
        </div>
      </div>
    `;
    feedbackList.appendChild(card);
  }

  feedbackList
    .querySelectorAll<HTMLButtonElement>('[data-action]')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action!;
        const id = btn.dataset.id!;
        if (action === 'resolve') void handleToggleResolved(id);
        if (action === 'delete') void handleDelete(id);
      });
    });
}

// ── Data fetching ────────────────────────────────────────────────────────────

async function loadFeedback(): Promise<void> {
  const params = new URLSearchParams({ limit: '1000' });

  try {
    const res = await apiFetch(`/api/admin/feedback?${params.toString()}`);
    if (!res.ok) {
      setMessage('Failed to load feedback.');
      return;
    }
    const data = (await res.json()) as FeedbackListResponse;
    allItems = data.items;
    displayItems =
      activeFilter === 'all'
        ? allItems
        : allItems.filter((e) => e.status === activeFilter);
    totalItems = displayItems.length;
    currentPage = 1;
    updateStats();
    renderPage();
  } catch {
    setMessage('Network error loading feedback.');
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function handleToggleResolved(id: string): Promise<void> {
  const entry = allItems.find((e) => e.id === id);
  if (!entry) return;
  const resolved = entry.status === 'open';
  try {
    const res = await apiFetch(
      `/api/admin/feedback/${encodeURIComponent(id)}/resolve`,
      {
        method: 'PATCH',
        body: JSON.stringify({ resolved }),
      },
    );
    if (!res.ok) {
      setMessage('Failed to update feedback status.');
      return;
    }
    entry.status = resolved ? 'resolved' : 'open';
    entry.resolvedAt = resolved ? new Date().toISOString() : null;
    displayItems =
      activeFilter === 'all'
        ? allItems
        : allItems.filter((e) => e.status === activeFilter);
    totalItems = displayItems.length;
    updateStats();
    renderPage();
    setMessage(resolved ? 'Marked as resolved.' : 'Reopened.');
  } catch {
    setMessage('Network error.');
  }
}

async function handleDelete(id: string): Promise<void> {
  if (!confirm('Delete this feedback entry?')) return;
  try {
    const res = await apiFetch(
      `/api/admin/feedback/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
      },
    );
    if (!res.ok) {
      setMessage('Failed to delete feedback.');
      return;
    }
    allItems = allItems.filter((e) => e.id !== id);
    displayItems =
      activeFilter === 'all'
        ? allItems
        : allItems.filter((e) => e.status === activeFilter);
    totalItems = displayItems.length;
    if (currentPage > totalPages()) currentPage = totalPages();
    updateStats();
    renderPage();
    setMessage('Feedback deleted.');
  } catch {
    setMessage('Network error.');
  }
}

async function handleClearAll(): Promise<void> {
  if (!confirm('Delete ALL feedback entries? This cannot be undone.')) return;
  try {
    const res = await apiFetch('/api/admin/feedback', { method: 'DELETE' });
    if (!res.ok) {
      setMessage('Failed to clear feedback.');
      return;
    }
    allItems = [];
    displayItems = [];
    totalItems = 0;
    currentPage = 1;
    updateStats();
    renderPage();
    setMessage('All feedback cleared.');
  } catch {
    setMessage('Network error.');
  }
}

function handleExportCsv(): void {
  window.location.href = '/api/admin/feedback/export.csv';
}

// ── Filter bar ──────────────────────────────────────────────────────────────

filterBar.querySelectorAll<HTMLButtonElement>('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const filter = btn.dataset.filter as 'all' | 'open' | 'resolved';
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
clearAllBtn.addEventListener('click', () => void handleClearAll());

// ── Init ──────────────────────────────────────────────────────────────────────

initAuth(() => loadFeedback());
