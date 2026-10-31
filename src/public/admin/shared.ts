import {
  computeTotalNavBadge,
  DrawerController,
} from './drawer';

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
    inkSupplies: {
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
    }[];
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
      ink: {
        name: string;
        level: number | null;
        status: 'ok' | 'low' | 'empty' | 'unknown';
      }[];
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
    conversion?: {
      connected: boolean;
      status: 'operational' | 'degraded' | 'offline';
      engine: string;
      configuredPath: string;
      executableFound: boolean;
      resolvedPath: string | null;
      pipeName: string;
      pipeConnected: boolean;
      zombieTerminationEnabled: boolean;
      activeZombieProcesses: number;
      lastTerminationAt: string | null;
      totalZombiesTerminated: number;
      lastError: string | null;
      lastCheckedAt: string;
    };
  };
};

export interface PrintLimitsSettings {
  maxPagesPerSession: number;
}

export type UiBlockingMode = 'maintenance' | 'needs_admin' | 'out_of_service';

export interface UiBlockingSettings {
  enabled: boolean;
  mode: UiBlockingMode;
  customMessage: string;
}

export type SupportedDpi = 150 | 300 | 600;

export interface ScannerDpiSettings {
  copyGlass: SupportedDpi;
  copyAdf: SupportedDpi;
  scanGlass: SupportedDpi;
  scanAdf: SupportedDpi;
}

export interface DeveloperModeSettings {
  enabled: boolean;
  environmentTag: 'test';
}

export type CoverageTier = 'low' | 'medium' | 'high' | 'very_high';
export type CoverageTierRates = Record<CoverageTier, number>;

export interface PaperPricingProfile {
  paperCost: number;
  bwPrint: CoverageTierRates;
  colorPrint: CoverageTierRates;
}

export interface AdminSettings {
  pricing: {
    printPerPage: number;
    copyPerPage: number;
    copyBwPerPage?: number;
    copyColorPerPage?: number;
    scanDocument: number;
    colorSurcharge: number;
    highQualitySurcharge: number;
  };
  pricingEngine: {
    duplexEnabled?: boolean;
    paperProfiles: {
      a4: PaperPricingProfile;
      shortBond: PaperPricingProfile;
      longBond: PaperPricingProfile;
    };
    bulkDiscountTiers: {
      minPages: number;
      maxPages?: number;
      discountPerPage: number;
    }[];
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
  pipelineSettings?: {
    malwareScanningEnabled: boolean;
    documentConversionEnabled: boolean;
    colorDetectionEnabled: boolean;
  };
  printLimits?: PrintLimitsSettings;
  uiBlocking?: UiBlockingSettings;
  scannerDpi?: ScannerDpiSettings;
  developerMode?: DeveloperModeSettings;
}

export type SettingsResponse = AdminSettings;

export type LogsResponse = {
  logs: {
    id: string;
    timestamp: string;
    type: string;
    message: string;
    meta?: Record<string, string | number | boolean | null>;
  }[];
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
  buckets: {
    key: string;
    label: string;
    start: string;
    end: string;
    amount: number;
  }[];
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

  if (response.ok) {
    try {
      const data = (await response.json()) as { sessionToken?: string };
      if (data.sessionToken) setAdminToken(data.sessionToken);
    } catch {
      // Ignore JSON parse errors
    }
  }

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

  const menuBadgeEl = document.getElementById('menuBadge');
  if (menuBadgeEl) {
    const totalBadge = computeTotalNavBadge(openAlerts, openReports, openFeedback);
    menuBadgeEl.textContent = totalBadge.label;
    if (totalBadge.visible) {
      menuBadgeEl.classList.remove('hidden');
    } else {
      menuBadgeEl.classList.add('hidden');
    }
  }
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

let activeDrawerController: DrawerController | null = null;

export function initAdminShell(): void {
  const drawerEl = document.querySelector<HTMLElement>('.sidebar');
  const scrimEl = document.getElementById('drawerScrim');
  const triggerEl = document.getElementById('menuBtn');

  if (drawerEl && scrimEl && !activeDrawerController) {
    activeDrawerController = new DrawerController({
      drawerEl,
      scrimEl,
      triggerEl,
    });

    if (triggerEl) {
      triggerEl.addEventListener('click', () => {
        activeDrawerController?.toggle();
      });
    }

    const navBtns = drawerEl.querySelectorAll<HTMLElement>('.nav-btn');
    navBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        activeDrawerController?.close();
      });
    });
  }
}

export function notifyAdminDataUpdated(): void {
  // No-op (updatedAgo ticker removed)
}

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
      triggerPostAuthPushPrompt();
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
  initAdminShell();

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
        triggerPostAuthPushPrompt();
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
    showIosInstallHint();
  }

  // 4. Global Kiosk Emergency Alert Listener (Socket.IO + Audio Siren)
  initGlobalKioskAlertListener();
}

async function triggerInstallPrompt(): Promise<void> {
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
}

function showInstallButton(): void {
  const authCard = document.querySelector('.auth-card');
  if (authCard && !document.getElementById('pwaLoginInstallBtn')) {
    const loginBtn = document.createElement('button');
    loginBtn.id = 'pwaLoginInstallBtn';
    loginBtn.type = 'button';
    loginBtn.className = 'btn-pwa-login-install';
    loginBtn.innerHTML = '<span>📲 Install Admin App on Phone</span>';
    loginBtn.addEventListener('click', triggerInstallPrompt);
    authCard.appendChild(loginBtn);
  }

  if (!document.getElementById('pwaInstallBtn')) {
    const actionsContainer = document.querySelector(
      '.topbar__actions, .admin-header__actions, nav, .topbar',
    );
    if (actionsContainer) {
      const btn = document.createElement('button');
      btn.id = 'pwaInstallBtn';
      btn.type = 'button';
      btn.className = 'btn-pwa-install';
      btn.innerHTML = '<span>📲 Install App</span>';
      btn.addEventListener('click', triggerInstallPrompt);
      actionsContainer.prepend(btn);
    }
  }
}

function removeInstallButton(): void {
  document.getElementById('pwaInstallBtn')?.remove();
  document.getElementById('pwaLoginInstallBtn')?.remove();
  document.getElementById('pwaIosInstallHint')?.remove();
}

function showIosInstallHint(): void {
  const isIos = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (!isIos || document.getElementById('pwaIosInstallHint')) return;
  const authCard = document.querySelector('.auth-card');
  if (authCard) {
    const hint = document.createElement('div');
    hint.id = 'pwaIosInstallHint';
    hint.className = 'pwa-ios-install-hint';
    hint.innerHTML = '<span>📲 <strong>Install App on iPhone:</strong> Tap <strong>Share</strong> (⎋) below, then <strong>Add to Home Screen</strong>.</span>';
    authCard.appendChild(hint);
  }
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

// ── Web Push Notification & Emergency Alarm Subsystem ────────────────────

function urlB64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function registerAdminPush(): Promise<{ ok: boolean; error?: string }> {
  const isIos = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    if (isIos) {
      return {
        ok: false,
        error: 'On iPhone/iPad, push notifications require adding this app to your Home Screen first (tap Share > Add to Home Screen).',
      };
    }
    return { ok: false, error: 'Push notifications are not supported on this browser.' };
  }

  if ('Notification' in window) {
    if (Notification.permission === 'denied') {
      return {
        ok: false,
        error: 'Notifications are blocked. Please enable them in your phone browser site settings.',
      };
    }
    if (Notification.permission === 'default') {
      try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          return { ok: false, error: 'Notification permission was not granted.' };
        }
      } catch (permErr: any) {
        return { ok: false, error: permErr?.message || 'Permission request failed.' };
      }
    }
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    const res = await apiFetch('/api/admin/push/vapid-public-key');
    if (!res.ok) {
      return { ok: false, error: 'Failed to retrieve VAPID public key from kiosk.' };
    }
    const data = await res.json();
    if (!data.publicKey) {
      return { ok: false, error: 'Kiosk did not provide a valid public key.' };
    }

    const applicationServerKey = urlB64ToUint8Array(data.publicKey);
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey as unknown as BufferSource,
    });

    const subRes = await apiFetch('/api/admin/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription }),
    });

    if (!subRes.ok) {
      return { ok: false, error: 'Failed to save subscription on kiosk server.' };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Permission denied or registration failed.' };
  }
}

export async function unregisterAdminPush(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return true;
    await apiFetch('/api/admin/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    return await sub.unsubscribe();
  } catch {
    return false;
  }
}

export async function getAdminPushStatus(): Promise<'subscribed' | 'unsubscribed' | 'blocked' | 'unsupported'> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'denied') return 'blocked';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'subscribed' : 'unsubscribed';
  } catch {
    return 'unsubscribed';
  }
}

class KioskAlarmAudioController {
  private ctx: AudioContext | null = null;
  private intervalId: number | null = null;
  private isMuted = false;
  private activeOsc: OscillatorNode | null = null;

  private initCtx(): AudioContext | null {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  unlock(): void {
    const ctx = this.initCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    try {
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch {
      // Ignore
    }
  }

  start(): void {
    if (this.isMuted || this.intervalId !== null) return;
    const playBeep = () => {
      if (this.isMuted) return;
      const ctx = this.initCtx();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      this.activeOsc = osc;
      osc.type = 'square';
      osc.frequency.setValueAtTime(960, now);
      osc.frequency.setValueAtTime(770, now + 0.25);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.onended = () => {
        if (this.activeOsc === osc) {
          this.activeOsc = null;
        }
      };
      osc.start(now);
      osc.stop(now + 0.45);
    };

    playBeep();
    this.intervalId = window.setInterval(playBeep, 1200);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.activeOsc) {
      try {
        this.activeOsc.stop();
      } catch {
        // Ignore if already stopped
      }
      this.activeOsc = null;
    }
  }

  mute(): void {
    this.isMuted = true;
    this.stop();
  }

  unmute(): void {
    this.isMuted = false;
  }
}

export const kioskAlarmAudio = new KioskAlarmAudioController();

export function initGlobalKioskAlertListener(): void {
  if (typeof window === 'undefined') return;

  // Silently unlock AudioContext on first user interaction without sounding alarm
  const unlockAudio = () => {
    kioskAlarmAudio.unlock();
    window.removeEventListener('click', unlockAudio);
    window.removeEventListener('touchstart', unlockAudio);
  };
  window.addEventListener('click', unlockAudio, { once: true });
  window.addEventListener('touchstart', unlockAudio, { once: true });

  // Connect Socket.IO for in-app alert if available
  const ioGlobal = (window as any).io;
  if (typeof ioGlobal === 'function') {
    const socket = ioGlobal();

    socket.on('admin:kiosk-critical-alert', (alert: any) => {
      showEmergencyBanner(alert);
      kioskAlarmAudio.start();
    });

    socket.on('admin:kiosk-alert-cleared', () => {
      hideEmergencyBanner();
      kioskAlarmAudio.stop();
      kioskAlarmAudio.unmute();
    });
  }
}

export function triggerPostAuthPushPrompt(): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    void registerAdminPush();
  } else if (Notification.permission === 'default') {
    showPushPromptToast();
  }
}

function showEmergencyBanner(alert: { title?: string; message?: string; code?: string }): void {
  let banner = document.getElementById('kioskEmergencyBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'kioskEmergencyBanner';
    banner.className = 'kiosk-emergency-banner';
    document.body.prepend(banner);
  }

  banner.innerHTML = `
    <div class="kiosk-emergency-banner__content">
      <span class="pulse-icon">🚨</span>
      <div class="kiosk-emergency-banner__text">
        <strong>${alert.title || 'CRITICAL KIOSK ALERT'}</strong>: ${alert.message || 'Immediate physical intervention required.'}
      </div>
      <div class="kiosk-emergency-banner__actions">
        <a href="/admin/system" class="btn-emergency-action">Inspect System</a>
        <button type="button" class="btn-emergency-mute" id="muteAlarmBtn">Mute Alarm</button>
      </div>
    </div>
  `;
  banner.classList.remove('hidden');

  document.getElementById('muteAlarmBtn')?.addEventListener('click', () => {
    kioskAlarmAudio.mute();
    const btn = document.getElementById('muteAlarmBtn');
    if (btn) btn.textContent = 'Muted';
  });
}

function hideEmergencyBanner(): void {
  const banner = document.getElementById('kioskEmergencyBanner');
  if (banner) {
    banner.classList.add('hidden');
  }
}

function showPushPromptToast(): void {
  if (document.getElementById('pwaPushPromptToast')) return;
  const toast = document.createElement('div');
  toast.id = 'pwaPushPromptToast';
  toast.innerHTML = `
    <span>🔔 <strong>Enable Push Alerts?</strong> Get notified on phone/PC when Paper Jam or Paper Out occurs.</span>
    <button type="button" class="btn-push-enable" id="pushEnableNowBtn">Enable</button>
    <button type="button" class="btn-push-later" id="pushDismissPromptBtn">Later</button>
  `;
  document.body.appendChild(toast);

  document.getElementById('pushEnableNowBtn')?.addEventListener('click', async () => {
    toast.remove();
    const res = await registerAdminPush();
    if (res.ok) {
      setMessage('Push notifications enabled for this device.');
    } else {
      setMessage(res.error || 'Failed to enable push notifications.');
    }
  });

  document.getElementById('pushDismissPromptBtn')?.addEventListener('click', () => {
    toast.remove();
  });
}
