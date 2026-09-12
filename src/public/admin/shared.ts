export type InkTankEstimate = {
  pagesUsed: number;
  maxPages: number;
  remainingPercent: number;
  alertTriggered: boolean;
};

export type SummaryResponse = {
  balance: number;
  earnings: {
    today: number;
    week: number;
    allTime: number;
  };
  coinStats: {
    one: number;
    five: number;
    ten: number;
    twenty: number;
  };
  jobStats: {
    total: number;
    print: number;
    copy: number;
    scan: number;
  };
  hopperStats: {
    dispenseAttempts: number;
    dispenseSuccess: number;
    dispenseFailures: number;
    totalDispensed: number;
    lastDispensedAt: string | null;
    lastError: string | null;
    selfTestPassed: boolean | null;
    lastSelfTestAt: string | null;
  };
  owedChangeOpenCount: number;
  pendingRefundOpenCount: number;
  refundStats: {
    totalCount: number;
    openCount: number;
    refundedCount: number;
    dismissedCount: number;
    autoRefundedCount: number;
  };
  anomalyStats: {
    totalCount: number;
    openCount: number;
  };
  feedbackStats?: {
    totalCount: number;
    openCount: number;
  };
  reportStats?: {
    totalCount: number;
    openCount: number;
  };
  recoveryStats?: {
    bootCount: number;
    unexpectedRestartCount: number;
    lastStartupAt: string | null;
    lastShutdownAt: string | null;
    inFlightCount: number;
    startupPendingCount: number;
    autoRefundedCount: number;
    pendingAdminReviewCount: number;
    voidedCount: number;
  };
  jamStats: {
    totalEvents: number;
    recent24h: number;
    lastJamAt: string | null;
  };
  consumables?: {
    generatedAt: string;
    rollingWindowDays: number;
    alertDaysThreshold: number;
    paper: {
      status: 'ok' | 'insufficient_data' | 'telemetry_unavailable';
      confidence: 'high' | 'medium' | 'low';
      currentSheets: number;
      trayCapacitySheets: number;
      avgDailyUse: number | null;
      daysRemaining: number | null;
      projectedEmptyAt: string | null;
      usageEventsConsidered: number;
    };
    inkSupplies: Array<{
      printerName: string;
      name: string;
      status: 'ok' | 'insufficient_data' | 'telemetry_unavailable';
      supplyStatus: 'ok' | 'low' | 'empty' | 'unknown';
      confidence: 'high' | 'medium' | 'low';
      level: number | null;
      avgDailyDrop: number | null;
      daysRemaining: number | null;
      projectedEmptyAt: string | null;
      snapshotsConsidered: number;
      detectionMethod:
        | 'snmp'
        | 'vendor-wmi'
        | 'printer-property'
        | 'error-state'
        | 'none';
    }>;
    alerts: {
      withinThreshold: boolean;
      reasons: string[];
    };
  };
  storage: {
    fileCount: number;
    bytes: number;
  };
  // Page counts (per-day totals and all-time totals)
  pageCounts?: {
    todayColorPages: number;
    todayBwPages: number;
    totalColorPages: number;
    totalBwPages: number;
    refillColorPages: number;
    refillBwPages: number;
    lastRefillAt: string | null;
  };
  // Page-count-based ink depletion estimation
  inkEstimation?: {
    grayscale: InkTankEstimate;
    color: InkTankEstimate;
    alertThresholdPercent: number;
    anyAlertTriggered: boolean;
  };
  status: {
    serverRunning: boolean;
    uptimeSeconds: number;
    host: string;
    wifiActive: boolean;
    serial: {
      connected: boolean;
      portPath: string | null;
      lastError: string | null;
    };
    hopper: {
      connected: boolean;
      pending: boolean;
      portPath: string | null;
      lastError: string | null;
      lastSuccessAt: string | null;
    };
    watchdog?: {
      running: boolean;
      watchdogPid: number | null;
      consecutiveFailures: number;
      recoveryAttempts: number;
      backoffDelayMs: number;
      nextRecoveryAt: string | null;
      lastAction: string;
      lastError: string | null;
      lastUpdatedAt: string;
    };
    printer: {
      connected: boolean;
      name: string | null;
      driverName: string | null;
      portName: string | null;
      connectionType?: 'usb' | 'network' | 'wsd' | 'virtual' | 'unknown';
      status: string;
      statusFlags?: string[];
      ink: Array<{
        name: string;
        level: number | null;
        status: 'ok' | 'low' | 'empty' | 'unknown';
      }>;
      inkDetectionMethod?:
        | 'snmp'
        | 'vendor-wmi'
        | 'printer-property'
        | 'error-state'
        | 'none';
      targetPrinterName?: string | null;
      targetIsDefault?: boolean;
      inkTelemetryAvailable?: boolean;
      inkTelemetryReason?: string | null;
      lastCheckedAt: string;
      lastError: string | null;
    };
  };
};

export type SettingsResponse = {
  pricing: {
    printPerPage: number;
    copyPerPage: number;
    scanDocument: number;
    colorSurcharge: number;
    highQualitySurcharge: number;
  };
  pricingEngine: {
    paperProfiles: {
      a4: { baseBwPrice: number; baseColorPrice: number };
      shortBond: { baseBwPrice: number; baseColorPrice: number };
      longBond: { baseBwPrice: number; baseColorPrice: number };
    };
    bulkDiscountTiers: Array<{
      minPages: number;
      maxPages?: number;
      discountPerPage: number;
    }>;
    rounding: 'whole_peso_total_only';
    highQualitySurcharge: number;
  };
  idleTimeoutSeconds: number;
  idleScreenTimeoutSeconds: number;
  adminPin: string;
  adminLocalOnly: boolean;
  inkMonitoring: {
    enabled: boolean;
    targetPrinterName: string | null;
    lowThresholdPercent: number;
    criticalThresholdPercent: number;
    blockOnLow: boolean;
    blockOnEmpty: boolean;
    telemetryUnknownPolicy: 'warn_allow' | 'block';
  };
  consumablesForecasting: {
    enabled: boolean;
    rollingWindowDays: number;
    alertDaysThreshold: number;
    paperTrayCapacitySheets: number;
    paperCurrentSheets: number;
    paperRefillUpdatedAt: string | null;
  };
  alerts: {
    severityThreshold: 'warning' | 'critical';
    dashboard: {
      enabled: boolean;
    };
    email: {
      enabled: boolean;
      smtpHost: string;
      smtpPort: number;
      secure: boolean;
      username: string;
      from: string;
      to: string;
    };
    dedupe: {
      printerMs: number;
      spoolerMs: number;
      serialMs: number;
      hopperMs: number;
      networkMs: number;
      securityMs: number;
    };
  };
  scanFilenameFormat?: {
    prefix: string;
    dateFormat: 'YYYY-MM-DD' | 'YYYYMMDD' | 'DD-MM-YYYY' | 'none';
    timeFormat: 'HH-mm-ss' | 'HHmmss' | 'HHmm' | 'none';
    includeRandomSuffix: boolean;
    customPatternEnabled: boolean;
    customPattern: string;
  };
};

export type LogsResponse = {
  logs: Array<{
    id: string;
    timestamp: string;
    type: string;
    message: string;
    meta?: Record<string, string | number | boolean | null>;
  }>;
};

export type EarningsAnalyticsView = 'daily' | 'weekly' | 'monthly' | 'yearly';

export type EarningsAnalyticsResponse = {
  view: EarningsAnalyticsView;
  anchorDate: string;
  period: {
    start: string;
    end: string;
    label: string;
  };
  totals: {
    today: number;
    week: number;
    month: number;
    year: number;
    allTime: number;
    period: number;
  };
  buckets: Array<{
    key: string;
    label: string;
    start: string;
    end: string;
    amount: number;
  }>;
  methods: {
    print: number;
    copy: number;
    scan: number;
    total: number;
    topMode: 'print' | 'copy' | 'scan' | null;
  };
};

// ── PIN state via sessionStorage ─────────────────────────────────

const PIN_KEY = 'printbit.adminPin';
const TOKEN_KEY = 'adminSessionToken';
const SESSION_HINT_KEY = 'printbit.adminSessionActive';

export function getAdminPin(): string {
  return sessionStorage.getItem(PIN_KEY) ?? '';
}

export function setAdminPin(pin: string): void {
  sessionStorage.setItem(PIN_KEY, pin);
}

export function clearAdminPin(): void {
  sessionStorage.removeItem(PIN_KEY);
}

export function getAdminToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

export function setAdminToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

function setAdminSessionHint(active: boolean): void {
  if (active) {
    sessionStorage.setItem(SESSION_HINT_KEY, '1');
    return;
  }
  sessionStorage.removeItem(SESSION_HINT_KEY);
}

function hasAdminSessionHint(): boolean {
  return sessionStorage.getItem(SESSION_HINT_KEY) === '1' || Boolean(getAdminToken());
}

// ── Utilities ────────────────────────────────────────────────────

export function peso(value: number): string {
  return `₱ ${value.toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  const token = getAdminToken();
  if (token) headers.set('x-admin-token', token);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(path, { ...init, headers, credentials: 'include' });
}

// ── Auth helpers ─────────────────────────────────────────────────

export async function ensureAuth(): Promise<boolean> {
  const headers = new Headers();
  const token = getAdminToken();
  if (token) headers.set('x-admin-token', token);

  const response = await fetch('/api/admin/verify', {
    method: 'POST',
    headers,
    credentials: 'include',
  });

  return response.ok;
}

let messageEl: HTMLElement | null = null;

function resolveVisibleMessageEl(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      '#adminMessage, #adminAuthError, #messageBanner, .auth-msg, .topbar__msg',
    ),
  );
  if (candidates.length === 0) return null;

  const isInsideHidden = (el: HTMLElement): boolean => {
    let curr: HTMLElement | null = el.parentElement;
    while (curr && curr !== document.body) {
      if (curr.classList.contains('hidden')) {
        return true;
      }
      curr = curr.parentElement;
    }
    return false;
  };

  const active = candidates.filter((el) => !isInsideHidden(el));
  if (active.length > 0) {
    const unhidden = active.find((el) => !el.classList.contains('hidden'));
    return unhidden ?? active[0];
  }

  return candidates[0];
}

export function setMessage(text: string): void {
  messageEl = resolveVisibleMessageEl();
  if (messageEl) {
    messageEl.textContent = text;
    if (text) {
      messageEl.classList.remove('hidden');
    } else if (
      messageEl.id === 'messageBanner' ||
      messageEl.id === 'adminAuthError'
    ) {
      messageEl.classList.add('hidden');
    }
  }
}

export function updateSidebarBadges(summary: SummaryResponse): void {
  const openFeedback = summary.feedbackStats?.openCount ?? 0;
  const openReports = summary.reportStats?.openCount ?? 0;
  const openAlerts = summary.anomalyStats?.openCount ?? 0;

  const setBadge = (id: string, count: number) => {
    const el = document.getElementById(id);
    if (el) el.textContent = count > 0 ? String(count) : '';
  };

  setBadge('openBadge', openFeedback);
  setBadge('openBadgeMob', openFeedback);
  setBadge('openReportBadge', openReports);
  setBadge('openReportBadgeMob', openReports);
  setBadge('openAlertBadge', openAlerts);
  setBadge('openAlertBadgeMob', openAlerts);
}

export type InitAuthOptions = {
  onSuccess: (signal: AbortSignal) => void | Promise<void>;
  formId?: string;
  errorId?: string;
  viewId?: string;
  mainId?: string;
  logoutId?: string;
};

export type InitAuthArg =
  | ((signal: AbortSignal) => void | Promise<void>)
  | InitAuthOptions;

/**
 * Initialises the auth gate UI. Call once from each admin sub-page.
 *
 * @param arg – either an onSuccess callback or an InitAuthOptions configuration object.
 * @returns a cleanup function that stops the auto-refresh timer.
 */
export function initAuth(arg: InitAuthArg): () => void {
  const options: InitAuthOptions =
    typeof arg === 'function' ? { onSuccess: arg } : arg;

  const authView = document.getElementById(
    options.viewId ?? 'adminAuthView',
  ) as HTMLElement | null;
  const dashboard = document.getElementById(
    options.mainId ?? 'adminDashboard',
  ) as HTMLElement | null;
  const authForm = document.getElementById(
    options.formId ?? 'adminAuthForm',
  ) as HTMLFormElement | null;
  const pinInput =
    authForm?.querySelector<HTMLInputElement>(
      'input[type="password"], input[name="pin"], #adminPinInput',
    ) ??
    (document.getElementById('adminPinInput') as HTMLInputElement | null);
  const logoutBtn = document.getElementById(
    options.logoutId ?? 'logoutBtn',
  ) as HTMLButtonElement | null;
  let authOperation = 0;
  let initializationController = new AbortController();

  function beginAuthOperation(): {
    operation: number;
    signal: AbortSignal;
  } {
    initializationController.abort();
    initializationController = new AbortController();
    authOperation += 1;
    return {
      operation: authOperation,
      signal: initializationController.signal,
    };
  }

  function invalidateAuthOperation(): void {
    authOperation += 1;
    initializationController.abort();
  }

  function showDashboard(visible: boolean): void {
    if (visible) {
      document.documentElement.classList.add('admin-session-active');
    } else {
      document.documentElement.classList.remove('admin-session-active');
    }
    if (authView) authView.classList.toggle('hidden', visible);
    if (dashboard) dashboard.classList.toggle('hidden', !visible);
  }

  async function unlock(pin: string): Promise<boolean> {
    const { operation, signal } = beginAuthOperation();
    try {
      const response = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pin }),
      });
      if (operation !== authOperation) return false;
      if (!response.ok) {
        let errorMessage = 'Invalid admin PIN.';
        try {
          const errorBody = (await response.json()) as unknown;
          if (
            errorBody &&
            typeof errorBody === 'object' &&
            'error' in errorBody &&
            typeof (errorBody as { error: unknown }).error === 'string' &&
            (errorBody as { error: string }).error.trim()
          ) {
            errorMessage = (errorBody as { error: string }).error;
          }
        } catch {
          // Ignore JSON parse errors and fall back to default message
        }
        throw new Error(errorMessage);
      }

      const data = (await response.json()) as {
        ok: boolean;
        sessionToken?: string;
      };
      if (operation !== authOperation) return false;
      if (data.sessionToken) setAdminToken(data.sessionToken);
      setAdminSessionHint(true);

      showDashboard(true);
      await options.onSuccess(signal);
      if (operation !== authOperation || signal.aborted) return false;
      return true;
    } catch (error) {
      if (operation !== authOperation) return false;
      throw error;
    }
  }

  if (authForm && pinInput) {
    authForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const pin = pinInput.value.trim();
      if (!pin) {
        setMessage('Please enter admin PIN.');
        return;
      }
      setMessage('Unlocking admin panel...');
      void unlock(pin)
        .then((authenticated) => {
          if (authenticated) setMessage('Admin panel unlocked.');
        })
        .catch((err: unknown) => {
          const msg =
            err instanceof Error ? err.message : 'Failed to unlock admin panel.';
          setMessage(msg);
          showDashboard(false);
        });
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      invalidateAuthOperation();
      const token = getAdminToken();
      clearAdminToken();
      setAdminSessionHint(false);
      showDashboard(false);
      setMessage('Admin panel locked.');
      void fetch('/api/admin/logout', {
        method: 'POST',
        headers: { 'x-admin-token': token },
        credentials: 'include',
      }).catch(() => undefined);
    });
  }

  // Pre-unhide dashboard if this tab recently held a verified admin session.
  if (hasAdminSessionHint()) {
    showDashboard(true);
  }

  // Initialize PWA features (service worker, offline banner, install trigger)
  initPWA();

  // On startup, check for an existing valid session (httpOnly cookie sent
  // automatically) and show the dashboard immediately if authenticated.
  const startupOperation = authOperation;
  const startupSignal = initializationController.signal;
  void ensureAuth()
    .then(async (authenticated) => {
      if (startupOperation !== authOperation) return;
      if (authenticated) {
        setAdminSessionHint(true);
        showDashboard(true);
        await options.onSuccess(startupSignal);
        return;
      }
      clearAdminToken();
      setAdminSessionHint(false);
      showDashboard(false);
    })
    .catch(() => {
      if (startupOperation !== authOperation) return;
      clearAdminToken();
      setAdminSessionHint(false);
      showDashboard(false);
    });

  const handlePageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return;

    invalidateAuthOperation();
    if (!hasAdminSessionHint()) {
      clearAdminToken();
      showDashboard(false);
      return;
    }

    window.location.reload();
  };
  window.addEventListener('pageshow', handlePageShow);

  return () => window.removeEventListener('pageshow', handlePageShow);
}

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;

export function initPWA(): void {
  if (typeof window === 'undefined') return;

  // 1. Offline banner management
  let banner = document.getElementById('adminOfflineBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'adminOfflineBanner';
    banner.className = 'hidden';
    banner.innerHTML =
      '<span>⚠️ You are currently offline. Real-time telemetry and hardware controls are paused.</span>';
    document.body.prepend(banner);
  }

  const updateOnlineStatus = () => {
    const isOffline = !navigator.onLine;
    document.body.classList.toggle('kiosk-offline', isOffline);
    banner?.classList.toggle('hidden', !isOffline);
  };

  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus();

  // 2. Service Worker Registration
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    navigator.serviceWorker
      .register('/admin/sw.js', { scope: '/admin/' })
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateToast(newWorker);
            }
          });
        });
      })
      .catch((err) => console.warn('[PWA] SW registration failed:', err));
  }

  // 3. In-App Install Prompt
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as NavigatorWithStandalone).standalone === true;

  if (!isStandalone) {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e as BeforeInstallPromptEvent;
      showInstallButton();
    });

    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      removeInstallButton();
    });
  }
}

function showInstallButton(): void {
  if (document.getElementById('pwaInstallBtn')) return;
  const actionsContainer = document.querySelector(
    '.topbar__actions, .admin-header__actions, nav, .topbar',
  );
  if (!actionsContainer) return;

  const btn = document.createElement('button');
  btn.id = 'pwaInstallBtn';
  btn.type = 'button';
  btn.className = 'btn-pwa-install';
  btn.innerHTML = '<span>📲 Install App</span>';
  btn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try {
      const choice = await deferredPrompt.userChoice;
      if (choice?.outcome === 'accepted') {
        removeInstallButton();
      }
    } catch {
      // Ignore user choice errors
    }
    deferredPrompt = null;
  });
  actionsContainer.prepend(btn);
}

function removeInstallButton(): void {
  const btn = document.getElementById('pwaInstallBtn');
  btn?.remove();
}

function showUpdateToast(worker: ServiceWorker): void {
  if (document.getElementById('pwaUpdateToast')) return;
  const toast = document.createElement('div');
  toast.id = 'pwaUpdateToast';
  toast.innerHTML = `
    <span>A newer version of PB Admin is available.</span>
    <button type="button" class="btn-pwa-install" id="pwaReloadBtn">Reload</button>
  `;
  document.body.appendChild(toast);
  document.getElementById('pwaReloadBtn')?.addEventListener('click', () => {
    worker.postMessage({ type: 'SKIP_WAITING' });
    window.location.reload();
  });
}
