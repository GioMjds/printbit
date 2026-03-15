import QRCode from 'qrcode';
import {
  initializePageIdleTimeout,
  setupPageIdleWarningButton,
} from '../../services/idle-timeout';

type UploadedFile = {
  documentId?: string;
  filename: string;
  size?: number;
  sizeBytes?: number;
};

type SessionResponse = {
  sessionId: string;
  token: string;
  status: 'pending' | 'uploaded';
  uploadUrl: string;
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
  ssid: string;
  password: string;
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
const filesEmpty = document.getElementById('filesEmpty') as HTMLElement | null;
const fileList = document.getElementById('fileList') as HTMLUListElement | null;
const filesCount = document.getElementById('filesCount') as HTMLElement | null;
const footerHint = document.getElementById('footerHint') as HTMLElement | null;
const wifiSsidEl = document.getElementById('wifiSsid') as HTMLElement | null;
const wifiPasswordEl = document.getElementById(
  'wifiPassword',
) as HTMLElement | null;
const wifiStepEl = document.getElementById('wifiStep') as HTMLElement | null;

// ── State ─────────────────────────────────────────────────────────────────────

let activeSessionId = '';
let pollHandle: number | null = null;
let selectedFilename = '';
let selectedDocumentId = '';
let knownFiles = new Set<string>();
let deletingDocumentIds = new Set<string>();
let lastRenderedFileSignature = '';
let attachedSessionId: string | null = null;
let hotspotConfig: HotspotConfig | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function setSessionText(text: string): void {
  if (sessionText) sessionText.textContent = text;
}

function setSessionActive(active: boolean): void {
  sessionDot?.classList.toggle('active', active);
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
  setFilesCount(0);
  filesEmpty?.classList.remove('hidden');
  fileList?.classList.add('hidden');
  if (continueBtn) {
    continueBtn.disabled = true;
    continueBtn.setAttribute('aria-disabled', 'true');
  }
  if (footerHint) {
    footerHint.textContent = 'Select a file above to continue.';
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
    footerHint.textContent = `"${file.filename}" selected.`;
    footerHint.classList.add('ready');
  }
}

async function deleteSessionFile(file: UploadedFile): Promise<void> {
  if (!activeSessionId) return;
  const documentId = file.documentId || file.filename;
  if (!documentId || deletingDocumentIds.has(documentId)) return;
  deletingDocumentIds.add(documentId);

  try {
    const response = await fetch(
      `/api/wireless/sessions/${encodeURIComponent(activeSessionId)}/documents/${encodeURIComponent(documentId)}`,
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

  const deleteBtn = li.querySelector('.file-item__delete') as
    | HTMLButtonElement
    | null;
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
    files.find((f) => (f.documentId || f.filename) === prevSelected) ?? files[0];
  selectFile(selected);
}

// ── Session management ────────────────────────────────────────────────────────

function updateUploadLink(uploadUrl: string): void {
  let href: string;
  try {
    href = new URL(uploadUrl).pathname;
  } catch {
    href = uploadUrl;
  }

  if (uploadLink) {
    uploadLink.href = href;
    uploadLink.textContent = uploadUrl;
  }

  if (openUploadBtn) {
    openUploadBtn.onclick = () => window.open(href, '_blank');
  }

  if (hotspotConfig) {
    if (wifiSsidEl) wifiSsidEl.textContent = hotspotConfig.ssid;
    if (wifiPasswordEl) wifiPasswordEl.textContent = hotspotConfig.password;
    if (wifiStepEl) wifiStepEl.style.display = '';
  } else {
    if (wifiStepEl) wifiStepEl.style.display = 'none';
  }

  if (uploadQrCanvas) {
    void QRCode.toCanvas(uploadQrCanvas, uploadUrl, {
      width: 220,
      margin: 1,
      color: { dark: '#1a1a2e', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
  }
}

async function createSession(): Promise<void> {
  if (pollHandle !== null) {
    window.clearInterval(pollHandle);
    pollHandle = null;
  }

  // Fetch hotspot config (for Wi-Fi QR code)
  if (!hotspotConfig) {
    try {
      const cfgRes = await fetch('/api/config/hotspot');
      if (cfgRes.ok) hotspotConfig = (await cfgRes.json()) as HotspotConfig;
    } catch {
      /* non-critical — falls back to URL QR */
    }
  }

  // Start the hotspot on-demand so the Wi-Fi network is ready for scanning
  if (hotspotConfig) {
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
  const session = (await response.json()) as SessionResponse;
  activeSessionId = session.sessionId;

  sessionStorage.setItem('printbit.mode', 'print');
  sessionStorage.setItem('printbit.sessionId', session.sessionId);
  sessionStorage.removeItem('printbit.uploadedFile');
  sessionStorage.removeItem('printbit.uploadedDocumentId');
  sessionStorage.removeItem('printbit.uploadedFiles');

  setSessionText(session.sessionId);
  setSessionActive(true);
  updateUploadLink(session.uploadUrl);

  attachSocket(session.sessionId);
  void checkUploadStatus();
  pollHandle = window.setInterval(() => void checkUploadStatus(), 2000);
}

async function checkUploadStatus(): Promise<void> {
  if (!activeSessionId) return;

  const response = await fetch(
    `/api/wireless/sessions/${encodeURIComponent(activeSessionId)}`,
  );
  if (!response.ok) return;

  const session = (await response.json()) as SessionResponse;

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
  }));

  const nextSignature = filesSignature(files);
  if (nextSignature === lastRenderedFileSignature) {
    return;
  }
  renderFiles(files);
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
  void createSession();
});

// ── Session restore ───────────────────────────────────────────────────────────

async function restoreSession(sid: string): Promise<void> {
  activeSessionId = sid;

  if (!hotspotConfig) {
    try {
      const cfgRes = await fetch('/api/config/hotspot');
      if (cfgRes.ok) hotspotConfig = (await cfgRes.json()) as HotspotConfig;
    } catch {
      /* non-critical */
    }
  }

  setSessionText(sid);
  setSessionActive(true);

  sessionStorage.setItem('printbit.mode', 'print');
  sessionStorage.setItem('printbit.sessionId', sid);

  attachSocket(sid);
  await checkUploadStatus();

  const response = await fetch(
    `/api/wireless/sessions/${encodeURIComponent(sid)}`,
  );
  if (response.ok) {
    const session = (await response.json()) as SessionResponse;
    updateUploadLink(session.uploadUrl);
  }

  if (pollHandle !== null) window.clearInterval(pollHandle);
  pollHandle = window.setInterval(() => void checkUploadStatus(), 2000);
}

// ── Events ────────────────────────────────────────────────────────────────────

refreshSessionBtn?.addEventListener('click', () => {
  if (knownFiles.size > 0) {
    showNewSessionDialog();
  } else {
    void createSession();
  }
});

continueBtn?.addEventListener('click', () => {
  if (!activeSessionId || !selectedFilename || !selectedDocumentId) return;
  window.location.href =
    `/config?mode=print&sessionId=${encodeURIComponent(activeSessionId)}` +
    `&file=${encodeURIComponent(selectedFilename)}` +
    `&documentId=${encodeURIComponent(selectedDocumentId)}`;
});

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
    if (activeSessionId) {
      try {
        const res = await fetch(
          `/api/wireless/sessions/${activeSessionId}/cancel`,
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
    window.location.replace('/');
  },
});

export { navigateTo };
function navigateTo(path: string) {
  window.location.href = path;
}
