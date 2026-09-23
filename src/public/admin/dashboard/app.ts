import {
  SummaryResponse,
  apiFetch,
  formatBytes,
  initAuth,
  peso,
  setMessage,
  updateSidebarBadges,
} from '../shared';

const earningsToday = document.getElementById('earningsToday') as HTMLElement;
const jobsTotal = document.getElementById('jobsTotal') as HTMLElement;
const jobsPrint = document.getElementById('jobsPrint') as HTMLElement;
const jobsCopy = document.getElementById('jobsCopy') as HTMLElement;
const jobsScan = document.getElementById('jobsScan') as HTMLElement;
const storageFiles = document.getElementById('storageFiles') as HTMLElement;
const storageBytes = document.getElementById('storageBytes') as HTMLElement;
const owedChangeOpen = document.getElementById(
  'owedChangeOpen',
) as HTMLElement | null;
// ── Ink tank gauge elements ──────────────────────────────
const inkAlertBanner = document.getElementById(
  'inkAlertBanner',
) as HTMLElement | null;
const inkAlertText = document.getElementById(
  'inkAlertText',
) as HTMLElement | null;
const inkAlertBadge = document.getElementById(
  'inkAlertBadge',
) as HTMLElement | null;
const owedChangeHint = document.getElementById(
  'owedChangeHint',
) as HTMLElement | null;
const barPrint = document.getElementById('barPrint') as HTMLElement | null;
const barCopy = document.getElementById('barCopy') as HTMLElement | null;
const barScan = document.getElementById('barScan') as HTMLElement | null;
const forecastPaperDays = document.getElementById(
  'forecastPaperDays',
) as HTMLElement | null;
const forecastPaperStock = document.getElementById(
  'forecastPaperStock',
) as HTMLElement | null;
const forecastPaperStatus = document.getElementById(
  'forecastPaperStatus',
) as HTMLElement | null;
const forecastAlert = document.getElementById(
  'forecastAlert',
) as HTMLElement | null;
const forecastInkList = document.getElementById(
  'forecastInkList',
) as HTMLElement | null;

const refreshBtn = document.getElementById('refreshBtn') as HTMLButtonElement;
const resetBalanceBtn = document.getElementById(
  'resetBalanceBtn',
) as HTMLButtonElement;
const resetInkBtn = document.getElementById('resetInkBtn') as HTMLButtonElement;
const clearStorageBtn = document.getElementById(
  'clearStorageBtn',
) as HTMLButtonElement;
const openAlertBadge = document.getElementById(
  'openAlertBadge',
) as HTMLElement | null;
const openAlertBadgeMob = document.getElementById(
  'openAlertBadgeMob',
) as HTMLElement | null;

let refreshTimer: number | null = null;

type Tanks = {
  key: 'grayscale' | 'color';
  label: string;
  id: string;
};

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function applyInkEstimation(summary: SummaryResponse): void {
  const est = summary.inkEstimation;
  if (!est) {
    // No ink estimation data — hide the panel alert
    if (inkAlertBanner) inkAlertBanner.classList.add('hidden');
    if (inkAlertBadge) inkAlertBadge.textContent = '';
    return;
  }

  const tanks = [
    { key: 'grayscale', label: 'Grayscale ink', id: 'Grayscale' },
    { key: 'color', label: 'Color ink', id: 'Color' },
  ] satisfies Tanks[];

  let alertCount = 0;
  const lowNames: string[] = [];

  for (const { key, label, id } of tanks) {
    const tank = est[key];
    const fillEl = document.getElementById(`inkFill${id}`);
    const percentEl = document.getElementById(`inkPercent${id}`);
    const pagesEl = document.getElementById(`inkPages${id}`);
    const tankEl = document.getElementById(`inkTank${id}`);

    if (fillEl) fillEl.style.height = `${tank.remainingPercent}%`;
    if (percentEl)
      percentEl.textContent = `${tank.remainingPercent.toFixed(1)}%`;
    if (pagesEl) {
      pagesEl.textContent = `${formatNumber(tank.pagesUsed)} / ${formatNumber(tank.maxPages)} pages`;
    }
    if (tankEl) {
      tankEl.classList.toggle('ink-tank--alert', tank.alertTriggered);
    }
    if (tank.alertTriggered) {
      alertCount += 1;
      lowNames.push(label);
    }
  }

  // Alert banner
  if (inkAlertBanner) {
    inkAlertBanner.classList.toggle('hidden', !est.anyAlertTriggered);
  }
  if (inkAlertText && est.anyAlertTriggered) {
    inkAlertText.textContent =
      lowNames.length === 1
        ? `${lowNames[0]} is running low — consider refilling soon.`
        : `${lowNames.join(' and ')} are running low — consider refilling soon.`;
  }
  if (inkAlertBadge) {
    inkAlertBadge.textContent = alertCount > 0 ? String(alertCount) : '';
  }
}

function formatDaysRemaining(daysRemaining: number | null): string {
  if (daysRemaining === null) return '--';
  if (daysRemaining < 1) return '<1 day';
  if (daysRemaining < 10) return `${daysRemaining.toFixed(1)} days`;
  return `${Math.round(daysRemaining)} days`;
}

function applyConsumablesForecast(summary: SummaryResponse): void {
  const forecast = summary.consumables;
  if (!forecast) {
    if (forecastPaperDays) forecastPaperDays.textContent = '--';
    if (forecastPaperStock) forecastPaperStock.textContent = '--';
    if (forecastPaperStatus) forecastPaperStatus.textContent = 'Unavailable';
    if (forecastAlert) {
      forecastAlert.textContent = 'Consumables forecast is unavailable.';
      forecastAlert.classList.remove('consumables-alert--active');
    }
    if (forecastInkList) {
      const empty = document.createElement('li');
      empty.className = 'consumables-item consumables-item--muted';
      empty.textContent = 'No ink forecast data available.';
      forecastInkList.replaceChildren(empty);
    }
    return;
  }

  if (forecastPaperDays) {
    forecastPaperDays.textContent = formatDaysRemaining(
      forecast.paper.daysRemaining,
    );
  }
  if (forecastPaperStock) {
    forecastPaperStock.textContent = `${forecast.paper.currentSheets}/${forecast.paper.trayCapacitySheets} sheets`;
  }
  if (forecastPaperStatus) {
    forecastPaperStatus.textContent = forecast.paper.status.replace('_', ' ');
  }
  if (forecastAlert) {
    forecastAlert.textContent = forecast.alerts.withinThreshold
      ? `At-risk: ${forecast.alerts.reasons.join(', ')}`
      : `Healthy: no depletion risk within ${forecast.alertDaysThreshold} days.`;
    forecastAlert.classList.toggle(
      'consumables-alert--active',
      forecast.alerts.withinThreshold,
    );
  }
  if (forecastInkList) {
    forecastInkList.replaceChildren();
    if (forecast.inkSupplies.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'consumables-item consumables-item--muted';
      empty.textContent = 'No ink telemetry detected yet.';
      forecastInkList.appendChild(empty);
      return;
    }
    for (const supply of forecast.inkSupplies) {
      const item = document.createElement('li');
      item.className = 'consumables-item';
      const isDepletionRisk =
        supply.daysRemaining !== null &&
        supply.daysRemaining <= forecast.alertDaysThreshold;
      if (
        supply.supplyStatus === 'low' ||
        supply.supplyStatus === 'empty' ||
        isDepletionRisk
      ) {
        item.classList.add('consumables-item--warn');
      }

      const name = document.createElement('span');
      name.className = 'consumables-item__name';
      name.textContent = `${supply.printerName} • ${supply.name}`;
      const meta = document.createElement('span');
      meta.className = 'consumables-item__meta';
      const levelLabel =
        supply.level === null
          ? supply.supplyStatus === 'low' || supply.supplyStatus === 'empty'
            ? supply.supplyStatus
            : 'level unavailable'
          : `${supply.level.toFixed(0)}%`;
      meta.textContent = `${levelLabel} • ${formatDaysRemaining(supply.daysRemaining)}`;

      item.append(name, meta);
      forecastInkList.appendChild(item);
    }
  }
}

function applySummary(summary: SummaryResponse): void {
  earningsToday.textContent = peso(summary.earnings.today);
  jobsTotal.textContent = String(summary.jobStats.total);
  jobsPrint.textContent = String(summary.jobStats.print);
  jobsCopy.textContent = String(summary.jobStats.copy);
  jobsScan.textContent = String(summary.jobStats.scan);
  storageFiles.textContent = String(summary.storage.fileCount);
  storageBytes.textContent = formatBytes(summary.storage.bytes);
  if (owedChangeOpen) {
    owedChangeOpen.textContent = String(summary.owedChangeOpenCount);
  }
  if (owedChangeHint) {
    owedChangeHint.textContent =
      summary.owedChangeOpenCount > 0
        ? 'Manual change settlement required now.'
        : 'No unsettled change payouts.';
  }
  const openCount =
    summary.anomalyStats.openCount > 0
      ? String(summary.anomalyStats.openCount)
      : '';
  if (openAlertBadge) openAlertBadge.textContent = openCount;
  if (openAlertBadgeMob) openAlertBadgeMob.textContent = openCount;

  const total = summary.jobStats.total || 1;
  if (barPrint)
    barPrint.style.width = `${Math.round((summary.jobStats.print / total) * 100)}%`;
  if (barCopy)
    barCopy.style.width = `${Math.round((summary.jobStats.copy / total) * 100)}%`;
  if (barScan)
    barScan.style.width = `${Math.round((summary.jobStats.scan / total) * 100)}%`;
  applyConsumablesForecast(summary);
  applyInkEstimation(summary);
  updateSidebarBadges(summary);
}

async function loadData(): Promise<void> {
  const res = await apiFetch('/api/admin/summary');
  if (!res.ok) {
    if (res.status === 401) throw new Error('Invalid admin PIN.');
    throw new Error('Failed to load dashboard data.');
  }
  const summary = (await res.json()) as SummaryResponse;
  applySummary(summary);
}

refreshBtn.addEventListener('click', () => {
  setMessage('Refreshing...');
  void loadData()
    .then(() => setMessage('Dashboard refreshed.'))
    .catch((e: unknown) =>
      setMessage(e instanceof Error ? e.message : 'Refresh failed.'),
    );
});

resetBalanceBtn.addEventListener('click', () => {
  if (!window.confirm('Reset machine balance to 0?')) return;
  setMessage('Resetting balance...');
  void apiFetch('/api/admin/balance/reset', { method: 'POST' })
    .then(async (r) => {
      if (!r.ok) throw new Error('Failed to reset balance.');
      await loadData();
      setMessage('Balance reset.');
    })
    .catch((e: unknown) =>
      setMessage(e instanceof Error ? e.message : 'Failed to reset balance.'),
    );
});

resetInkBtn.addEventListener('click', () => {
  if (!window.confirm('Reset page counters for new ink refill?')) return;
  setMessage('Resetting ink counters...');
  void apiFetch('/api/admin/printer/reset-ink-counters', { method: 'POST' })
    .then(async (r) => {
      if (!r.ok) throw new Error('Failed to reset ink counters.');
      await loadData();
      setMessage('Ink counters reset.');
    })
    .catch((e: unknown) =>
      setMessage(
        e instanceof Error ? e.message : 'Failed to reset ink counters.',
      ),
    );
});

clearStorageBtn.addEventListener('click', () => {
  if (!window.confirm('Clear uploaded files in storage?')) return;
  setMessage('Clearing storage...');
  void apiFetch('/api/admin/storage/clear', { method: 'POST' })
    .then(async (r) => {
      if (!r.ok) throw new Error('Failed to clear storage.');
      await loadData();
      setMessage('Storage cleared.');
    })
    .catch((e: unknown) =>
      setMessage(e instanceof Error ? e.message : 'Failed to clear storage.'),
    );
});

function showRefreshError(error: unknown): void {
  setMessage(
    error instanceof Error ? error.message : 'Automatic refresh failed.',
  );
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
