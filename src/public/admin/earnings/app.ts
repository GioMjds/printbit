import {
  EarningsAnalyticsResponse,
  EarningsAnalyticsView,
  SummaryResponse,
  apiFetch,
  setMessage,
  initAuth,
  peso,
  updateSidebarBadges,
} from '../shared';
import { loadEarningsAnalyticsPair } from './analytics-pair';
import {
  getEarningsAnalyticsRequestKey,
  isCurrentEarningsAnalyticsRequest,
} from './analytics-request';
import {
  canNavigateToNextEarningsPeriod,
  createEarningsViewModel,
  shiftEarningsAnchor,
} from './earnings-view-model';

const openAlertBadge = document.getElementById(
  'openAlertBadge',
) as HTMLElement | null;
const openAlertBadgeMob = document.getElementById(
  'openAlertBadgeMob',
) as HTMLElement | null;

const refreshBtn = document.getElementById('refreshBtn') as HTMLButtonElement;
const periodLabel = document.getElementById('periodLabel') as HTMLElement;
const trendGrid = document.getElementById('trendGrid') as HTMLElement;
const topMethod = document.getElementById('topMethod') as HTMLElement;
const viewSwitch = document.getElementById('viewSwitch') as HTMLElement;
const prevAnchorBtn = document.getElementById(
  'prevAnchorBtn',
) as HTMLButtonElement;
const nextAnchorBtn = document.getElementById(
  'nextAnchorBtn',
) as HTMLButtonElement;
const anchorDateInput = document.getElementById(
  'anchorDateInput',
) as HTMLInputElement;
const calendarToggleBtn = document.getElementById(
  'calendarToggleBtn',
) as HTMLButtonElement;

const earningsDeck = document.querySelector<HTMLElement>('.earnings-deck')!;
const selectedPeriodAmount = document.getElementById('selectedPeriodAmount')!;
const comparisonText = document.getElementById('comparisonText')!;
const emptyPeriodMessage = document.getElementById('emptyPeriodMessage')!;
const servicePrint = document.getElementById('servicePrint')!;
const serviceCopy = document.getElementById('serviceCopy')!;
const serviceScan = document.getElementById('serviceScan')!;

const viewButtons = Array.from(
  viewSwitch.querySelectorAll<HTMLButtonElement>('.view-switch__btn'),
);
let summaryRefreshTimer: number | null = null;
let analyticsRefreshTimer: number | null = null;
let currentView: EarningsAnalyticsView = 'daily';
let anchorDate = new Date();
let summaryInFlight: Promise<void> | null = null;
let analyticsInFlight: Promise<void> | null = null;
let analyticsInFlightKey: string | null = null;
let analyticsRequestSeq = 0;

function toLocalDateString(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDateString(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function syncDatePicker(): void {
  if (!anchorDateInput) return;
  anchorDateInput.max = toLocalDateString(new Date());
  anchorDateInput.value = toLocalDateString(anchorDate);
}

function initCalendar(): void {
  syncDatePicker();
  anchorDateInput?.addEventListener('change', () => {
    if (!anchorDateInput.value) return;
    anchorDate = parseLocalDateString(anchorDateInput.value);
    syncDatePicker();
    void loadAnalyticsData().catch(showEarningsError);
  });
}

calendarToggleBtn?.addEventListener('click', () => {
  try {
    anchorDateInput?.showPicker();
  } catch {
    anchorDateInput?.focus();
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function isAnalyticsView(value: unknown): value is EarningsAnalyticsView {
  return (
    value === 'daily' ||
    value === 'weekly' ||
    value === 'monthly' ||
    value === 'yearly'
  );
}

function setActiveViewButton(view: EarningsAnalyticsView): void {
  viewButtons.forEach((btn) => {
    btn.classList.toggle('view-switch__btn--active', btn.dataset.view === view);
    btn.setAttribute('aria-pressed', String(btn.dataset.view === view));
  });
}

function resolveInitialView(): EarningsAnalyticsView {
  const activeBtn = viewButtons.find((btn) =>
    btn.classList.contains('view-switch__btn--active'),
  );
  if (isAnalyticsView(activeBtn?.dataset.view)) {
    return activeBtn.dataset.view;
  }
  return 'daily';
}

function applyEarnings(summary: SummaryResponse): void {
  const openCount =
    summary.anomalyStats.openCount > 0
      ? String(summary.anomalyStats.openCount)
      : '';
  if (openAlertBadge) openAlertBadge.textContent = openCount;
  if (openAlertBadgeMob) openAlertBadgeMob.textContent = openCount;
  if (
    currentView === 'daily' &&
    !canNavigateToNextEarningsPeriod('daily', anchorDate)
  ) {
    selectedPeriodAmount.textContent = peso(summary.earnings.today);
  }
}

function renderAnalytics(
  current: EarningsAnalyticsResponse,
  previous: EarningsAnalyticsResponse,
): void {
  const model = createEarningsViewModel(current, previous);
  currentView = current.view;
  setActiveViewButton(current.view);
  periodLabel.textContent = model.periodLabel;
  selectedPeriodAmount.textContent = peso(model.total);
  comparisonText.dataset.direction = model.direction;
  comparisonText.textContent =
    model.direction === 'flat'
      ? `Matches ${model.referenceLabel}`
      : `${model.direction === 'up' ? '↑' : '↓'} ${peso(Math.abs(model.delta))} ${model.direction === 'up' ? 'more' : 'less'} than ${model.referenceLabel}`;
  emptyPeriodMessage.hidden = !model.empty;
  servicePrint.textContent = peso(model.services[0].amount);
  serviceCopy.textContent = peso(model.services[1].amount);
  serviceScan.textContent = peso(model.services[2].amount);
  topMethod.textContent = `Top service: ${model.topService ?? '—'}`;
  nextAnchorBtn.disabled = !canNavigateToNextEarningsPeriod(
    currentView,
    anchorDate,
  );
  renderTrendBuckets(current.buckets);
}

function getAnalyticsRequestKey(): string {
  return getEarningsAnalyticsRequestKey(currentView, anchorDate);
}

function showEarningsError(error: unknown): void {
  const detail =
    error instanceof Error ? error.message : 'Failed to load earnings.';
  setMessage(`${detail} Use Refresh to retry.`);
}

function renderTrendBuckets(
  buckets: EarningsAnalyticsResponse['buckets'],
): void {
  const maxAmount = Math.max(...buckets.map(({ amount }) => amount), 1);
  trendGrid.replaceChildren();
  for (const bucket of buckets) {
    const cell = document.createElement('div');
    cell.className = 'trend-cell';
    cell.setAttribute('role', 'listitem');

    const amount = document.createElement('div');
    amount.className = 'trend-cell__amount';
    amount.textContent = peso(bucket.amount);

    const bar = document.createElement('div');
    bar.className = 'trend-cell__bar';
    bar.style.setProperty(
      '--trend-height',
      `${Math.max(8, Math.round((bucket.amount / maxAmount) * 100))}%`,
    );

    const label = document.createElement('div');
    label.className = 'trend-cell__label';
    label.textContent = bucket.label;
    cell.append(amount, bar, label);
    trendGrid.append(cell);
  }
}

// ── API ──────────────────────────────────────────────────────────────────────
async function loadSummaryData(): Promise<void> {
  if (summaryInFlight) return summaryInFlight;
  summaryInFlight = (async () => {
    const summaryRes = await apiFetch('/api/admin/summary');
    if (!summaryRes.ok) {
      if (summaryRes.status === 401) throw new Error('Invalid admin PIN.');
      throw new Error('Failed to load earnings data.');
    }
    const summary = (await summaryRes.json()) as SummaryResponse;
    applyEarnings(summary);
    updateSidebarBadges(summary);
  })().finally(() => {
    summaryInFlight = null;
  });
  return summaryInFlight;
}

async function loadOneAnalytics(
  view: EarningsAnalyticsView,
  anchor: Date,
): Promise<EarningsAnalyticsResponse> {
  const analyticsRes = await apiFetch(
    `/api/admin/earnings/analytics?view=${encodeURIComponent(view)}&anchor=${encodeURIComponent(anchor.toISOString())}`,
  );
  if (!analyticsRes.ok) {
    if (analyticsRes.status === 401) throw new Error('Invalid admin PIN.');
    throw new Error('Failed to load earnings analytics.');
  }
  return analyticsRes.json() as Promise<EarningsAnalyticsResponse>;
}

async function loadAnalyticsData(): Promise<void> {
  const requestKey = getAnalyticsRequestKey();
  if (analyticsInFlight && analyticsInFlightKey === requestKey)
    return analyticsInFlight;
  const requestSeq = ++analyticsRequestSeq;
  earningsDeck.setAttribute('aria-busy', 'true');
  const requestPromise = loadEarningsAnalyticsPair(
    loadOneAnalytics,
    currentView,
    anchorDate,
  )
    .then((pair) => {
      if (
        requestSeq <= analyticsRequestSeq &&
        isCurrentEarningsAnalyticsRequest(
          requestKey,
          currentView,
          anchorDate,
        )
      )
        renderAnalytics(pair.current, pair.previous);
    })
    .finally(() => {
      if (analyticsInFlight === requestPromise) {
        analyticsInFlight = null;
        analyticsInFlightKey = null;
        earningsDeck.setAttribute('aria-busy', 'false');
      }
    });

  analyticsInFlight = requestPromise;
  analyticsInFlightKey = requestKey;
  return requestPromise;
}

async function loadData(): Promise<void> {
  await Promise.all([loadSummaryData(), loadAnalyticsData()]);
}

// ── Events ───────────────────────────────────────────────────────────────────
refreshBtn.addEventListener('click', () => {
  setMessage('Refreshing...');
  void loadData()
    .then(() => setMessage('Earnings refreshed.'))
    .catch(showEarningsError);
});

viewButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!isAnalyticsView(btn.dataset.view)) return;
    currentView = btn.dataset.view;
    anchorDate = new Date();
    syncDatePicker();
    setActiveViewButton(currentView);
    void loadAnalyticsData().catch(showEarningsError);
  });
});

prevAnchorBtn.addEventListener('click', () => {
  anchorDate = shiftEarningsAnchor(currentView, anchorDate, -1);
  syncDatePicker();
  void loadAnalyticsData().catch(showEarningsError);
});

nextAnchorBtn.addEventListener('click', () => {
  if (!canNavigateToNextEarningsPeriod(currentView, anchorDate)) return;
  anchorDate = shiftEarningsAnchor(currentView, anchorDate, 1);
  syncDatePicker();
  void loadAnalyticsData().catch(showEarningsError);
});

initAuth(async (signal) => {
  currentView = resolveInitialView();
  setActiveViewButton(currentView);
  initCalendar();
  await loadData().catch(showEarningsError);
  if (signal.aborted) return;
  if (summaryRefreshTimer !== null) window.clearInterval(summaryRefreshTimer);
  if (analyticsRefreshTimer !== null)
    window.clearInterval(analyticsRefreshTimer);
  summaryRefreshTimer = window.setInterval(
    () => void loadSummaryData().catch(showEarningsError),
    10_000,
  );
  analyticsRefreshTimer = window.setInterval(
    () => void loadAnalyticsData().catch(showEarningsError),
    60_000,
  );
});

window.addEventListener('pagehide', () => {
  if (summaryRefreshTimer !== null) window.clearInterval(summaryRefreshTimer);
  if (analyticsRefreshTimer !== null)
    window.clearInterval(analyticsRefreshTimer);
});
