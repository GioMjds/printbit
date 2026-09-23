export {};
import { initKioskLocalization } from '../shared/kiosk-i18n';
import {
  formatLargePrintDisclaimer,
  isLargePrintDocument,
} from '../shared/large-print-warning';

void initKioskLocalization();

declare global {
  interface Window {
    uploadToken?: string;
    documentConversionEnabled?: boolean;
    io?: (
      namespace: string,
      options: {
        auth: { sessionId: string; token: string; clientId: string };
      },
    ) => SocketClient;
  }
}

interface SocketClient {
  on: (event: string, callback: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

type UploadState =
  | 'session-loading'
  | 'session-ready'
  | 'session-error'
  | 'uploading'
  | 'all-done';
type ItemStatus = 'pending' | 'uploading' | 'done' | 'error';

interface SessionResponse {
  sessionId: string;
  uploadUrl: string;
  status: 'pending' | 'uploaded';
  remainingSeconds?: number;
  warningThresholdSeconds?: number;
  ttlSeconds?: number;
  documentConversionEnabled?: boolean;
}

interface UploadErrorResponse {
  code?: string;
  error?: string;
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const dropZone = document.getElementById('dropZone') as HTMLDivElement;
const fileQueue = document.getElementById('fileQueue') as HTMLDivElement;
const uploadButton = document.getElementById(
  'uploadButton',
) as HTMLButtonElement;
const uploadBtnLabel = document.getElementById(
  'uploadBtnLabel',
) as HTMLSpanElement;
const statusBox = document.getElementById('statusBox') as HTMLDivElement;
const sessionMetaUpload = document.getElementById(
  'sessionMetaUpload',
) as HTMLSpanElement;
const sessionDotUpload = document.getElementById(
  'sessionDotUpload',
) as HTMLSpanElement;
const retrySessionButton = document.getElementById(
  'retrySessionButton',
) as HTMLButtonElement;
const uploadForm = document.getElementById('uploadForm') as HTMLFormElement;
const uploadSubTitle = document.getElementById(
  'uploadSubTitle',
) as HTMLParagraphElement | null;
const dropZoneHint = document.getElementById(
  'dropZoneHint',
) as HTMLParagraphElement | null;

// ── State ─────────────────────────────────────────────────────────────────────

const tokenFromPath = window.location.pathname.split('/')[2];
const token = window.uploadToken || tokenFromPath;
const CLIENT_ID_STORAGE_KEY = 'printbit.uploadClientId';
const SESSION_MONITOR_INTERVAL_MS = 5000;
const SESSION_COUNTDOWN_TICK_MS = 1000;
const DEFAULT_WARNING_SECONDS = 60;

let maxPagesPerSession = 30;

async function resolveMaxPagesPerSession(): Promise<number> {
  try {
    const res = await fetch('/api/settings/idle-timeout');
    if (res.ok) {
      const data = await res.json();
      if (
        typeof data.maxPagesPerSession === 'number' &&
        Number.isFinite(data.maxPagesPerSession)
      ) {
        maxPagesPerSession = data.maxPagesPerSession;
        return maxPagesPerSession;
      }
    }
  } catch {
    // fallback to default
  }
  return maxPagesPerSession;
}
void resolveMaxPagesPerSession();

let sessionId: string | null = null;
let appState: UploadState = 'session-loading';
let sessionWarningThresholdSeconds = DEFAULT_WARNING_SECONDS;
let monitorHandle: number | null = null;
let countdownBaselineSeconds: number | null = null;
let countdownSyncedAtMs: number | null = null;
let countdownHandle: number | null = null;
let isSessionUnavailable = false;
let largePrintWarningShown = false;
let documentConversionEnabled =
  typeof window.documentConversionEnabled === 'boolean'
    ? window.documentConversionEnabled
    : true;

function getOrCreateUploadClientId(): string {
  const generated =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const existing = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (existing && existing.trim().length > 0) return existing;
    window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, generated);
  } catch {
    return generated;
  }
  return generated;
}

const uploadClientId = getOrCreateUploadClientId();

/** Files staged for upload — keyed by a local id */
type QueuedFile = {
  id: string;
  file: File;
  contentHash?: string;
  status: ItemStatus;
  el: HTMLElement;
}

const queue: QueuedFile[] = [];
let nextId = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function setAppState(s: UploadState): void {
  appState = s;
  const canUpload =
    s === 'session-ready' && queue.some((q) => q.status === 'pending');
  uploadButton.disabled = !canUpload;
}

function setStatus(msg: string, cls: 'info' | 'ok' | 'error' | ''): void {
  statusBox.textContent = msg;
  statusBox.className = cls ? `status-box ${cls}` : 'status-box';
}

function clearStatus(): void {
  setStatus('', '');
}

function setSessionUI(text: string, dot: 'idle' | 'active' | 'error'): void {
  sessionMetaUpload.textContent = text;
  sessionDotUpload.classList.remove('active', 'error');
  if (dot !== 'idle') sessionDotUpload.classList.add(dot);
}

function setRetryButtonVisible(visible: boolean): void {
  retrySessionButton.hidden = !visible;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? 'file';
}

function isWordDocument(fileName: string, mimeType?: string): boolean {
  const ext = extOf(fileName);
  if (ext === 'doc' || ext === 'docx') return true;
  const normalized = mimeType?.trim().toLowerCase();
  return (
    normalized === 'application/msword' ||
    normalized ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

function setDocumentConversionEnabled(enabled: boolean): void {
  documentConversionEnabled = enabled;

  if (fileInput) {
    fileInput.accept = enabled
      ? '.pdf,.doc,.docx,.jpeg,.jpg,.png'
      : '.pdf,.jpeg,.jpg,.png';
  }

  if (uploadSubTitle) {
    uploadSubTitle.textContent = enabled
      ? 'PDF, DOCX, JPG, and PNG files only · up to 25 MB each'
      : 'PDF, JPG, and PNG files only · up to 25 MB each';
  }

  if (dropZoneHint) {
    dropZoneHint.textContent = enabled
      ? 'PDF recommended for fastest processing · Word documents & images supported'
      : 'PDF recommended for fastest processing · Images supported (Word documents disabled)';
  }

  if (!enabled && queue.length > 0) {
    let removedCount = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
      const qf = queue[i];
      if (qf.status === 'pending' && isWordDocument(qf.file.name, qf.file.type)) {
        queue.splice(i, 1);
        qf.el.remove();
        removedCount++;
      }
    }
    if (removedCount > 0) {
      refreshUploadBtn();
      setStatus(
        'Word document conversion is disabled on this kiosk. Removed Word document(s) from upload list.',
        'info',
      );
    }
  }
}

function normalizeMimeByExtension(
  fileName: string,
  mimeType: string,
): string | null {
  const normalizedMime = mimeType.trim().toLowerCase();
  const ext = extOf(fileName);
  const extensionMimeMap: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
  };

  if (normalizedMime !== '' && normalizedMime !== 'application/octet-stream') {
    return normalizedMime;
  }

  return extensionMimeMap[ext] ?? null;
}

interface UnsupportedFilesResult {
  unsupported: string[];
  rejectedWordCount: number;
}

function collectUnsupportedFiles(files: File[]): UnsupportedFilesResult {
  const allowedMimeTypes = new Set<string>([
    'application/pdf',
    'image/jpeg',
    'image/png',
  ]);
  if (documentConversionEnabled) {
    allowedMimeTypes.add('application/msword');
    allowedMimeTypes.add(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  }

  const unsupported: string[] = [];
  let rejectedWordCount = 0;

  for (const file of files) {
    const isWord = isWordDocument(file.name, file.type);
    if (!documentConversionEnabled && isWord) {
      rejectedWordCount++;
      unsupported.push(file.name);
      continue;
    }
    const normalized = normalizeMimeByExtension(file.name, file.type);
    if (!normalized || !allowedMimeTypes.has(normalized)) {
      unsupported.push(file.name);
    }
  }

  return { unsupported, rejectedWordCount };
}

async function sha256File(file: File): Promise<string | undefined> {
  if (!crypto.subtle) return undefined;
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function mapError(r: UploadErrorResponse): string {
  switch (r.code) {
    case 'DUPLICATE_FILE':
      return 'This file was already sent in this session.';
    case 'INVALID_TOKEN':
      return 'Invalid token. Scan a fresh kiosk QR or reopen the upload link from the kiosk.';
    case 'UNSUPPORTED_TYPE':
      return r.error ?? 'Unsupported file type.';
    case 'UNSUPPORTED_FILE_TYPE':
      return r.error ?? 'Unsupported file type.';
    case 'FILE_TOO_LARGE':
      return r.error ?? 'File exceeds the 25 MB limit.';
    case 'SESSION_NOT_FOUND':
      return 'Session not found. Scan a fresh kiosk QR or reopen the upload link from the kiosk.';
    case 'SESSION_EXPIRED':
      return 'Session expired. Stay on PrintBit Wi-Fi, then scan a fresh kiosk QR or reopen the latest upload link.';
    case 'SESSION_OWNED':
      return 'This session is already active on another phone. Stay on PrintBit Wi-Fi and start a new kiosk session.';
    case 'MISSING_CLIENT_ID':
      return 'Upload client identity missing. Reload this page.';
    case 'INVALID_CLIENT_ID':
      return 'Upload client identity is invalid. Reload this page and try again.';
    case 'SESSION_PERSIST_FAILED':
      return 'Kiosk could not save session changes. Please start a new kiosk session and retry.';
    default:
      return r.error ?? 'Upload failed.';
  }
}

function formatCountdown(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function stopSessionMonitor(): void {
  if (monitorHandle !== null) {
    window.clearInterval(monitorHandle);
    monitorHandle = null;
  }
}

function stopSessionCountdownTicker(): void {
  if (countdownHandle !== null) {
    window.clearInterval(countdownHandle);
    countdownHandle = null;
  }
}

function resetSessionCountdown(): void {
  stopSessionCountdownTicker();
  countdownBaselineSeconds = null;
  countdownSyncedAtMs = null;
}

function getCurrentRemainingSeconds(): number | null {
  if (countdownBaselineSeconds === null || countdownSyncedAtMs === null) {
    return null;
  }
  const elapsedSeconds = Math.floor((Date.now() - countdownSyncedAtMs) / 1000);
  return Math.max(countdownBaselineSeconds - elapsedSeconds, 0);
}

function renderSessionCountdown(remainingSeconds: number): void {
  if (!sessionId) return;
  const countdown = formatCountdown(remainingSeconds);
  setSessionUI(`${sessionId}`, 'active');

  if (
    remainingSeconds <= sessionWarningThresholdSeconds &&
    appState !== 'all-done'
  ) {
    setStatus(`Session expires in ${countdown}. Finish upload soon.`, 'info');
    return;
  }

  const current = statusBox.textContent ?? '';
  if (current.startsWith('Session expires in ')) {
    clearStatus();
  }
}

function startSessionCountdownTicker(): void {
  if (countdownHandle !== null) return;
  countdownHandle = window.setInterval(() => {
    if (!sessionId || isSessionUnavailable) {
      resetSessionCountdown();
      return;
    }
    const remainingSeconds = getCurrentRemainingSeconds();
    if (remainingSeconds === null) return;
    renderSessionCountdown(remainingSeconds);
    if (remainingSeconds === 0) {
      stopSessionCountdownTicker();
    }
  }, SESSION_COUNTDOWN_TICK_MS);
}

function applySessionCountdown(remainingSeconds: number): void {
  countdownBaselineSeconds = Math.max(0, Math.floor(remainingSeconds));
  countdownSyncedAtMs = Date.now();
  renderSessionCountdown(countdownBaselineSeconds);
  startSessionCountdownTicker();
}

function setSessionUnavailable(message: string): void {
  isSessionUnavailable = true;
  setAppState('session-error');
  setSessionUI('Session unavailable', 'error');
  setRetryButtonVisible(true);
  setStatus(message, 'error');
  stopSessionMonitor();
  resetSessionCountdown();
}

async function refreshSessionLease(): Promise<void> {
  if (!token || isSessionUnavailable) return;

  try {
    const res = await fetch(
      `/api/wireless/sessions/by-token/${encodeURIComponent(token)}`,
      { headers: { 'x-upload-client-id': uploadClientId } },
    );
    if (!res.ok) {
      let payload: UploadErrorResponse = {};
      try {
        payload = (await res.json()) as UploadErrorResponse;
      } catch {
        payload = {};
      }

      if (
        res.status === 404 ||
        res.status === 410 ||
        payload.code === 'SESSION_EXPIRED'
      ) {
        setSessionUnavailable(
          'This session has expired. Stay on PrintBit Wi-Fi, then scan a fresh kiosk QR or reopen the latest upload link.',
        );
        return;
      }
      if (res.status === 409 || payload.code === 'SESSION_OWNED') {
        setSessionUnavailable(
          'This session is active on another phone. Stay on PrintBit Wi-Fi and start a new kiosk session.',
        );
        return;
      }
      if (
        res.status === 400 &&
        (payload.code === 'MISSING_CLIENT_ID' ||
          payload.code === 'INVALID_CLIENT_ID')
      ) {
        setSessionUnavailable(mapError(payload));
        return;
      }
      if (res.status === 500 && payload.code === 'SESSION_PERSIST_FAILED') {
        setSessionUnavailable(mapError(payload));
      }
      return;
    }

    if (isSessionUnavailable) return;
    const session = (await res.json()) as SessionResponse;
    if (isSessionUnavailable) return;
    sessionId = session.sessionId;
    sessionWarningThresholdSeconds =
      session.warningThresholdSeconds ?? DEFAULT_WARNING_SECONDS;
    if (typeof session.remainingSeconds === 'number') {
      applySessionCountdown(session.remainingSeconds);
    }
    if (typeof session.documentConversionEnabled === 'boolean') {
      setDocumentConversionEnabled(session.documentConversionEnabled);
    }
  } catch {
    // Keep current UI state on transient network errors.
  }
}

function startSessionMonitor(): void {
  stopSessionMonitor();
  monitorHandle = window.setInterval(
    () => void refreshSessionLease(),
    SESSION_MONITOR_INTERVAL_MS,
  );
}

function handleVisibilityResume(): void {
  if (document.visibilityState === 'visible') {
    void refreshSessionLease();
  }
}

// ── Queue item UI ─────────────────────────────────────────────────────────────

function createQueueItem(qf: QueuedFile): HTMLElement {
  const ext = extOf(qf.file.name);
  const size = formatBytes(qf.file.size);

  const li = document.createElement('div');
  li.className = 'queue-item';
  li.dataset.qid = qf.id;
  li.innerHTML = `
    <div class="queue-item__icon" data-ext="${ext}">${ext.toUpperCase()}</div>
    <div class="queue-item__info">
      <p class="queue-item__name" title="${escHtml(qf.file.name)}">${escHtml(qf.file.name)}</p>
      <span class="queue-item__size">${size}</span>
    </div>
    <div class="queue-item__actions">
      <span class="queue-item__status queue-item__status--pending">Pending</span>
      <button type="button" class="queue-item__remove" aria-label="Remove ${escHtml(qf.file.name)}">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd"
          d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414
          10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586
          10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
      </button>
    </div>
    <div class="queue-item__progress" style="width:0%"></div>
  `;

  li.querySelector('.queue-item__remove')?.addEventListener('click', () =>
    removeFromQueue(qf.id),
  );
  return li;
}

function updateItemStatus(
  qf: QueuedFile,
  status: ItemStatus,
  labelOverride?: string,
): void {
  qf.status = status;
  const li = qf.el;
  li.classList.remove('uploading', 'done', 'error');
  if (status !== 'pending') li.classList.add(status);

  const badge = li.querySelector('.queue-item__status') as HTMLElement;
  badge.className = `queue-item__status queue-item__status--${status}`;
  badge.textContent =
    labelOverride ??
    {
      pending: 'Pending',
      uploading: 'Uploading…',
      done: '✓ Sent',
      error: 'Failed',
    }[status];
}

function setItemProgress(qf: QueuedFile, pct: number): void {
  const bar = qf.el.querySelector('.queue-item__progress') as HTMLElement;
  if (bar) bar.style.width = `${pct}%`;
}

function removeFromQueue(id: string): void {
  const idx = queue.findIndex((q) => q.id === id);
  if (idx === -1) return;
  const [qf] = queue.splice(idx, 1);
  qf.el.remove();
  refreshUploadBtn();
  if (queue.length === 0) clearStatus();
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Add files to queue ────────────────────────────────────────────────────────

async function addFilesToQueue(files: FileList | File[]): Promise<void> {
  const arr = Array.from(files);
  const { unsupported, rejectedWordCount } = collectUnsupportedFiles(arr);
  if (unsupported.length > 0) {
    if (rejectedWordCount > 0) {
      setStatus(
        'Word document conversion is disabled on this kiosk. Please upload PDF or image files.',
        'error',
      );
    } else {
      setStatus(
        `Unsupported file type: ${unsupported[0]}${unsupported.length > 1 ? ` (+${unsupported.length - 1} more)` : ''}.`,
        'error',
      );
    }
  }

  const duplicateFiles: string[] = [];
  for (const file of arr) {
    if (!documentConversionEnabled && isWordDocument(file.name, file.type)) {
      continue;
    }

    const normalizedMime = normalizeMimeByExtension(file.name, file.type);
    if (!normalizedMime) continue;

    let contentHash: string | undefined;
    try {
      contentHash = await sha256File(file);
    } catch {
      // The server still performs the authoritative duplicate validation.
    }

    if (contentHash && queue.some((q) => q.contentHash === contentHash)) {
      duplicateFiles.push(file.name);
      continue;
    }

    const qf = {
      id: String(nextId++),
      file,
      contentHash,
      status: 'pending',
      el: null as unknown as HTMLElement,
    } satisfies QueuedFile;
    const el = createQueueItem(qf);
    qf.el = el;
    queue.push(qf);
    fileQueue.appendChild(el);
  }
  refreshUploadBtn();
  if (duplicateFiles.length > 0) {
    setStatus(
      `${duplicateFiles[0]} is already in the upload list${duplicateFiles.length > 1 ? ` (+${duplicateFiles.length - 1} more)` : ''}.`,
      'info',
    );
  } else if (unsupported.length === 0) {
    clearStatus();
  }
}

function refreshUploadBtn(): void {
  const pendingCount = queue.filter((q) => q.status === 'pending').length;
  if (appState !== 'session-ready' && appState !== 'all-done') return;
  uploadButton.disabled = pendingCount === 0;
  uploadBtnLabel.textContent =
    pendingCount > 1 ? `Send ${pendingCount} files to Kiosk` : 'Send to Kiosk';
}

function clearQueueForRetry(): void {
  queue.splice(0, queue.length);
  nextId = 0;
  fileQueue.innerHTML = '';
  fileInput.value = '';
  uploadButton.disabled = true;
  uploadBtnLabel.textContent = 'Send to Kiosk';
  clearStatus();
}

// ── Session init ──────────────────────────────────────────────────────────────

async function initSession(): Promise<void> {
  isSessionUnavailable = false;
  resetSessionCountdown();
  setAppState('session-loading');
  setRetryButtonVisible(false);
  setSessionUI('Connecting to session…', 'idle');
  setStatus(
    'Connecting to kiosk session over local network or internet…',
    'info',
  );

  if (!token) {
    setSessionUnavailable(
      'No upload token found. Please scan a fresh kiosk QR.',
    );
    return;
  }

  try {
    const res = await fetch(
      `/api/wireless/sessions/by-token/${encodeURIComponent(token)}`,
      { headers: { 'x-upload-client-id': uploadClientId } },
    );
    if (!res.ok) {
      let payload: UploadErrorResponse = {};
      try {
        payload = (await res.json()) as UploadErrorResponse;
      } catch {
        payload = {};
      }
      throw new Error(mapError(payload));
    }

    const session = (await res.json()) as SessionResponse;
    sessionId = session.sessionId;
    sessionWarningThresholdSeconds =
      session.warningThresholdSeconds ?? DEFAULT_WARNING_SECONDS;

    if (typeof session.documentConversionEnabled === 'boolean') {
      setDocumentConversionEnabled(session.documentConversionEnabled);
    }

    attachSocket(sessionId);
    setAppState('session-ready');
    if (typeof session.remainingSeconds === 'number') {
      applySessionCountdown(session.remainingSeconds);
    } else {
      resetSessionCountdown();
      setSessionUI(`Session ${sessionId.slice(0, 8)}…`, 'active');
    }
    clearStatus();
    refreshUploadBtn();
    startSessionMonitor();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Could not connect to this session.';
    setSessionUnavailable(message);
  }
}

// ── Socket ────────────────────────────────────────────────────────────────────

function attachSocket(sid: string): void {
  if (typeof window.io !== 'function') return;
  const socket = window.io('/session', {
    auth: {
      sessionId: sid,
      token,
      clientId: uploadClientId,
    },
  });

  socket.on('UploadCompleted', (info: unknown) => {
    const name =
      typeof info === 'object' &&
      info !== null &&
      'filename' in info &&
      typeof (info as { filename: unknown }).filename === 'string'
        ? (info as { filename: string }).filename
        : 'file';
    setStatus(`✓ ${name} received by kiosk.`, 'ok');
  });

  socket.on('UploadFailed', () => {
    setStatus('Kiosk reported an upload error. Please retry.', 'error');
  });

  socket.on('AnalysisStarted', (info: unknown) => {
    const name =
      typeof info === 'object' &&
      info !== null &&
      'filename' in info &&
      typeof (info as { filename: unknown }).filename === 'string'
        ? (info as { filename: string }).filename
        : 'file';
    setStatus(`Analyzing ${name}…`, 'info');
  });

  socket.on('AnalysisCompleted', (info: unknown) => {
    const analysis =
      typeof info === 'object' && info !== null && 'analysis' in info
        ? (info as { analysis?: { pageCount?: unknown; totalPages?: unknown } })
            .analysis
        : undefined;
    const pageCount = analysis?.totalPages ?? analysis?.pageCount;
    if (
      !largePrintWarningShown &&
      isLargePrintDocument(pageCount, maxPagesPerSession)
    ) {
      largePrintWarningShown = true;
      setStatus(
        formatLargePrintDisclaimer(pageCount, maxPagesPerSession),
        'info',
      );
      return;
    }
    setStatus(`✓ Your document file is ready for printing at kiosk.`, 'ok');
  });

  socket.on('AnalysisFailed', (info: unknown) => {
    const name =
      typeof info === 'object' &&
      info !== null &&
      'filename' in info &&
      typeof (info as { filename: unknown }).filename === 'string'
        ? (info as { filename: string }).filename
        : 'file';
    // Analysis failure is non-fatal — file can still be printed, just without page count info
    setStatus(`⚠ ${name} analysis unavailable. Proceed at kiosk.`, 'info');
  });
}

// ── Upload all pending files sequentially ─────────────────────────────────────

async function uploadPendingFiles(): Promise<void> {
  if (!sessionId || isSessionUnavailable) return;
  const pending = queue.filter((q) => q.status === 'pending');
  if (pending.length === 0) return;

  setAppState('uploading');
  uploadButton.disabled = true;
  clearStatus();

  let doneCount = 0;
  let errorCount = 0;

  for (const qf of pending) {
    if (isSessionUnavailable) break;
    if (!documentConversionEnabled && isWordDocument(qf.file.name, qf.file.type)) {
      updateItemStatus(
        qf,
        'error',
        'Word document conversion is disabled.',
      );
      errorCount++;
      continue;
    }
    updateItemStatus(qf, 'uploading');
    setItemProgress(qf, 20);

    const formData = new FormData();
    formData.append('file', qf.file);

    try {
      // Use XHR for upload progress
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(
          'POST',
          `/api/wireless/sessions/${sessionId}/upload?token=${encodeURIComponent(token)}`,
        );
        xhr.setRequestHeader('x-upload-client-id', uploadClientId);

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            setItemProgress(qf, Math.round((e.loaded / e.total) * 90));
          }
        });

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setItemProgress(qf, 100);
            updateItemStatus(qf, 'done');
            doneCount++;
            resolve();
          } else {
            try {
              const errBody = JSON.parse(
                xhr.responseText,
              ) as UploadErrorResponse;
              updateItemStatus(qf, 'error', mapError(errBody));
              if (
                errBody.code === 'SESSION_EXPIRED' ||
                errBody.code === 'SESSION_OWNED'
              ) {
                setSessionUnavailable(mapError(errBody));
              }
            } catch {
              updateItemStatus(qf, 'error', 'Upload failed');
            }
            errorCount++;
            resolve(); // continue with next file
          }
        });

        xhr.addEventListener('error', () => {
          updateItemStatus(qf, 'error', 'Network error');
          errorCount++;
          reject();
        });

        xhr.send(formData);
      }).catch(() => {
        /* already handled */
      });
    } catch {
      updateItemStatus(qf, 'error', 'Network error');
      errorCount++;
    }
  }

  if (isSessionUnavailable) return;

  // Final summary
  if (errorCount === 0 && doneCount > 0) {
    setStatus(
      `✓ ${doneCount} file${doneCount > 1 ? 's' : ''} sent successfully. You can continue at the kiosk.`,
      'ok',
    );
    setAppState('all-done');
  } else if (doneCount > 0 && errorCount > 0) {
    setStatus(
      `${doneCount} file${doneCount > 1 ? 's' : ''} sent, ${errorCount} failed. You can retry failed items.`,
      'info',
    );
    setAppState('session-ready');
    refreshUploadBtn();
  } else {
    setStatus(
      'All uploads failed. Please check your network/internet connection and try again.',
      'error',
    );
    setAppState('session-ready');
    refreshUploadBtn();
  }
}

// ── Events ────────────────────────────────────────────────────────────────────

// The hidden <input> covers the full drop zone via `position:absolute; inset:0`,
// so every pointer click already natively activates it. Adding a JS click handler
// that calls fileInput.click() on top of that opens TWO file dialogs — the second
// one cancels the first, which is why the first selection was never received.
// No click handler needed here at all.

dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) {
    void addFilesToQueue(fileInput.files);
    fileInput.value = ''; // reset so same files can be re-added after removal
  }
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', (e: DragEvent) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer?.files.length) void addFilesToQueue(e.dataTransfer.files);
});

retrySessionButton.addEventListener('click', () => {
  clearQueueForRetry();
  void initSession();
});

uploadForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (appState !== 'session-ready') return;
  void uploadPendingFiles();
});

document.addEventListener('visibilitychange', handleVisibilityResume);
window.addEventListener('focus', () => {
  void refreshSessionLease();
});
window.addEventListener('pageshow', () => {
  void refreshSessionLease();
});

setDocumentConversionEnabled(documentConversionEnabled);
void initSession();
