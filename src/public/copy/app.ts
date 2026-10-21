import {
  initializePageIdleTimeout,
  setupPageIdleWarningButton,
} from '@/services/idle-timeout';
import { initKioskLocalization } from '../shared/kiosk-i18n';
import { navigateWithKioskMotion } from '../shared/kiosk-navigation';
import { mountLoadingAnimation } from '../shared/loading-animation';
import {
  destroyPdfLoadingTask,
  type PdfLoadingTask,
} from '../shared/pdfjs-loading-task-cleanup';
import { getCopyTroubleshootingGuide } from './troubleshooting';
import { attachUiBlockingOverlay } from '../shared/ui-blocking-overlay';
import { initPrinterGuard } from '@/guards/printer-guard';

declare const io: (opts?: {
  auth?: Record<string, string>;
  reconnectionDelay?: number;
}) => {
  on(event: string, cb: (...args: unknown[]) => void): void;
  off?(event: string, cb: (...args: unknown[]) => void): void;
  disconnect(): void;
};

const copySocket =
  typeof io === "function" ? io({ reconnectionDelay: 2000 }) : null;

export {};

void initKioskLocalization();
attachUiBlockingOverlay();
void initPrinterGuard(copySocket, { mode: "kiosk_wide_only" });

// ── Idle Timeout with Warning Modal (Copy Page) ───────────────────────────────────────────────

// Initialize page idle timeout on load with warning modal
void setupPageIdleWarningButton();
void initializePageIdleTimeout({
  showWarningModal: true,
  onTimeout: () => {
    console.log('[PAGE IDLE] Copy page timeout reached, redirecting to home');
    if (previewReleaseToken) {
      void releaseCopyPreviewFile(previewReleaseToken, 'copy_idle_timeout');
      previewReleaseToken = null;
    }
    // Clear state before redirect
    sessionStorage.removeItem('printbit.config');
    sessionStorage.removeItem('printbit.sessionId');
    sessionStorage.removeItem('printbit.copyPreviewPath');
    sessionStorage.removeItem('printbit.copyPreviewReleaseToken');
    navigateWithKioskMotion('/', 'replace');
  },
});

type PdfjsLib = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (
    src: string | ArrayBuffer | { data: ArrayBuffer },
  ) => PdfLoadingTask & { promise: Promise<PDFDocumentProxy> };
};

interface PDFDocumentProxy {
  numPages: number;
  getPage: (n: number) => Promise<PDFPageProxy>;
}

interface PDFPageProxy {
  getViewport: (opts: { scale: number }) => PDFViewport;
  render: (ctx: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PDFViewport;
  }) => { promise: Promise<void> };
}

interface PDFViewport {
  width: number;
  height: number;
}

const continueBtn = document.getElementById(
  'continueBtn',
) as HTMLButtonElement | null;
const checkDocBtn = document.getElementById(
  'checkDocBtn',
) as HTMLButtonElement | null;
const clearRescanBtn = document.getElementById(
  'clearRescanBtn',
) as HTMLButtonElement | null;
const scanOverlay = document.getElementById(
  'scanOverlay',
) as HTMLElement | null;
const copyLoadingAnimation = document.getElementById(
  'copyLoadingAnimation',
) as HTMLElement | null;
const copyLoadingCanvas = document.getElementById(
  'copyLoadingCanvas',
) as HTMLCanvasElement | null;
const errorBanner = document.getElementById(
  'errorBanner',
) as HTMLElement | null;
const errorText = document.getElementById('errorText') as HTMLElement | null;
const retryBtn = document.getElementById(
  'retryBtn',
) as HTMLButtonElement | null;
const previewSection = document.getElementById(
  'previewSection',
) as HTMLElement | null;
const previewPaper = document.getElementById(
  'previewPaper',
) as HTMLElement | null;
const previewCanvas = document.getElementById(
  'previewCanvas',
) as HTMLCanvasElement | null;
const previewImageStage = document.getElementById(
  'previewImageStage',
) as HTMLElement | null;
const previewImage = document.getElementById(
  'previewImage',
) as HTMLImageElement | null;
const previewPlaceholder = document.getElementById(
  'previewPlaceholder',
) as HTMLElement | null;
const previewStatusText = document.getElementById(
  'previewStatusText',
) as HTMLElement | null;
const copyTroubleshootingPanel = document.getElementById(
  'copyTroubleshootingPanel',
) as HTMLElement | null;
const copyTroubleshootCauses = document.getElementById(
  'copyTroubleshootCauses',
) as HTMLUListElement | null;
const copyTroubleshootSteps = document.getElementById(
  'copyTroubleshootSteps',
) as HTMLOListElement | null;
const backBtn = document.querySelector<HTMLAnchorElement>('a.back-btn');
const documentCareModal = document.getElementById('documentCareModal');
document.getElementById('documentCareBtn')?.addEventListener('click', () => {
  documentCareModal?.classList.add('is-open');
  documentCareModal?.setAttribute('aria-hidden', 'false');
});
document.getElementById('documentCareClose')?.addEventListener('click', () => {
  documentCareModal?.classList.remove('is-open');
  documentCareModal?.setAttribute('aria-hidden', 'true');
});
documentCareModal?.addEventListener('click', (event) => {
  if (event.target === documentCareModal)
    document.getElementById('documentCareClose')?.click();
});

// Which visual guide modal the "See Steps" button should open.
let currentVisualGuideKind: 'adf' | 'printer_panel' | null = null;

const copyAdfModal = document.getElementById('copyAdfModal');
const openCopyAdfModal = () => {
  const card = copyAdfModal?.querySelector('.adf-visual-modal__card');
  if (card) card.scrollTop = 0;
  copyAdfModal?.classList.add('is-open');
  copyAdfModal?.setAttribute('aria-hidden', 'false');
};
const closeCopyAdfModal = () => {
  copyAdfModal?.classList.remove('is-open');
  copyAdfModal?.setAttribute('aria-hidden', 'true');
};
document
  .getElementById('copyAdfModalOpenBtn')
  ?.addEventListener('click', openCopyAdfModal);
document
  .getElementById('copyAdfModalCloseBtn')
  ?.addEventListener('click', () => {
    closeCopyAdfModal();
    void checkForDocument();
  });
document
  .getElementById('copyAdfModalCloseIcon')
  ?.addEventListener('click', closeCopyAdfModal);
copyAdfModal?.addEventListener('click', (event) => {
  if (event.target === copyAdfModal) closeCopyAdfModal();
});

// ── Printer LED / panel modal (Long Bond / ADF printer errors) ──
const copyPrinterPanelModal = document.getElementById('copyPrinterPanelModal');
const openCopyPrinterPanelModal = () => {
  const card = copyPrinterPanelModal?.querySelector('.adf-visual-modal__card');
  if (card) card.scrollTop = 0;
  copyPrinterPanelModal?.classList.add('is-open');
  copyPrinterPanelModal?.setAttribute('aria-hidden', 'false');
};
const closeCopyPrinterPanelModal = () => {
  copyPrinterPanelModal?.classList.remove('is-open');
  copyPrinterPanelModal?.setAttribute('aria-hidden', 'true');
};
document
  .getElementById('copyPrinterPanelCloseBtn')
  ?.addEventListener('click', () => {
    closeCopyPrinterPanelModal();
    void checkForDocument();
  });
document
  .getElementById('copyPrinterPanelCloseIcon')
  ?.addEventListener('click', closeCopyPrinterPanelModal);
copyPrinterPanelModal?.addEventListener('click', (event) => {
  if (event.target === copyPrinterPanelModal) closeCopyPrinterPanelModal();
});

// "See Steps" opens the correct visual guide based on the current guide kind.
document.getElementById('copySeeStepsBtn')?.addEventListener('click', () => {
  if (currentVisualGuideKind === 'printer_panel') {
    openCopyPrinterPanelModal();
  } else {
    openCopyAdfModal();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    document.getElementById('documentCareClose')?.click();
    closeCopyAdfModal();
    closeCopyPrinterPanelModal();
  }
});

type CopyPaperSize = 'A4' | 'Short' | 'Long';

const copySourcePaperSizeRadios = document.querySelectorAll<HTMLInputElement>(
  'input[name="copySourcePaperSize"]',
);
const copyStep1Desc = document.getElementById('copyStep1Desc');
const copyFooterNote = document.getElementById('copyFooterNote');
const copyOverlaySub = document.getElementById('copyOverlaySub');
const copyPlaceholderLabel = document.getElementById('copyPlaceholderLabel');

function getSelectedCopyPaperSize(): CopyPaperSize {
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="copySourcePaperSize"]:checked',
  );
  if (checked?.value === 'Short' || checked?.value === 'Long') {
    return checked.value;
  }
  return 'A4';
}

function getSelectedCopySource(): 'feeder' | 'glass' {
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="copySource"]:checked, input[name="source"]:checked, input[name="copySourceType"]:checked',
  );
  if (checked?.value === 'feeder' || checked?.value === 'adf') {
    return 'feeder';
  }
  if (checked?.value === 'glass' || checked?.value === 'flatbed') {
    return 'glass';
  }
  return getSelectedCopyPaperSize() === 'Long' ? 'feeder' : 'glass';
}

function updateCopySourceInstructions(paperSize: CopyPaperSize): void {
  const isAdf = paperSize === 'Long';
  if (copyStep1Desc) {
    copyStep1Desc.textContent = isAdf
      ? 'Insert document face-up into the ADF, short edge first'
      : 'Align the paper face-down on the glass scanner';
  }
  if (copyFooterNote) {
    copyFooterNote.textContent = isAdf
      ? 'Insert document face-up into the ADF, short edge first.'
      : 'Ensure your document is flat and fully on the glass.';
  }
  if (copyOverlaySub) {
    copyOverlaySub.textContent = isAdf
      ? 'Please keep the document straight in the feeder.'
      : 'Please keep the document flat on the glass.';
  }
  if (copyPlaceholderLabel) {
    copyPlaceholderLabel.innerHTML = isAdf
      ? 'Insert document face-up in the ADF,<br />then tap <strong>Check Document</strong>'
      : 'Place your document face-down,<br />then tap <strong>Check Document</strong>';
  }
}

function setCopySourcePaperSize(paperSize: CopyPaperSize): void {
  for (const radio of copySourcePaperSizeRadios) {
    radio.checked = radio.value === paperSize;
  }
  updateCopySourceInstructions(paperSize);
}

function setCopySourceRadiosDisabled(disabled: boolean): void {
  for (const radio of copySourcePaperSizeRadios) {
    radio.disabled = disabled;
  }
}

copySourcePaperSizeRadios.forEach((radio) => {
  radio.addEventListener('change', () => {
    if (radio.checked) {
      const size = getSelectedCopyPaperSize();
      sessionStorage.setItem('printbit.copySourcePaperSize', size);
      updateCopySourceInstructions(size);
    }
  });
});

const copyLoadingController =
  copyLoadingAnimation && copyLoadingCanvas
    ? mountLoadingAnimation({
        root: copyLoadingAnimation,
        canvas: copyLoadingCanvas,
        mode: 'scan',
      })
    : null;

window.addEventListener('pagehide', (event) => {
  if (!event.persisted) copyLoadingController?.destroy();
});

let previewPath: string | null = null;
let previewReleaseToken: string | null = null;
let previewObjectUrl: string | null = null;
const RELEASE_TIMEOUT_MS = 1_500;


function sanitizeUserFacingError(rawMessage: string): string {
  const fallback = 'Could not complete scanner check. Please try again.';
  const initial = rawMessage.trim();
  if (!initial) return fallback;

  const safeMessage = initial
    .replace(/epson\s*l5290\s*series/gi, 'scanner')
    .replace(/naps2(?:\.console\.exe)?/gi, 'scanner service')
    .replace(/\btwain\b/gi, 'scanner driver')
    .replace(/\bwia\b/gi, 'scanner driver')
    .replace(/[A-Z]:\\[^ ]+/g, 'scanner service path')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!safeMessage) return fallback;
  return safeMessage;
}


function replaceListItems(
  listEl: HTMLUListElement | HTMLOListElement | null,
  items: string[],
): void {
  if (!listEl) return;
  listEl.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    listEl.appendChild(li);
  }
}

function hideCopyTroubleshooting(): void {
  if (copyTroubleshootingPanel) copyTroubleshootingPanel.style.display = 'none';
  const visualGuideEl = document.getElementById('copyAdfVisualGuide');
  if (visualGuideEl) visualGuideEl.style.display = 'none';
  const seeStepsBtn = document.getElementById('copySeeStepsBtn');
  if (seeStepsBtn) seeStepsBtn.style.display = 'none';
  currentVisualGuideKind = null;
}

function showCopyTroubleshooting(rawMessage: string, usesAdf: boolean): string {
  const isAdfRelated =
    usesAdf ||
    rawMessage.toLowerCase().includes("adf") ||
    rawMessage.toLowerCase().includes("feeder");
  const guide = getCopyTroubleshootingGuide(rawMessage, isAdfRelated);
  const safeMessage = sanitizeUserFacingError(rawMessage);
  const userFacingMessage = guide.summary || safeMessage;

  replaceListItems(copyTroubleshootCauses, guide.causes);
  replaceListItems(copyTroubleshootSteps, guide.steps);
  if (copyTroubleshootingPanel) copyTroubleshootingPanel.style.display = "";

  // Remember which visual guide (if any) matches this failure.
  currentVisualGuideKind = guide.visualGuideKind ?? (isAdfRelated ? "adf" : null);

  const shouldShowVisual = Boolean(guide.hasVisualGuide || isAdfRelated);

  const visualGuideEl = document.getElementById('copyAdfVisualGuide');
  if (visualGuideEl) {
    visualGuideEl.style.display = shouldShowVisual ? 'block' : 'none';
  }

  const seeStepsBtn = document.getElementById('copySeeStepsBtn');
  if (seeStepsBtn) {
    seeStepsBtn.style.display = shouldShowVisual ? 'inline-flex' : 'none';
    seeStepsBtn.setAttribute(
      'aria-controls',
      currentVisualGuideKind === 'printer_panel'
        ? 'copyPrinterPanelModal'
        : 'copyAdfModal',
    );
  }

  return userFacingMessage;
}

function setBackNavigationLocked(locked: boolean): void {
  if (!backBtn) return;
  if (locked) {
    backBtn.classList.add('back-btn--disabled');
    backBtn.setAttribute('aria-disabled', 'true');
    backBtn.setAttribute('tabindex', '-1');
    return;
  }

  backBtn.classList.remove('back-btn--disabled');
  backBtn.removeAttribute('aria-disabled');
  backBtn.removeAttribute('tabindex');
}

backBtn?.addEventListener('click', (event) => {
  if (backBtn.getAttribute('aria-disabled') === 'true') {
    event.preventDefault();
    event.stopPropagation();
  }
});

async function releaseCopyPreviewFile(
  releaseToken: string,
  reason: string,
): Promise<void> {
  const safeReleaseToken = releaseToken.trim();
  if (!safeReleaseToken) return;

  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    RELEASE_TIMEOUT_MS,
  );
  try {
    const response = await fetch('/api/scanner/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        releaseToken: safeReleaseToken,
        reason,
      }),
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload.error && payload.error.trim()) {
          detail = payload.error.trim();
        }
      } catch {
        // Non-JSON response; keep status detail.
      }
      throw new Error(detail);
    }
  } catch {
    // Best-effort cleanup.
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function clearPreviewImageUrl(): void {
  if (!previewObjectUrl) return;
  URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = null;
}

function showOverlay(show: boolean): void {
  if (!scanOverlay) return;
  copyLoadingController?.setActive(show);
  if (show) {
    scanOverlay.classList.add('is-visible');
    scanOverlay.setAttribute('aria-hidden', 'false');
  } else {
    scanOverlay.classList.remove('is-visible');
    scanOverlay.setAttribute('aria-hidden', 'true');
  }
}

function resetPreviewSurfaces(): void {
  if (previewCanvas) {
    previewCanvas.style.display = 'none';
    const ctx = previewCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  }
  if (previewImageStage) previewImageStage.style.display = 'none';
  if (previewImage) {
    previewImage.style.display = 'none';
    previewImage.removeAttribute('src');
  }
  clearPreviewImageUrl();
}

function setPreviewBlockedByError(blocked: boolean): void {
  errorBanner?.closest('.preview-col')?.classList.toggle('has-error', blocked);
}

function showError(msg: string, usesAdf = false): void {
  const safeMessage = showCopyTroubleshooting(msg, usesAdf);
  setPreviewBlockedByError(true);
  if (errorBanner) errorBanner.style.display = '';
  if (errorText) errorText.textContent = safeMessage;
  if (checkDocBtn) checkDocBtn.style.display = '';
  if (clearRescanBtn) clearRescanBtn.style.display = 'none';
  if (previewSection) previewSection.style.display = 'none';
  if (previewPlaceholder) previewPlaceholder.style.display = '';
  if (continueBtn) {
    continueBtn.style.display = 'none';
    continueBtn.disabled = true;
  }
  resetPreviewSurfaces();
  if (previewStatusText) {
    previewStatusText.textContent = 'Waiting for scan';
    previewStatusText.removeAttribute('data-status');
  }
}

function hideError(): void {
  setPreviewBlockedByError(false);
  if (errorBanner) errorBanner.style.display = "none";
  hideCopyTroubleshooting();
}

function clearSimulatedError(): void {
  hideError();
  closeCopyAdfModal();
  closeCopyPrinterPanelModal();
  setCopySourceRadiosDisabled(Boolean(previewPath));
  if (previewPath) {
    void showPreview(previewPath);
  } else {
    resetPreviewSurfaces();
    if (previewSection) previewSection.style.display = "none";
    if (previewPlaceholder) previewPlaceholder.style.display = "";
    if (continueBtn) {
      continueBtn.style.display = "none";
      continueBtn.disabled = true;
    }
    if (clearRescanBtn) clearRescanBtn.style.display = "none";
    if (checkDocBtn) {
      checkDocBtn.style.display = "";
      checkDocBtn.disabled = false;
    }
    if (previewStatusText) {
      previewStatusText.textContent = "Waiting for scan";
      previewStatusText.removeAttribute("data-status");
    }
  }
}

function setupCopySocket(): void {
  if (!copySocket) return;

  copySocket.on("scan:adf-error", (payload: unknown) => {
    const errorMsg =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : "Printer ADF Error Detected. Clear the printer ADF error or paper jam, then proceed with scanning.";
    showError(errorMsg, true);
  });

  copySocket.on("printer:simulation-state", (payload: unknown) => {
    const p = payload as { activeError?: string | null } | null;
    if (p?.activeError === "adf_error") {
      showError(
        "Printer ADF Error Detected. Clear the printer ADF error or paper jam, then proceed with scanning.",
        true,
      );
    } else if (!p?.activeError) {
      clearSimulatedError();
    }
  });

  copySocket.on("printer:simulation-cleared", (payload: unknown) => {
    const p = payload as { redirectHome?: boolean } | null;
    if (p?.redirectHome) {
      sessionStorage.removeItem("printbit.copyPreviewPath");
      sessionStorage.removeItem("printbit.copyPreviewReleaseToken");
      sessionStorage.removeItem("printbit.copySourcePaperSize");
      navigateWithKioskMotion("/", "replace");
      return;
    }
    clearSimulatedError();
  });

  copySocket.on("printer:paper-jam-cleared", () => {
    sessionStorage.removeItem("printbit.copyPreviewPath");
    sessionStorage.removeItem("printbit.copyPreviewReleaseToken");
    sessionStorage.removeItem("printbit.copySourcePaperSize");
    navigateWithKioskMotion("/", "replace");
  });

  copySocket.on("printerStatusRestored", () => {
    clearSimulatedError();
  });

  copySocket.on("printerRecovered", () => {
    clearSimulatedError();
  });
}

async function renderPdfPreview(buf: ArrayBuffer): Promise<void> {
  if (!previewCanvas) throw new Error('Preview canvas not found');

  const dynImport = new Function('u', 'return import(u)') as (
    u: string,
  ) => Promise<Record<string, unknown>>;
  const mod = await dynImport('/libs/pdfjs/pdf.min.mjs');
  const pdfjs = (mod.default ?? mod) as PdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = `${window.location.origin}/libs/pdfjs/pdf.worker.min.mjs`;

  const loadingTask = pdfjs.getDocument({ data: buf });
  const pdfDoc = await loadingTask.promise;
  try {
    const firstPage = await pdfDoc.getPage(1);
    const baseViewport = firstPage.getViewport({ scale: 1 });

    const paperWidth = Math.max((previewPaper?.clientWidth ?? 840) - 24, 240);
    const paperHeight = Math.max(
      (previewPaper?.clientHeight ?? 1188) - 24,
      320,
    );
    const dpr = window.devicePixelRatio || 1;
    const scale =
      Math.min(
        paperWidth / baseViewport.width,
        paperHeight / baseViewport.height,
      ) * dpr;
    const viewport = firstPage.getViewport({ scale });

    previewCanvas.width = Math.floor(viewport.width);
    previewCanvas.height = Math.floor(viewport.height);

    const ctx = previewCanvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context unavailable');

    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    await firstPage.render({ canvasContext: ctx, viewport }).promise;

    if (previewImageStage) previewImageStage.style.display = 'none';
    previewCanvas.style.display = 'block';
  } finally {
    await destroyPdfLoadingTask(loadingTask);
  }
}

async function renderImagePreview(blob: Blob): Promise<void> {
  if (!previewImage || !previewImageStage) {
    throw new Error('Preview image element not found');
  }

  clearPreviewImageUrl();
  previewObjectUrl = URL.createObjectURL(blob);

  await new Promise<void>((resolve, reject) => {
    previewImage.onload = () => resolve();
    previewImage.onerror = () => reject(new Error('Image preview failed'));
    previewImage.src = previewObjectUrl!;
  });

  if (previewCanvas) previewCanvas.style.display = 'none';
  previewImageStage.style.display = 'grid';
  previewImage.style.display = 'block';
}

async function loadPreviewContent(filename: string): Promise<void> {
  const response = await fetch(
    `/api/scan/preview/${encodeURIComponent(filename)}`,
  );
  if (!response.ok) {
    throw new Error(`Preview request failed (${response.status})`);
  }

  const contentType = (
    response.headers.get('Content-Type') ?? ''
  ).toLowerCase();

  if (contentType.includes('application/pdf')) {
    const buf = await response.arrayBuffer();
    await renderPdfPreview(buf);
    return;
  }

  if (contentType.startsWith('image/')) {
    const blob = await response.blob();
    await renderImagePreview(blob);
    return;
  }

  throw new Error(`Unsupported preview format: ${contentType || 'unknown'}`);
}

async function showPreview(filename: string): Promise<void> {
  hideError();
  if (previewPlaceholder) previewPlaceholder.style.display = 'none';
  if (previewSection) previewSection.style.display = '';
  if (previewStatusText) {
    previewStatusText.textContent = 'Loading preview…';
    previewStatusText.setAttribute('data-status', 'loading');
  }
  resetPreviewSurfaces();

  try {
    await loadPreviewContent(filename);
  } catch (error) {
    console.error('[COPY PREVIEW] Failed to render preview.', error);
    showError('Could not render scanned preview. Please retry.');
    return;
  }

  if (continueBtn) {
    continueBtn.style.display = '';
    continueBtn.disabled = false;
  }
  if (checkDocBtn) checkDocBtn.style.display = 'none';
  if (clearRescanBtn) clearRescanBtn.style.display = '';
  if (previewStatusText) {
    previewStatusText.textContent = 'Ready to copy';
    previewStatusText.setAttribute('data-status', 'ready');
  }
  setCopySourceRadiosDisabled(true);
}

function clearAndRescan(): void {
  // Release the preview file server-side (best-effort)
  if (previewReleaseToken) {
    void releaseCopyPreviewFile(previewReleaseToken, 'copy_clear_and_rescan');
  }

  // Reset module-level state
  previewPath = null;
  previewReleaseToken = null;

  // Clear session storage
  sessionStorage.removeItem('printbit.copyPreviewPath');
  sessionStorage.removeItem('printbit.copyPreviewReleaseToken');
  sessionStorage.removeItem('printbit.copySourcePaperSize');

  // Reset UI back to initial state
  setCopySourceRadiosDisabled(false);
  hideError();
  resetPreviewSurfaces();
  if (previewSection) previewSection.style.display = 'none';
  if (previewPlaceholder) previewPlaceholder.style.display = '';
  if (continueBtn) {
    continueBtn.style.display = 'none';
    continueBtn.disabled = true;
  }
  if (clearRescanBtn) clearRescanBtn.style.display = 'none';
  if (checkDocBtn) {
    checkDocBtn.style.display = '';
    checkDocBtn.disabled = false;
  }
  if (previewStatusText) {
    previewStatusText.textContent = 'Waiting for scan';
    previewStatusText.removeAttribute('data-status');
  }
}

clearRescanBtn?.addEventListener('click', () => clearAndRescan());

async function checkForDocument(): Promise<void> {
  const paperSize = getSelectedCopyPaperSize();
  sessionStorage.setItem('printbit.copySourcePaperSize', paperSize);
  hideError();
  setBackNavigationLocked(true);
  setCopySourceRadiosDisabled(true);
  showOverlay(true);
  if (checkDocBtn) checkDocBtn.disabled = true;
  if (clearRescanBtn) clearRescanBtn.disabled = true;

  try {
    const res = await fetch('/api/scan/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paperSize }),
    });
    const data = (await res.json()) as {
      detected: boolean;
      previewPath?: string;
      releaseToken?: string;
      error?: string;
    };

    showOverlay(false);

    if (data.detected && data.previewPath && data.releaseToken) {
      if (previewReleaseToken && previewReleaseToken !== data.releaseToken) {
        void releaseCopyPreviewFile(
          previewReleaseToken,
          'copy_preview_replaced',
        );
      }
      previewPath = data.previewPath;
      previewReleaseToken = data.releaseToken;

      sessionStorage.setItem('printbit.copyPreviewPath', previewPath);
      sessionStorage.setItem(
        'printbit.copyPreviewReleaseToken',
        previewReleaseToken,
      );

      await showPreview(data.previewPath);
    } else {
      setCopySourceRadiosDisabled(false);
      const isUsingAdf =
        getSelectedCopySource() === "feeder" ||
        (data.error ?? "").toLowerCase().includes("adf") ||
        (data.error ?? "").toLowerCase().includes("feeder");
      showError(data.error ?? "No document detected.", isUsingAdf);
    }
  } catch {
    showOverlay(false);
    setCopySourceRadiosDisabled(false);
    const isUsingAdf = getSelectedCopySource() === 'feeder';
    showError('Could not reach the scanner. Please try again.', isUsingAdf);
  } finally {
    setBackNavigationLocked(false);
    if (checkDocBtn) checkDocBtn.disabled = false;
    if (clearRescanBtn) clearRescanBtn.disabled = false;
  }
}

checkDocBtn?.addEventListener('click', () => void checkForDocument());
retryBtn?.addEventListener('click', () => void checkForDocument());

continueBtn?.addEventListener('click', () => {
  sessionStorage.setItem('printbit.mode', 'copy');
  sessionStorage.removeItem('printbit.sessionId');
  sessionStorage.removeItem('printbit.uploadedFile');
  if (previewPath) {
    sessionStorage.setItem('printbit.copyPreviewPath', previewPath);
  }
  if (previewReleaseToken) {
    sessionStorage.setItem(
      'printbit.copyPreviewReleaseToken',
      previewReleaseToken,
    );
  } else {
    sessionStorage.removeItem('printbit.copyPreviewReleaseToken');
  }
  navigateWithKioskMotion('/config?mode=copy');
});

window.addEventListener('beforeunload', clearPreviewImageUrl);

async function initializeCopyPage(): Promise<void> {
  setupCopySocket();

  void fetch("/api/printer/simulation-status")
    .then((res) => (res.ok ? res.json() : null))
    .then(
      (
        data: {
          activeError?: string | null;
          simulation?: { activeError?: string | null };
        } | null,
      ) => {
        const activeError = data?.activeError ?? data?.simulation?.activeError;
        if (activeError === "adf_error") {
          showError(
            "Printer ADF Error Detected. Clear the printer ADF error or paper jam, then proceed with scanning.",
            true,
          );
        }
      },
    )
    .catch(() => {});

  const savedSourceSize = sessionStorage.getItem(
    'printbit.copySourcePaperSize',
  );
  if (
    savedSourceSize === 'A4' ||
    savedSourceSize === 'Short' ||
    savedSourceSize === 'Long'
  ) {
    setCopySourcePaperSize(savedSourceSize);
  } else if (savedSourceSize === 'Letter') {
    setCopySourcePaperSize('Short');
  } else if (savedSourceSize === 'Legal') {
    setCopySourcePaperSize('Long');
  } else {
    updateCopySourceInstructions('A4');
  }

  previewPath = sessionStorage.getItem('printbit.copyPreviewPath');
  previewReleaseToken = sessionStorage.getItem(
    'printbit.copyPreviewReleaseToken',
  );

  if (previewPath) {
    console.log('[COPY] Restoring preview from session:', previewPath);
    setCopySourceRadiosDisabled(true);
    await showPreview(previewPath);
  }
}

void initializeCopyPage();
