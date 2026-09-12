import QRCode from 'qrcode';
import {
  initializePageIdleTimeout,
  setupPageIdleWarningButton,
} from '@/services/idle-timeout';
import { initKioskLocalization } from '../shared/kiosk-i18n';
import { navigateWithKioskMotion } from '../shared/kiosk-navigation';
import { attachPowerSafetyOverlay } from '../shared/power-safety-overlay';
import { resolveWifiTroubleshootingDetails } from '../shared/wifi-troubleshooting';

attachPowerSafetyOverlay();

type UploadedFile = {
  documentId?: string;
  filename: string;
  size?: number;
  sizeBytes?: number;
  analysisStatus?: 'pending' | 'completed' | 'failed';
  analysisError?: string | null;
};

const bootKioskLocalization = (): void => {
  void initKioskLocalization().catch((error: unknown) => {
    console.error('[i18n] Failed to initialize localization.', error);
  });
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootKioskLocalization, {
    once: true,
  });
} else {
  bootKioskLocalization();
}

type SessionResponse = {
  sessionId: string;
  token: string;
  status: 'pending' | 'uploaded';
  uploadUrl: string;
  remainingSeconds?: number;
  warningThresholdSeconds?: number;
  /** Single document (legacy) */
  document?: UploadedFile;
  /** Multiple documents (preferred) */
  documents?: UploadedFile[];
};

type DeleteDocumentResponse = {
  success: boolean;
  removedDocumentId: string;
  remainingCount: number;
  deletedFile: boolean;
};

type HotspotConfig = {
  provider?: 'esp32';
  ssid?: string;
  password?: string;
  authType?: string;
  captivePortalPath?: string;
  startsManagedHotspot?: boolean;
};

// ── DOM refs ──────────────────────────────────────────────────────────────────

const uploadLink = document.getElementById(
  'uploadLink',
) as HTMLAnchorElement | null;
const openUploadBtn = document.getElementById(
  'openUploadBtn',
) as HTMLButtonElement | null;
const refreshSessionBtn = document.getElementById(
  'refreshSessionBtn',
) as HTMLButtonElement | null;
const refreshSessionBtnLabel = document.getElementById(
  'refreshSessionBtnLabel',
) as HTMLElement | null;
const continueBtn = document.getElementById(
  'continueBtn',
) as HTMLButtonElement | null;
const sessionText = document.getElementById(
  'sessionText',
) as HTMLElement | null;
const sessionDot = document.getElementById('sessionDot') as HTMLElement | null;
const uploadQrCanvas = document.getElementById(
  'uploadQrCanvas',
) as HTMLCanvasElement | null;
const startupWifiQrCanvas = document.getElementById(
  'startupWifiQrCanvas',
) as HTMLCanvasElement | null;
const filesEmpty = document.getElementById('filesEmpty') as HTMLElement | null;
const fileList = document.getElementById('fileList') as HTMLUListElement | null;
const filesCount = document.getElementById('filesCount') as HTMLElement | null;
const footerHint = document.getElementById('footerHint') as HTMLElement | null;
const qrStepLabelEl = document.getElementById(
  'qrStepLabel',
) as HTMLElement | null;
const startupOnboardingOverlay = document.getElementById(
  'startupOnboardingOverlay',
) as HTMLElement | null;
const startupContinueBtn = document.getElementById(
  'startupContinueBtn',
) as HTMLButtonElement | null;
const showWifiModalBtn = document.getElementById(
  'showWifiModalBtn',
) as HTMLButtonElement | null;
const wifiSsidVal = document.getElementById('wifiSsidVal');
const wifiPasswordVal = document.getElementById('wifiPasswordVal');
const mobileGuideTextEl = document.getElementById(
  'mobileGuideText',
) as HTMLElement | null;
const conversionOverlay = document.getElementById(
  'conversionOverlay',
) as HTMLElement | null;
const conversionMessage = document.getElementById(
  'conversionMessage',
) as HTMLElement | null;
const conversionCancelBtn = document.getElementById(
  'conversionCancel',
) as HTMLButtonElement | null;

// ── State ─────────────────────────────────────────────────────────────────────

let activeSessionId = '';
let activeSessionToken = '';
let pollHandle: number | null = null;
let selectedFilename = '';
let selectedDocumentId = '';
let knownFiles = new Set<string>();
let deletingDocumentIds = new Set<string>();
let lastRenderedFileSignature = '';
let attachedSessionId: string | null = null;
let hotspotConfig: HotspotConfig | null = null;
let sessionWarningThresholdSeconds = 60;
const SESSION_COUNTDOWN_TICK_MS = 1000;
const NEW_SESSION_COOLDOWN_MS = 15_000;
const NEW_SESSION_COOLDOWN_STORAGE_KEY = 'printbit.newSessionCooldownUntilMs';
let sessionCountdownBaselineSeconds: number | null = null;
let sessionCountdownSyncedAtMs: number | null = null;
let sessionCountdownHandle: number | null = null;
let newSessionCooldownUntilMs = 0;
let newSessionCooldownHandle: number | null = null;
let createSessionInFlight = false;
let conversionWaitCancelled = false;
let conversionWaitInFlight = false;
let conversionReturnFocus: HTMLElement | null = null;
const refreshSessionDefaultLabel =
  refreshSessionBtnLabel?.textContent?.trim() ?? 'New session';

// ── Helpers ───────────────────────────────────────────────────────────────────

function setSessionText(text: string): void {
  if (sessionText) sessionText.textContent = text;
}

function setSessionActive(active: boolean): void {
  sessionDot?.classList.toggle('active', active);
}

function formatCountdown(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function stopSessionCountdownTicker(): void {
  if (sessionCountdownHandle !== null) {
    window.clearInterval(sessionCountdownHandle);
    sessionCountdownHandle = null;
  }
}

function resetSessionCountdown(): void {
  stopSessionCountdownTicker();
  sessionCountdownBaselineSeconds = null;
  sessionCountdownSyncedAtMs = null;
}

function getCurrentSessionRemainingSeconds(): number | null {
  if (
    sessionCountdownBaselineSeconds === null ||
    sessionCountdownSyncedAtMs === null
  ) {
    return null;
  }
  const elapsedSeconds = Math.floor(
    (Date.now() - sessionCountdownSyncedAtMs) / 1000,
  );
  return Math.max(sessionCountdownBaselineSeconds - elapsedSeconds, 0);
}

function renderSessionCountdown(remainingSeconds: number): void {
  if (!activeSessionId) return;
  const countdown = formatCountdown(remainingSeconds);
  // setSessionText(`${activeSessionId} • Expires in ${countdown}`);
  if (!footerHint) return;

  if (remainingSeconds <= sessionWarningThresholdSeconds) {
    footerHint.textContent = `Session expires in ${countdown}. Continue soon.`;
    footerHint.classList.remove('ready');
    return;
  }

  footerHint.classList.add('ready');
}

function startSessionCountdownTicker(): void {
  if (sessionCountdownHandle !== null) return;
  sessionCountdownHandle = window.setInterval(() => {
    if (!activeSessionId) {
      resetSessionCountdown();
      return;
    }
    const remainingSeconds = getCurrentSessionRemainingSeconds();
    if (remainingSeconds === null) return;
    renderSessionCountdown(remainingSeconds);
    if (remainingSeconds === 0) {
      stopSessionCountdownTicker();
    }
  }, SESSION_COUNTDOWN_TICK_MS);
}

function updateSessionCountdown(remainingSeconds?: number): void {
  if (!activeSessionId || typeof remainingSeconds !== 'number') return;
  sessionCountdownBaselineSeconds = Math.max(0, Math.floor(remainingSeconds));
  sessionCountdownSyncedAtMs = Date.now();
  renderSessionCountdown(sessionCountdownBaselineSeconds);
  startSessionCountdownTicker();
}

function getNewSessionCooldownRemainingMs(): number {
  return Math.max(0, newSessionCooldownUntilMs - Date.now());
}

function renderRefreshSessionButtonState(): void {
  if (!refreshSessionBtn) return;
  const remainingMs = getNewSessionCooldownRemainingMs();
  const inCooldown = remainingMs > 0;
  const isDisabled = createSessionInFlight || inCooldown;
  refreshSessionBtn.disabled = isDisabled;
  refreshSessionBtn.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');

  if (!refreshSessionBtnLabel) return;
  if (createSessionInFlight) {
    refreshSessionBtnLabel.textContent = 'Creating session…';
    return;
  }
  if (inCooldown) {
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    refreshSessionBtnLabel.textContent = `New session (${remainingSeconds}s)`;
    return;
  }
  refreshSessionBtnLabel.textContent = refreshSessionDefaultLabel;
}

function stopNewSessionCooldownTicker(): void {
  if (newSessionCooldownHandle !== null) {
    window.clearInterval(newSessionCooldownHandle);
    newSessionCooldownHandle = null;
  }
}

function syncNewSessionCooldownState(): void {
  if (getNewSessionCooldownRemainingMs() <= 0) {
    newSessionCooldownUntilMs = 0;
    sessionStorage.removeItem(NEW_SESSION_COOLDOWN_STORAGE_KEY);
    stopNewSessionCooldownTicker();
  }
  renderRefreshSessionButtonState();
}

function ensureNewSessionCooldownTicker(): void {
  if (newSessionCooldownHandle !== null) return;
  newSessionCooldownHandle = window.setInterval(
    syncNewSessionCooldownState,
    SESSION_COUNTDOWN_TICK_MS,
  );
}

function hydrateNewSessionCooldownState(): void {
  const storedValue = sessionStorage.getItem(NEW_SESSION_COOLDOWN_STORAGE_KEY);
  if (!storedValue) {
    renderRefreshSessionButtonState();
    return;
  }

  const parsedCooldownUntil = Number.parseInt(storedValue, 10);
  if (!Number.isFinite(parsedCooldownUntil)) {
    sessionStorage.removeItem(NEW_SESSION_COOLDOWN_STORAGE_KEY);
    renderRefreshSessionButtonState();
    return;
  }

  newSessionCooldownUntilMs = parsedCooldownUntil;
  if (getNewSessionCooldownRemainingMs() > 0) {
    ensureNewSessionCooldownTicker();
  } else {
    newSessionCooldownUntilMs = 0;
    sessionStorage.removeItem(NEW_SESSION_COOLDOWN_STORAGE_KEY);
  }
  renderRefreshSessionButtonState();
}

function startNewSessionCooldown(): void {
  newSessionCooldownUntilMs = Date.now() + NEW_SESSION_COOLDOWN_MS;
  sessionStorage.setItem(
    NEW_SESSION_COOLDOWN_STORAGE_KEY,
    String(newSessionCooldownUntilMs),
  );
  renderRefreshSessionButtonState();
  ensureNewSessionCooldownTicker();
}

function showNewSessionCooldownHint(): void {
  if (!footerHint) return;
  const remainingSeconds = Math.ceil(getNewSessionCooldownRemainingMs() / 1000);
  if (remainingSeconds <= 0) return;
  footerHint.textContent = `Please wait ${remainingSeconds}s before starting a new session.`;
  footerHint.classList.remove('ready');
}

function requestNewSession(): void {
  const remainingMs = getNewSessionCooldownRemainingMs();
  if (remainingMs > 0) {
    showNewSessionCooldownHint();
    renderRefreshSessionButtonState();
    return;
  }
  startNewSessionCooldown();
  void createSession();
}

function setFilesCount(n: number): void {
  if (!filesCount) return;
  filesCount.textContent = n === 1 ? '1 file' : `${n} files`;
  filesCount.classList.toggle('has-files', n > 0);
}

/** Map a filename extension to a SVG sprite id */
function iconIdForFile(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'icon-pdf';
  if (ext === 'doc' || ext === 'docx') return 'icon-doc';
  if (ext === 'xls' || ext === 'xlsx') return 'icon-xls';
  if (ext === 'ppt' || ext === 'pptx') return 'icon-ppt';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff'].includes(ext))
    return 'icon-img';
  return 'icon-txt';
}

/** Format bytes → human-readable string */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileKey(file: UploadedFile): string {
  const bytes = file.size ?? file.sizeBytes ?? -1;
  return `${file.documentId || file.filename}::${file.filename}::${bytes}`;
}

function filesSignature(files: UploadedFile[]): string {
  return files.map((file) => fileKey(file)).join('|');
}

// ── File list rendering ───────────────────────────────────────────────────────

function clearSelectedFileState(): void {
  selectedFilename = '';
  selectedDocumentId = '';
  sessionStorage.removeItem('printbit.uploadedFile');
  sessionStorage.removeItem('printbit.uploadedDocumentId');
}

function setWaitingForFilesState(): void {
  clearSelectedFileState();
  knownFiles = new Set<string>();
  lastRenderedFileSignature = '';
  sessionStorage.removeItem('printbit.uploadedFiles');
  sessionStorage.removeItem('printbit.largePrintNoticeShown');
  setFilesCount(0);
  filesEmpty?.classList.remove('hidden');
  fileList?.classList.add('hidden');
  if (continueBtn) {
    continueBtn.disabled = true;
    continueBtn.setAttribute('aria-disabled', 'true');
  }
  if (footerHint) {
    footerHint.classList.remove('ready');
  }
}

function selectFile(file: UploadedFile): void {
  const resolvedDocumentId = file.documentId || file.filename;
  selectedFilename = file.filename;
  selectedDocumentId = resolvedDocumentId;
  sessionStorage.setItem('printbit.uploadedFile', file.filename);
  sessionStorage.setItem('printbit.uploadedDocumentId', resolvedDocumentId);

  // Update aria-selected on all items
  fileList?.querySelectorAll('.file-item').forEach((el) => {
    const fileEl = el as HTMLElement;
    const selected =
      fileEl.dataset.filename === file.filename &&
      fileEl.dataset.documentId === resolvedDocumentId;
    el.setAttribute('aria-selected', String(selected));
  });

  // Enable continue button
  if (continueBtn) {
    continueBtn.disabled = false;
    continueBtn.setAttribute('aria-disabled', 'false');
  }

  if (footerHint) {
    footerHint.classList.add('ready');
  }
}

async function deleteSessionFile(file: UploadedFile): Promise<void> {
  if (!activeSessionId) return;
  const documentId = file.documentId || file.filename;
  if (!documentId || deletingDocumentIds.has(documentId)) return;
  deletingDocumentIds.add(documentId);

  try {
    if (!activeSessionToken) {
      if (footerHint) {
        footerHint.textContent =
          'Missing session token. Start a new session to remove files.';
        footerHint.classList.remove('ready');
      }
      return;
    }
    const response = await fetch(
      `/api/wireless/sessions/${encodeURIComponent(activeSessionId)}/documents/${encodeURIComponent(documentId)}?token=${encodeURIComponent(activeSessionToken)}`,
      { method: 'DELETE' },
    );

    if (!response.ok) {
      let message = 'Failed to delete file.';
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload.error) message = payload.error;
      } catch {
        /* leave default */
      }
      if (footerHint) {
        footerHint.textContent = message;
        footerHint.classList.remove('ready');
      }
      return;
    }

    let payload: DeleteDocumentResponse | null = null;
    try {
      payload = (await response.json()) as DeleteDocumentResponse;
    } catch {
      payload = null;
    }

    await checkUploadStatus();

    if (footerHint) {
      footerHint.textContent =
        payload?.remainingCount === 0
          ? 'No files in this session. Upload a new file to continue.'
          : `"${file.filename}" removed.`;
      footerHint.classList.toggle('ready', Boolean(payload?.remainingCount));
    }
  } catch {
    if (footerHint) {
      footerHint.textContent = 'Network error while deleting file.';
      footerHint.classList.remove('ready');
    }
  } finally {
    deletingDocumentIds.delete(documentId);
  }
}

function addFileToList(file: UploadedFile): void {
  if (!fileList) return;
  const key = fileKey(file);
  if (knownFiles.has(key)) return;
  knownFiles.add(key);

  const ext = file.filename.split('.').pop()?.toUpperCase() ?? 'FILE';
  const icon = iconIdForFile(file.filename);

  const li = document.createElement('li');
  li.className = 'file-item';
  li.role = 'option';
  li.setAttribute('aria-selected', 'false');
  li.dataset.filename = file.filename;
  li.dataset.documentId = file.documentId || file.filename;

  li.innerHTML = `
    <div class="file-item__icon" aria-hidden="true">
      <svg><use href="#${icon}"/></svg>
    </div>
    <div class="file-item__info">
      <p class="file-item__name">${escapeHtml(file.filename)}</p>
      <div class="file-item__meta">
        <span class="file-item__ext">${escapeHtml(ext)}</span>
        ${file.size !== undefined ? `<span>${formatBytes(file.size)}</span>` : ''}
        <span class="file-analysis-status" style="display:none"></span>
      </div>
    </div>
    <div class="file-item__actions">
      <button
        type="button"
        class="file-item__delete"
        aria-label="Delete ${escapeHtml(file.filename)}"
      >
        Remove
      </button>
      <div class="file-item__radio" aria-hidden="true"></div>
    </div>
  `;

  li.addEventListener('click', () => selectFile(file));
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectFile(file);
    }
  });

  const deleteBtn = li.querySelector(
    '.file-item__delete',
  ) as HTMLButtonElement | null;
  deleteBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void deleteSessionFile(file);
  });

  fileList.appendChild(li);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderFiles(files: UploadedFile[]): void {
  const prevSelected = selectedDocumentId;
  lastRenderedFileSignature = filesSignature(files);
  knownFiles = new Set<string>();

  if (fileList) {
    fileList.innerHTML = '';
  }

  if (files.length === 0) {
    setWaitingForFilesState();
    return;
  }

  files.forEach(addFileToList);
  setFilesCount(files.length);
  filesEmpty?.classList.add('hidden');
  fileList?.classList.remove('hidden');
  sessionStorage.setItem(
    'printbit.uploadedFiles',
    JSON.stringify(files.map((f) => f.filename)),
  );

  const selected =
    files.find((f) => (f.documentId || f.filename) === prevSelected) ??
    files[0];
  selectFile(selected);
}

// ── Session management ────────────────────────────────────────────────────────

function normalizeLocalUploadUrl(uploadUrl: string): string {
  try {
    const parsed = new URL(uploadUrl);
    if (!parsed.pathname.startsWith('/upload/')) return uploadUrl;

    const isLoopbackHost = (host: string): boolean => {
      const normalized = host.trim().toLowerCase();
      return (
        normalized === '' ||
        normalized === 'localhost' ||
        normalized === '127.0.0.1' ||
        normalized === '::1'
      );
    };

    // Keep backend-provided LAN/IP host when available. Rewriting to kiosk
    // origin can break phone uploads when kiosk UI is opened on localhost.
    if (!isLoopbackHost(parsed.hostname)) return parsed.toString();

    const currentHost = window.location.hostname;
    if (isLoopbackHost(currentHost)) return parsed.toString();
    const pathWithQuery = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return new URL(pathWithQuery, window.location.origin).toString();
  } catch {
    return uploadUrl;
  }
}

function renderStartupOnboarding(): void {
  const details = resolveWifiTroubleshootingDetails(hotspotConfig);
  if (wifiSsidVal) wifiSsidVal.textContent = details.ssid;
  if (wifiPasswordVal) {
    wifiPasswordVal.textContent = details.isPasswordRequired
      ? details.password
      : 'Open (No password required)';
  }

  if (startupWifiQrCanvas) {
    void QRCode.toCanvas(startupWifiQrCanvas, details.qrPayload, {
      width: 180,
      margin: 1,
      color: { dark: '#1a1a2e', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
  }
}

function updateUploadLink(uploadUrl: string): void {
  const normalizedUrl = normalizeLocalUploadUrl(uploadUrl);
  renderStartupOnboarding();

  if (!normalizedUrl) return;

  let href: string;
  try {
    const parsed = new URL(normalizedUrl);
    const currentOrigin = window.location.origin;
    href = parsed.origin === currentOrigin ? parsed.pathname : normalizedUrl;
  } catch {
    href = normalizedUrl;
  }

  if (uploadLink) {
    uploadLink.href = href;
    uploadLink.textContent = normalizedUrl;
  }

  if (openUploadBtn) {
    openUploadBtn.onclick = () => window.open(href, '_blank');
  }

  if (qrStepLabelEl) qrStepLabelEl.textContent = 'Scan upload QR';
  if (mobileGuideTextEl) {
    mobileGuideTextEl.innerHTML =
      'Join PrintBit Wi-Fi first, then scan the upload QR.';
  }

  if (uploadQrCanvas) {
    void QRCode.toCanvas(uploadQrCanvas, normalizedUrl, {
      width: 220,
      margin: 1,
      color: { dark: '#1a1a2e', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
  }
}

async function createSession(): Promise<void> {
  if (createSessionInFlight) return;
  createSessionInFlight = true;
  renderRefreshSessionButtonState();

  try {
    if (pollHandle !== null) {
      window.clearInterval(pollHandle);
      pollHandle = null;
    }
    resetSessionCountdown();
    activeSessionId = '';
    activeSessionToken = '';

    if (!hotspotConfig) {
      try {
        const cfgRes = await fetch('/api/config/hotspot');
        if (cfgRes.ok) hotspotConfig = (await cfgRes.json()) as HotspotConfig;
      } catch {
        /* non-critical */
      }
    }
    renderStartupOnboarding();

    if (hotspotConfig?.startsManagedHotspot) {
      try {
        await fetch('/api/hotspot/start', { method: 'POST' });
      } catch {
        /* best-effort */
      }
    }

    // Reset UI
    clearSelectedFileState();
    knownFiles = new Set<string>();
    deletingDocumentIds = new Set<string>();
    setSessionActive(false);
    setSessionText('Creating session…');
    setWaitingForFilesState();

    if (fileList) {
      fileList.innerHTML = '';
    }

    const response = await fetch('/api/wireless/sessions');
    if (!response.ok) {
      setSessionText('Failed to create session');
      if (footerHint) {
        footerHint.textContent = 'Could not create session. Please try again.';
        footerHint.classList.remove('ready');
      }
      return;
    }
    const session = (await response.json()) as SessionResponse;
    activeSessionId = session.sessionId;
    activeSessionToken = session.token;
    sessionWarningThresholdSeconds = session.warningThresholdSeconds ?? 60;

    sessionStorage.setItem('printbit.mode', 'print');
    sessionStorage.setItem('printbit.sessionId', session.sessionId);
    sessionStorage.setItem('printbit.sessionToken', session.token);
    sessionStorage.removeItem('printbit.uploadedFile');
    sessionStorage.removeItem('printbit.uploadedDocumentId');
    sessionStorage.removeItem('printbit.uploadedFiles');
    sessionStorage.removeItem('printbit.largePrintNoticeShown');

    setSessionText(session.sessionId);
    setSessionActive(true);
    updateSessionCountdown(session.remainingSeconds);
    updateUploadLink(session.uploadUrl);

    attachSocket(session.sessionId);
    void checkUploadStatus();
    pollHandle = window.setInterval(() => void checkUploadStatus(), 2000);
  } finally {
    createSessionInFlight = false;
    renderRefreshSessionButtonState();
  }
}

async function checkUploadStatus(): Promise<void> {
  if (!activeSessionId) return;

  const response = await fetch(getSessionDetailsUrl(activeSessionId));
  if (!response.ok) {
    if (
      response.status === 404 ||
      response.status === 410 ||
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403
    ) {
      activeSessionId = '';
      activeSessionToken = '';
      resetSessionCountdown();
      sessionStorage.removeItem('printbit.sessionId');
      sessionStorage.removeItem('printbit.sessionToken');
      setSessionActive(false);
      setSessionText('Session expired');
      setWaitingForFilesState();
      if (footerHint) {
        footerHint.textContent =
          'Session expired. Tap "New session" to generate a fresh QR code.';
        footerHint.classList.remove('ready');
      }
    }
    return;
  }

  const session = (await response.json()) as SessionResponse;
  activeSessionToken = session.token;
  sessionWarningThresholdSeconds = session.warningThresholdSeconds ?? 60;
  sessionStorage.setItem('printbit.sessionToken', session.token);
  updateSessionCountdown(session.remainingSeconds);

  // Never gate on status — session stays "uploaded" while accumulating
  // multiple files, so always read the full documents list.
  const rawFiles =
    session.documents && session.documents.length > 0
      ? session.documents
      : session.document
        ? [session.document]
        : [];

  const files: UploadedFile[] = rawFiles.map((file) => ({
    documentId: file.documentId || file.filename,
    filename: file.filename,
    size: file.size ?? file.sizeBytes,
    sizeBytes: file.sizeBytes,
    analysisStatus: file.analysisStatus,
    analysisError: file.analysisError,
  }));

  const nextSignature = filesSignature(files);
  if (nextSignature === lastRenderedFileSignature) {
    return;
  }
  renderFiles(files);
}

function getSessionDetailsUrl(sessionId: string): string {
  const params = new URLSearchParams();
  if (activeSessionToken) params.set('token', activeSessionToken);
  const query = params.toString();
  const endpoint = `/api/wireless/sessions/${encodeURIComponent(sessionId)}`;
  return query ? `${endpoint}?${query}` : endpoint;
}

function isPdfFilename(filename: string): boolean {
  return filename.trim().toLowerCase().endsWith('.pdf');
}

function setConversionMessage(message: string): void {
  if (conversionMessage) conversionMessage.textContent = message;
}

function showConversionDialog(): void {
  const activeElement = document.activeElement;
  conversionReturnFocus =
    activeElement instanceof HTMLElement ? activeElement : null;
  conversionWaitCancelled = false;
  setConversionMessage(`Converting your document to PDF. This can take a moment.`);
  conversionOverlay?.classList.add('is-visible');
  conversionOverlay?.setAttribute('aria-hidden', 'false');
  conversionCancelBtn?.focus();
}

function hideConversionDialog(): void {
  conversionOverlay?.classList.remove('is-visible');
  conversionOverlay?.setAttribute('aria-hidden', 'true');
  conversionReturnFocus?.focus();
  conversionReturnFocus = null;
}

function setContinueButtonDisabled(disabled: boolean): void {
  if (!continueBtn) return;
  continueBtn.disabled = disabled;
  continueBtn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
}

type ConversionWaitResult =
  | { ready: true }
  | { ready: false; message: string };

async function waitForDocumentAnalysis(
  sessionId: string,
  documentId: string,
): Promise<ConversionWaitResult> {
  while (!conversionWaitCancelled) {
    try {
      const response = await fetch(getSessionDetailsUrl(sessionId));
      if (!response.ok) {
        return {
          ready: false,
          message: 'Your session expired. Start a new session and upload again.',
        };
      }

      const session = (await response.json()) as SessionResponse;
      const documents =
        session.documents && session.documents.length > 0
          ? session.documents
          : session.document
            ? [session.document]
            : [];
      const document = documents.find(
        (candidate) => (candidate.documentId || candidate.filename) === documentId,
      );
      if (!document) {
        return { ready: false, message: 'The selected file is no longer available.' };
      }
      if (document.analysisStatus === 'completed') return { ready: true };
      if (document.analysisStatus === 'failed') {
        return {
          ready: false,
          message:
            document.analysisError ||
            'PDF conversion could not be completed. Choose another file or try again later.',
        };
      }
    } catch {
      // A transient network failure must not abandon a conversion still running
      // in the worker; the next poll will refresh the state.
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
  }

  return { ready: false, message: '' };
}

/** Socket: get instant notification when upload lands, no need to wait for poll. */
function attachSocket(sid: string): void {
  type SocketLike = {
    on: (e: string, cb: (...a: unknown[]) => void) => void;
    emit: (e: string, ...a: unknown[]) => void;
  };
  const ioFactory = (window as unknown as { io?: () => SocketLike }).io;
  if (typeof ioFactory !== 'function') return;
  if (attachedSessionId === sid) return;

  const socket = ioFactory();
  attachedSessionId = sid;
  socket.emit('joinSession', sid);
  socket.on('UploadCompleted', () => void checkUploadStatus());
  socket.on('UploadRemoved', () => void checkUploadStatus());

  // Analysis progress events
  socket.on('AnalysisStarted', (info: unknown) => {
    const docId =
      typeof info === 'object' &&
      info !== null &&
      'documentId' in info &&
      typeof (info as { documentId: unknown }).documentId === 'string'
        ? (info as { documentId: string }).documentId
        : null;
    if (docId) {
      updateFileAnalysisState(docId, 'analyzing');
    }
  });

  socket.on('AnalysisCompleted', (info: unknown) => {
    const docId =
      typeof info === 'object' &&
      info !== null &&
      'documentId' in info &&
      typeof (info as { documentId: unknown }).documentId === 'string'
        ? (info as { documentId: string }).documentId
        : null;
    if (docId) {
      updateFileAnalysisState(docId, 'ready');
    }
    // Refresh session data to get updated analysis
    void checkUploadStatus();
  });

  socket.on('AnalysisFailed', (info: unknown) => {
    const docId =
      typeof info === 'object' &&
      info !== null &&
      'documentId' in info &&
      typeof (info as { documentId: unknown }).documentId === 'string'
        ? (info as { documentId: string }).documentId
        : null;
    if (docId) {
      updateFileAnalysisState(docId, 'failed');
    }
    void checkUploadStatus();
  });
}

function updateFileAnalysisState(
  documentId: string,
  state: 'analyzing' | 'ready' | 'failed',
): void {
  const fileItem = document.querySelector(`[data-document-id="${documentId}"]`);
  if (!fileItem) return;

  const statusEl = fileItem.querySelector(
    '.file-analysis-status',
  ) as HTMLElement | null;
  if (!statusEl) return;

  statusEl.classList.remove('analyzing', 'ready', 'failed');
  statusEl.classList.add(state);

  switch (state) {
    case 'analyzing':
      statusEl.textContent = 'Analyzing…';
      statusEl.style.display = '';
      break;
    case 'ready':
      statusEl.textContent = '';
      statusEl.style.display = 'none';
      break;
    case 'failed':
      statusEl.textContent = '⚠ Analysis unavailable';
      statusEl.style.display = '';
      break;
  }
}

function showStartupOnboardingModal(): void {
  renderStartupOnboarding();
  if (!startupOnboardingOverlay) return;
  startupOnboardingOverlay.classList.add('is-visible');
  startupOnboardingOverlay.setAttribute('aria-hidden', 'false');
  startupContinueBtn?.focus();
}

function hideStartupOnboardingModal(): void {
  if (!startupOnboardingOverlay) return;
  startupOnboardingOverlay.classList.remove('is-visible');
  startupOnboardingOverlay.setAttribute('aria-hidden', 'true');
}

// ── Idle Timeout Detection (uses shared module) ──────────────────────────────

// ── New-session confirmation dialog ───────────────────────────────────────────

const dialogOverlay = document.getElementById(
  'newSessionOverlay',
) as HTMLElement | null;
const dialogConfirmBtn = document.getElementById(
  'newSessionConfirm',
) as HTMLButtonElement | null;
const dialogCancelBtn = document.getElementById(
  'newSessionCancel',
) as HTMLButtonElement | null;

let lastFocusedElement: HTMLElement | null = null;

function showNewSessionDialog(): void {
  const activeElement = document.activeElement;
  lastFocusedElement =
    activeElement instanceof HTMLElement ? activeElement : null;

  if (dialogOverlay) {
    dialogOverlay.classList.add('is-visible');
    dialogOverlay.setAttribute('aria-hidden', 'false');
  }

  if (dialogConfirmBtn) {
    dialogConfirmBtn.focus();
  } else if (dialogCancelBtn) {
    dialogCancelBtn.focus();
  }
}

function hideNewSessionDialog(): void {
  if (dialogOverlay) {
    dialogOverlay.classList.remove('is-visible');
    dialogOverlay.setAttribute('aria-hidden', 'true');
  }

  if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
    lastFocusedElement.focus();
  }
  lastFocusedElement = null;
}

dialogCancelBtn?.addEventListener('click', hideNewSessionDialog);
dialogOverlay?.addEventListener('click', (e) => {
  if (e.target === dialogOverlay) hideNewSessionDialog();
});
dialogConfirmBtn?.addEventListener('click', () => {
  hideNewSessionDialog();
  requestNewSession();
});

// ── Session restore ───────────────────────────────────────────────────────────

async function restoreSession(sid: string): Promise<void> {
  resetSessionCountdown();
  activeSessionId = sid;
  activeSessionToken = sessionStorage.getItem('printbit.sessionToken') ?? '';

  setSessionText(sid);
  setSessionActive(true);

  sessionStorage.setItem('printbit.mode', 'print');
  sessionStorage.setItem('printbit.sessionId', sid);

  attachSocket(sid);

  const response = await fetch(getSessionDetailsUrl(sid));
  if (response.ok) {
    const session = (await response.json()) as SessionResponse;
    activeSessionToken = session.token;
    sessionWarningThresholdSeconds = session.warningThresholdSeconds ?? 60;
    sessionStorage.setItem('printbit.sessionToken', session.token);
    updateSessionCountdown(session.remainingSeconds);
    updateUploadLink(session.uploadUrl);
    await checkUploadStatus();
  } else {
    await requestNewSession();
    return;
  }

  if (pollHandle !== null) window.clearInterval(pollHandle);
  pollHandle = window.setInterval(() => void checkUploadStatus(), 2000);
}

// ── Events ────────────────────────────────────────────────────────────────────

refreshSessionBtn?.addEventListener('click', () => {
  if (getNewSessionCooldownRemainingMs() > 0) {
    showNewSessionCooldownHint();
    renderRefreshSessionButtonState();
    return;
  }
  if (knownFiles.size > 0) {
    showNewSessionDialog();
  } else {
    requestNewSession();
  }
});

startupContinueBtn?.addEventListener('click', () => {
  hideStartupOnboardingModal();
});

showWifiModalBtn?.addEventListener('click', () => {
  showStartupOnboardingModal();
});

startupOnboardingOverlay?.addEventListener('click', (e) => {
  if (e.target === startupOnboardingOverlay) hideStartupOnboardingModal();
});

document.addEventListener('keydown', (e) => {
  if (
    e.key === 'Escape' &&
    startupOnboardingOverlay?.classList.contains('is-visible')
  ) {
    hideStartupOnboardingModal();
  }
});

conversionCancelBtn?.addEventListener('click', () => {
  conversionWaitCancelled = true;
  conversionWaitInFlight = false;
  setContinueButtonDisabled(false);
  hideConversionDialog();
});

continueBtn?.addEventListener('click', async () => {
  if (
    !activeSessionId ||
    !selectedFilename ||
    !selectedDocumentId ||
    conversionWaitInFlight
  ) {
    return;
  }
  if (!isPdfFilename(selectedFilename)) {
    conversionWaitInFlight = true;
    setContinueButtonDisabled(true);
    showConversionDialog();
    const result = await waitForDocumentAnalysis(
      activeSessionId,
      selectedDocumentId,
    );
    if (!result.ready) {
      if (!conversionWaitCancelled) {
        setConversionMessage(result.message);
        conversionCancelBtn?.focus();
      }
      conversionWaitInFlight = false;
      setContinueButtonDisabled(false);
      return;
    }
    setConversionMessage('PDF ready. Opening print settings…');
  }
  const destination =
    `/config?mode=print&sessionId=${encodeURIComponent(activeSessionId)}` +
    `&file=${encodeURIComponent(selectedFilename)}` +
    `&documentId=${encodeURIComponent(selectedDocumentId)}` +
    `&token=${encodeURIComponent(activeSessionToken)}`;
  navigateWithKioskMotion(destination);
});

hydrateNewSessionCooldownState();

const savedSessionId = sessionStorage.getItem('printbit.sessionId');
if (savedSessionId) {
  void restoreSession(savedSessionId);
} else {
  void createSession();
}

// Initialize idle timeout with custom session cleanup handler
void setupPageIdleWarningButton();
void initializePageIdleTimeout({
  showWarningModal: true,
  onTimeout: async () => {
    // Attempt to cancel session on server
    if (activeSessionId && activeSessionToken) {
      try {
        const res = await fetch(
          `/api/wireless/sessions/${encodeURIComponent(activeSessionId)}/cancel?token=${encodeURIComponent(activeSessionToken)}`,
          {
            method: 'DELETE',
          },
        );
        console.log('[IDLE] Session cancelled:', res.status);
      } catch (err) {
        console.error('[IDLE] Failed to cancel session:', err);
      }
    }
    // Redirect to home
    sessionStorage.removeItem('printbit.sessionToken');
    navigateWithKioskMotion('/', 'replace');
  },
});

export { navigateTo };
function navigateTo(path: string) {
  navigateWithKioskMotion(path);
}
