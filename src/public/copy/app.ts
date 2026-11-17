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
import {
  getCopyTroubleshootingGuide,
  getCopyTroubleshootingGuideForCode,
} from './troubleshooting';
import {
  PAPER_POINTS,
  type Orientation,
  type PaperSize,
} from '../../shared/print-configuration';
import { slotFractions, type IdSide } from '../../shared/id-card-layout';
import {
  ID_SESSION_EXPIRED_CODE,
  type IdScanWarningCode,
} from '../../shared/id-copy-contract';
import { detectPaperSizeFromDimensions } from '../config/geometry-detection';
import { fetchWithTimeout } from '../shared/fetch-with-timeout';
import {
  computeSheetRender,
  defaultCopyLayout,
  fitSheetInBox,
  paintPageOnSheet,
} from '../shared/print-preview-sheet';
import { attachUiBlockingOverlay } from '../shared/ui-blocking-overlay';
import { buildCopyConfig } from '../shared/copy-config';
import { initPrinterGuard } from '@/guards/printer-guard';
import {
  canContinue,
  createCopyFlowState,
  isCopyTypeLocked,
  isSheetComplete,
  nextIdScanTarget,
  parseSnapshot,
  reduceCopyFlow,
  toSnapshot,
  type CopyFlowEvent,
  type CopyFlowState,
  type ScanTarget,
} from './copy-flow-state';
import {
  COPY_SETTINGS_STORAGE_KEY,
  DEFAULT_COPY_SETTINGS,
  copiesLimits,
  parseCopySettings,
  parsePaperSize,
  serializeCopySettings,
  stepCopies,
  type CopySettings,
} from './copy-settings';
import { createIdCaptureClient, type IdCaptureResult } from './id-capture';

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

// ── Session keys and page state ─────────────────────────────────────────────

const STORAGE_KEYS = {
  previewPath: 'printbit.copyPreviewPath',
  releaseToken: 'printbit.copyPreviewReleaseToken',
  sourcePaperSize: 'printbit.copySourcePaperSize',
  flow: 'printbit.copyFlow',
  idSession: 'printbit.copyIdSessionId',
  settings: COPY_SETTINGS_STORAGE_KEY,
} as const;

function setOrRemove(key: string, value: string | null): void {
  if (value) sessionStorage.setItem(key, value);
  else sessionStorage.removeItem(key);
}

function clearCopyStorage(): void {
  for (const key of Object.values(STORAGE_KEYS)) sessionStorage.removeItem(key);
  sessionStorage.removeItem('printbit.config');
  sessionStorage.removeItem('printbit.sessionId');
}

let flow: CopyFlowState = createCopyFlowState();
let settings: CopySettings = { ...DEFAULT_COPY_SETTINGS };
/** Document size chosen in the capture stage. Sets scan area and source. */
let documentSize: PaperSize = 'A4';
let previewPath: string | null = null;
let previewReleaseToken: string | null = null;
let idSessionId: string | null = null;
/** Paper and orientation of the scanned document, from the preview render. */
let documentLayout: { paperSize: PaperSize; orientation: Orientation } | null =
  null;
let previewRendered = false;
let previewRequestId = 0;
let composing = false;
let errorShown = false;
/** What the Retry button repeats. Null after a success. */
let retryAction: (() => Promise<void>) | null = null;

// ── Idle timeout ────────────────────────────────────────────────────────────

void setupPageIdleWarningButton();
void initializePageIdleTimeout({
  showWarningModal: true,
  onTimeout: () => {
    console.log('[PAGE IDLE] Copy page timeout reached, redirecting to home');
    leaveForHome('copy_idle_timeout');
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

// ── Elements ────────────────────────────────────────────────────────────────

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function radios(name: string): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`),
  );
}

const copyLayout = byId('copyLayout');
const captureStage = byId('captureStage');
const settingsStage = byId('settingsStage');
const paperViewport = byId('paperViewport');
const paperSheet = byId('paperSheet');
const previewCanvas = byId<HTMLCanvasElement>('previewCanvas');
const paperPlaceholder = byId('paperPlaceholder');
const copyPlaceholderLabel = byId('copyPlaceholderLabel');
const backSlotOverlay = byId('backSlotOverlay');
const previewStatusText = byId('previewStatusText');
const copyPreviewActions = byId('copyPreviewActions');
const scanAgainBtn = byId<HTMLButtonElement>('scanAgainBtn');
const retakeFrontBtn = byId<HTMLButtonElement>('retakeFrontBtn');
const rotateFrontBtn = byId<HTMLButtonElement>('rotateFrontBtn');
const retakeBackBtn = byId<HTMLButtonElement>('retakeBackBtn');
const rotateBackBtn = byId<HTMLButtonElement>('rotateBackBtn');
const copyStep1Desc = byId('copyStep1Desc');
const idStepFront = byId('idStepFront');
const idStepFrontState = byId('idStepFrontState');
const idStepBack = byId('idStepBack');
const idStepBackState = byId('idStepBackState');
const flipPrompt = byId('flipPrompt');
const flipScanBackBtn = byId<HTMLButtonElement>('flipScanBackBtn');
const flipRetakeFrontBtn = byId<HTMLButtonElement>('flipRetakeFrontBtn');
const startOverBtn = byId<HTMLButtonElement>('startOverBtn');
const copyTypeSummary = byId('copyTypeSummary');
const changeCopyTypeBtn = byId<HTMLButtonElement>('changeCopyTypeBtn');
const copiesInput = byId<HTMLInputElement>('copies');
const copiesDec = byId<HTMLButtonElement>('copiesDec');
const copiesInc = byId<HTMLButtonElement>('copiesInc');
const checkDocBtn = byId<HTMLButtonElement>('checkDocBtn');
const scanSideBtn = byId<HTMLButtonElement>('scanSideBtn');
const scanSideLabel = byId('scanSideLabel');
const continueBtn = byId<HTMLButtonElement>('continueBtn');
const scanOverlay = byId('scanOverlay');
const copyOverlayTitle = byId('copyOverlayTitle');
const copyOverlaySub = byId('copyOverlaySub');
const copyLoadingAnimation = byId('copyLoadingAnimation');
const copyLoadingCanvas = byId<HTMLCanvasElement>('copyLoadingCanvas');
const errorBanner = byId('errorBanner');
const errorText = byId('errorText');
const retryBtn = byId<HTMLButtonElement>('retryBtn');
const copyTroubleshootingPanel = byId('copyTroubleshootingPanel');
const copyTroubleshootCauses = byId<HTMLUListElement>('copyTroubleshootCauses');
const copyTroubleshootSteps = byId<HTMLOListElement>('copyTroubleshootSteps');
const warningDialog = byId<HTMLDialogElement>('idWarningDialog');
const warningText = byId('idWarningText');
const warningKeepBtn = byId<HTMLButtonElement>('idWarningKeepBtn');
const warningRetakeBtn = byId<HTMLButtonElement>('idWarningRetakeBtn');
const copyTypeRadios = radios('copyType');
const documentSizeRadios = radios('copySourcePaperSize');
const paperSizeRadios = radios('paperSize');
const colorModeRadios = radios('colorMode');
const qualityRadios = radios('printQuality');

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
    void retryLastScan();
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
    void retryLastScan();
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

const RELEASE_TIMEOUT_MS = 1_500;
// Must stay above Node's SCAN_COMMAND_TIMEOUT_MS (100 s) so the server's more
// specific error normally wins. Guarded by scan-timeout-alignment.spec.ts.
const COPY_PREVIEW_REQUEST_TIMEOUT_MS = 110_000;

const idCapture = createIdCaptureClient({
  fetch: fetchWithTimeout,
  timeoutMs: COPY_PREVIEW_REQUEST_TIMEOUT_MS,
});

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

function showCopyTroubleshooting(
  rawMessage: string,
  usesAdf: boolean,
  code?: string,
): string {
  const isAdfRelated =
    usesAdf ||
    rawMessage.toLowerCase().includes("adf") ||
    rawMessage.toLowerCase().includes("feeder");
  // The server's failure code is exact. Message matching is the fallback for
  // socket events and older responses.
  const guide =
    getCopyTroubleshootingGuideForCode(code, usesAdf) ??
    getCopyTroubleshootingGuide(rawMessage, isAdfRelated);
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

// ── Small DOM helpers ───────────────────────────────────────────────────────

function setHidden(element: Element | null, hidden: boolean): void {
  element?.classList.toggle('hidden', hidden);
}

function setDisabled(
  button: HTMLButtonElement | null,
  disabled: boolean,
): void {
  if (!button) return;
  button.disabled = disabled;
  button.setAttribute('aria-disabled', String(disabled));
}

function lockCard(input: HTMLInputElement, locked: boolean): void {
  input.closest('.option-card')?.setAttribute('data-locked', String(locked));
}

// ── Release and leave ───────────────────────────────────────────────────────

function releaseCurrentPreview(reason: string): void {
  if (previewReleaseToken) {
    void releaseCopyPreviewFile(previewReleaseToken, reason);
  }
}

function leaveForHome(reason: string): void {
  releaseCurrentPreview(reason);
  clearCopyStorage();
  navigateWithKioskMotion('/', 'replace');
}

// ── Scan overlay ────────────────────────────────────────────────────────────

const OVERLAY_TITLES: Record<ScanTarget, string> = {
  document: 'Scanning…',
  front: 'Scanning front…',
  back: 'Scanning back…',
};

function overlaySubtitle(target: ScanTarget): string {
  if (target !== 'document') {
    return 'Keep the lid closed and your ID on the marked corner.';
  }
  return documentSize === 'Long'
    ? 'Please keep the document straight in the feeder.'
    : 'Please keep the document flat on the glass.';
}

function showOverlay(target: ScanTarget | null): void {
  if (!scanOverlay) return;
  copyLoadingController?.setActive(target !== null);
  if (target) {
    if (copyOverlayTitle) copyOverlayTitle.textContent = OVERLAY_TITLES[target];
    if (copyOverlaySub) copyOverlaySub.textContent = overlaySubtitle(target);
  }
  scanOverlay.classList.toggle('is-visible', target !== null);
  scanOverlay.setAttribute('aria-hidden', target ? 'false' : 'true');
}

// ── Error card ──────────────────────────────────────────────────────────────

function setPreviewBlockedByError(blocked: boolean): void {
  errorBanner?.closest('.preview-col')?.classList.toggle('has-error', blocked);
}

function showError(message: string, usesAdf = false, code?: string): void {
  const safeMessage = showCopyTroubleshooting(message, usesAdf, code);
  errorShown = true;
  setPreviewBlockedByError(true);
  if (errorBanner) errorBanner.style.display = '';
  if (errorText) errorText.textContent = safeMessage;
  render();
}

function hideError(): void {
  errorShown = false;
  setPreviewBlockedByError(false);
  if (errorBanner) errorBanner.style.display = 'none';
  hideCopyTroubleshooting();
}

function clearSimulatedError(): void {
  hideError();
  closeCopyAdfModal();
  closeCopyPrinterPanelModal();
  render();
  if (previewPath && !previewRendered) void showPreview(previewPath);
}

// ── Printer sockets ─────────────────────────────────────────────────────────

const ADF_ERROR_MESSAGE =
  'Printer ADF Error Detected. Clear the printer ADF error or paper jam, then proceed with scanning.';

function setupCopySocket(): void {
  if (!copySocket) return;

  copySocket.on('scan:adf-error', (payload: unknown) => {
    const errorMsg =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : ADF_ERROR_MESSAGE;
    showError(errorMsg, true);
  });

  copySocket.on('printer:simulation-state', (payload: unknown) => {
    const p = payload as { activeError?: string | null } | null;
    if (p?.activeError === 'adf_error') {
      showError(ADF_ERROR_MESSAGE, true);
    } else if (!p?.activeError) {
      clearSimulatedError();
    }
  });

  copySocket.on('printer:simulation-cleared', (payload: unknown) => {
    const p = payload as { redirectHome?: boolean } | null;
    if (p?.redirectHome) {
      leaveForHome('copy_simulation_cleared');
      return;
    }
    clearSimulatedError();
  });

  copySocket.on('printer:paper-jam-cleared', () => {
    leaveForHome('copy_paper_jam_cleared');
  });

  copySocket.on('printerStatusRestored', () => clearSimulatedError());
  copySocket.on('printerRecovered', () => clearSimulatedError());
}

// ── Sheet preview ───────────────────────────────────────────────────────────

function sizePaperSheet(
  paperSize: PaperSize,
  orientation: Orientation,
): { width: number; height: number } {
  const [width, height] = PAPER_POINTS[paperSize];
  const [paperWidth, paperHeight] =
    orientation === 'landscape' ? [height, width] : [width, height];
  const boxWidth = Math.max((paperViewport?.clientWidth ?? 840) - 24, 240);
  const boxHeight = Math.max((paperViewport?.clientHeight ?? 1188) - 24, 320);
  const sheet = fitSheetInBox(paperWidth, paperHeight, boxWidth, boxHeight);
  if (paperSheet) {
    paperSheet.style.width = `${sheet.width}px`;
    paperSheet.style.height = `${sheet.height}px`;
  }
  return sheet;
}

function emptySheetPaperSize(): PaperSize {
  return flow.copyType === 'document' ? documentSize : settings.paperSize;
}

/** Places the dashed back slot where the back will print. */
function positionBackSlot(): void {
  if (!backSlotOverlay) return;
  const slot = slotFractions(settings.paperSize, 'back');
  backSlotOverlay.style.left = `${slot.left * 100}%`;
  backSlotOverlay.style.top = `${slot.top * 100}%`;
  backSlotOverlay.style.width = `${slot.width * 100}%`;
  backSlotOverlay.style.height = `${slot.height * 100}%`;
}

async function renderPdfPreview(
  buf: ArrayBuffer,
  paperSizeHint: PaperSize,
): Promise<{ paperSize: PaperSize; orientation: Orientation }> {
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

    // Same sheet layout as the printed page: the page sits inside the print
    // margins, not stretched edge to edge.
    const layoutConfig = defaultCopyLayout(
      detectPaperSizeFromDimensions(baseViewport.width, baseViewport.height) ??
        paperSizeHint,
      baseViewport.width,
      baseViewport.height,
    );
    const sheet = sizePaperSheet(
      layoutConfig.paperSize,
      layoutConfig.orientation,
    );
    const sheetRender = computeSheetRender(
      baseViewport.width,
      baseViewport.height,
      layoutConfig,
      sheet.width,
      sheet.height,
      window.devicePixelRatio || 1,
    );
    const viewport = firstPage.getViewport({ scale: sheetRender.renderScale });

    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = Math.max(1, Math.ceil(viewport.width));
    sourceCanvas.height = Math.max(1, Math.ceil(viewport.height));
    const sourceCtx = sourceCanvas.getContext('2d');
    const ctx = previewCanvas.getContext('2d');
    if (!sourceCtx || !ctx) throw new Error('Canvas context unavailable');
    await firstPage.render({ canvasContext: sourceCtx, viewport }).promise;

    previewCanvas.width = sheetRender.canvasWidth;
    previewCanvas.height = sheetRender.canvasHeight;
    paintPageOnSheet(
      ctx,
      previewCanvas,
      sourceCanvas,
      viewport.width,
      viewport.height,
      sheetRender.rotationRad,
    );
    return {
      paperSize: layoutConfig.paperSize,
      orientation: layoutConfig.orientation,
    };
  } finally {
    await destroyPdfLoadingTask(loadingTask);
  }
}

async function showPreview(filename: string): Promise<void> {
  const requestId = ++previewRequestId;
  previewRendered = false;
  render();
  try {
    const response = await fetch(
      `/api/scan/preview/${encodeURIComponent(filename)}`,
    );
    if (!response.ok) {
      throw new Error(`Preview request failed (${response.status})`);
    }
    const buf = await response.arrayBuffer();
    if (requestId !== previewRequestId) return;
    const layout = await renderPdfPreview(
      buf,
      flow.copyType === 'id' ? settings.paperSize : documentSize,
    );
    if (requestId !== previewRequestId) return;
    if (flow.copyType === 'document') documentLayout = layout;
    previewRendered = true;
  } catch (error) {
    if (requestId !== previewRequestId) return;
    console.error('[COPY PREVIEW] Failed to render preview.', error);
    retryAction = async () => {
      hideError();
      await showPreview(filename);
    };
    showError('Could not render scanned preview. Please retry.');
    return;
  }
  render();
}

// ── Render ──────────────────────────────────────────────────────────────────

const WARNING_TEXT: Record<IdScanWarningCode, string> = {
  side_blank:
    'This side looks empty. Is your ID on the marked corner, face-down?',
  sides_identical: 'Front and back look the same. Did you flip your ID?',
};

function outputPaperSize(): PaperSize {
  return flow.copyType === 'document'
    ? (documentLayout?.paperSize ?? documentSize)
    : settings.paperSize;
}

function placeholderText(): string {
  if (flow.copyType === 'id') {
    return 'Place your ID face-down on the marked corner, then tap Scan Front';
  }
  return documentSize === 'Long'
    ? 'Insert document face-up in the ADF, then tap Check Document'
    : 'Place your document face-down, then tap Check Document';
}

function statusText(): { text: string; status: 'loading' | 'ready' | null } {
  if (composing) return { text: 'Updating preview…', status: 'loading' };
  if (previewPath && !previewRendered) {
    return { text: 'Loading preview…', status: 'loading' };
  }
  if (flow.copyType === 'id' && flow.front && !flow.back) {
    return { text: 'Waiting for back side', status: null };
  }
  if (previewRendered && isSheetComplete(flow)) {
    return { text: 'Ready to copy', status: 'ready' };
  }
  return { text: 'Waiting for scan', status: null };
}

function renderStep(
  step: HTMLElement | null,
  label: HTMLElement | null,
  side: IdSide,
): void {
  const state =
    flow.scanning === side ? 'scanning' : flow[side] ? 'done' : 'waiting';
  step?.setAttribute('data-state', state);
  if (label) {
    label.textContent =
      state === 'scanning' ? 'Scanning' : state === 'done' ? 'Done' : 'Waiting';
  }
}

function renderSettingsControls(busy: boolean): void {
  const paper = outputPaperSize();
  const paperLocked = flow.copyType === 'document';
  for (const radio of paperSizeRadios) {
    radio.checked = radio.value === paper;
    radio.disabled = paperLocked || busy;
    lockCard(radio, paperLocked && !radio.checked);
  }
  for (const radio of colorModeRadios) {
    radio.checked = radio.value === settings.colorMode;
  }
  for (const radio of qualityRadios) {
    radio.checked = radio.value === settings.quality;
  }
  if (copiesInput) copiesInput.value = String(settings.copies);
  const limits = copiesLimits(settings.copies);
  setDisabled(copiesDec, !limits.canDecrease);
  setDisabled(copiesInc, !limits.canIncrease);
}

function renderWarningDialog(): void {
  if (!warningDialog) return;
  const warning = flow.scanning === null ? flow.pendingWarnings[0] : undefined;
  if (!warning) {
    if (warningDialog.open) warningDialog.close();
    return;
  }
  if (warningText) warningText.textContent = WARNING_TEXT[warning.code];
  if (!warningDialog.open) warningDialog.showModal();
}

function render(): void {
  const busy = flow.scanning !== null || composing;
  const locked = isCopyTypeLocked(flow);
  const inCapture = flow.stage === 'capture';
  const idTarget = nextIdScanTarget(flow);
  const awaitingAnswer = flow.pendingWarnings.length > 0;
  const hasPreview = Boolean(previewPath) && previewRendered;

  if (copyLayout) {
    copyLayout.dataset.copyType = flow.copyType;
    copyLayout.dataset.copyStage = flow.stage;
  }
  setHidden(captureStage, !inCapture);
  setHidden(settingsStage, inCapture);

  for (const radio of copyTypeRadios) {
    radio.checked = radio.value === flow.copyType;
    radio.disabled = locked;
    lockCard(radio, locked && !radio.checked);
  }
  for (const radio of documentSizeRadios) {
    radio.checked = radio.value === documentSize;
    radio.disabled = locked;
    lockCard(radio, locked && !radio.checked);
  }
  if (copyStep1Desc) {
    copyStep1Desc.textContent =
      documentSize === 'Long'
        ? 'Insert document face-up into the ADF, short edge first'
        : 'Align the paper face-down on the glass scanner';
  }

  renderStep(idStepFront, idStepFrontState, 'front');
  renderStep(idStepBack, idStepBackState, 'back');
  setHidden(
    flipPrompt,
    !(flow.copyType === 'id' && flow.front && !flow.back && !awaitingAnswer),
  );
  setDisabled(flipScanBackBtn, busy);
  setDisabled(flipRetakeFrontBtn, busy);
  setHidden(
    startOverBtn,
    !(flow.copyType === 'id' && (flow.front || flow.back)),
  );
  setDisabled(startOverBtn, busy);

  setHidden(checkDocBtn, !inCapture);
  setDisabled(checkDocBtn, busy);
  setHidden(scanSideBtn, !inCapture || idTarget === null);
  setDisabled(scanSideBtn, busy || awaitingAnswer);
  if (scanSideLabel) {
    scanSideLabel.textContent =
      idTarget === 'back' ? 'Scan Back' : 'Scan Front';
  }

  if (copyTypeSummary) {
    copyTypeSummary.textContent =
      flow.copyType === 'id' ? 'ID Card' : 'Document';
  }
  setDisabled(changeCopyTypeBtn, busy);
  renderSettingsControls(busy);

  setHidden(copyPreviewActions, inCapture);
  setDisabled(scanAgainBtn, busy);
  setDisabled(retakeFrontBtn, busy);
  setDisabled(retakeBackBtn, busy);
  setDisabled(rotateFrontBtn, busy || !flow.front);
  setDisabled(rotateBackBtn, busy || !flow.back);

  setHidden(paperPlaceholder, hasPreview);
  if (previewCanvas)
    previewCanvas.style.display = hasPreview ? 'block' : 'none';
  if (copyPlaceholderLabel)
    copyPlaceholderLabel.textContent = placeholderText();
  setHidden(
    backSlotOverlay,
    !(hasPreview && flow.copyType === 'id' && flow.front && !flow.back),
  );
  if (!hasPreview) sizePaperSheet(emptySheetPaperSize(), 'portrait');
  paperSheet?.toggleAttribute('data-gray', settings.colorMode === 'grayscale');

  const status = statusText();
  if (previewStatusText) {
    previewStatusText.textContent = status.text;
    if (status.status)
      previewStatusText.setAttribute('data-status', status.status);
    else previewStatusText.removeAttribute('data-status');
  }

  setHidden(continueBtn, inCapture);
  setDisabled(
    continueBtn,
    !canContinue(flow) || !hasPreview || errorShown || composing,
  );

  renderWarningDialog();
}

// ── State changes ───────────────────────────────────────────────────────────

function persist(): void {
  sessionStorage.setItem(STORAGE_KEYS.flow, JSON.stringify(toSnapshot(flow)));
  sessionStorage.setItem(
    STORAGE_KEYS.settings,
    serializeCopySettings(settings),
  );
  sessionStorage.setItem(STORAGE_KEYS.sourcePaperSize, documentSize);
  setOrRemove(STORAGE_KEYS.previewPath, previewPath);
  setOrRemove(STORAGE_KEYS.releaseToken, previewReleaseToken);
  setOrRemove(STORAGE_KEYS.idSession, idSessionId);
}

function dispatch(event: CopyFlowEvent): void {
  flow = reduceCopyFlow(flow, event);
  persist();
  render();
}

/** Starts a scan. False when the reducer refused it (busy or wrong type). */
function beginScan(target: ScanTarget): boolean {
  const next = reduceCopyFlow(flow, { type: 'scan-started', target });
  if (next === flow) return false;
  hideError();
  setBackNavigationLocked(true);
  showOverlay(target);
  flow = next;
  persist();
  render();
  return true;
}

function endScan(): void {
  showOverlay(null);
  setBackNavigationLocked(false);
}

/**
 * Takes a new preview file. A replaced document scan is released here; an ID
 * sheet is not, because the server already retired its old token and a
 * release by token would delete the whole ID session.
 */
function adoptPreview(path: string, token: string): void {
  if (
    flow.copyType === 'document' &&
    previewReleaseToken &&
    previewReleaseToken !== token
  ) {
    void releaseCopyPreviewFile(previewReleaseToken, 'copy_preview_replaced');
  }
  previewPath = path;
  previewReleaseToken = token;
  previewRendered = false;
}

function startOver(): void {
  if (flow.scanning !== null || composing) return;
  releaseCurrentPreview('copy_start_over');
  previewRequestId += 1;
  previewPath = null;
  previewReleaseToken = null;
  idSessionId = null;
  documentLayout = null;
  previewRendered = false;
  retryAction = null;
  hideError();
  dispatch({ type: 'start-over' });
}

function resetAfterExpiry(message: string): void {
  previewRequestId += 1;
  previewPath = null;
  previewReleaseToken = null;
  idSessionId = null;
  previewRendered = false;
  flow = createCopyFlowState('id');
  retryAction = () => scanIdSide('front');
  persist();
  showError(message, false, ID_SESSION_EXPIRED_CODE);
}

// ── Scans ───────────────────────────────────────────────────────────────────

async function checkForDocument(): Promise<void> {
  if (!beginScan('document')) return;
  retryAction = checkForDocument;

  try {
    const res = await fetchWithTimeout(
      '/api/scan/preview',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paperSize: documentSize }),
      },
      COPY_PREVIEW_REQUEST_TIMEOUT_MS,
      'Document check',
    );
    const data = (await res.json()) as {
      detected?: boolean;
      previewPath?: string;
      releaseToken?: string;
      code?: string;
      error?: string;
    };
    endScan();

    if (data.detected && data.previewPath && data.releaseToken) {
      adoptPreview(data.previewPath, data.releaseToken);
      documentLayout = null;
      retryAction = null;
      dispatch({ type: 'document-scanned' });
      await showPreview(data.previewPath);
      return;
    }

    dispatch({ type: 'scan-failed' });
    const usesAdf =
      documentSize === 'Long' || /adf|feeder/i.test(data.error ?? '');
    // No "No document detected" default: a response without an error text
    // is a server-side failure, not an empty scanner.
    showError(
      data.error ?? 'Could not complete scanner check. Please try again.',
      usesAdf,
      data.code ?? (data.error ? undefined : 'SCAN_FAILED'),
    );
  } catch (error) {
    endScan();
    dispatch({ type: 'scan-failed' });
    const timedOut =
      error instanceof Error && error.message.includes('timed out');
    showError(
      timedOut
        ? error.message
        : 'Could not reach the scanner. Please try again.',
      documentSize === 'Long',
      timedOut ? 'SCANNER_TIMEOUT' : 'SCANNER_OFFLINE',
    );
  }
}

function handleIdFailure(
  result: Exclude<IdCaptureResult, { kind: 'sheet' }>,
): void {
  if (result.kind === 'expired') {
    resetAfterExpiry(result.error);
    return;
  }
  if (result.kind === 'scan-failed' && result.sessionId) {
    idSessionId = result.sessionId;
    persist();
  }
  showError(result.error, false, result.code);
}

async function scanIdSide(side: IdSide): Promise<void> {
  if (!beginScan(side)) return;
  retryAction = () => scanIdSide(side);

  const result = await idCapture.scanSide({
    sessionId: idSessionId,
    side,
    paperSize: settings.paperSize,
  });
  endScan();

  if (result.kind === 'sheet') {
    idSessionId = result.sheet.sessionId;
    adoptPreview(result.sheet.previewPath, result.sheet.releaseToken);
    retryAction = null;
    dispatch({ type: 'side-scanned', side, warnings: result.sheet.warnings });
    await showPreview(result.sheet.previewPath);
    return;
  }

  dispatch({ type: 'scan-failed' });
  handleIdFailure(result);
}

/** Rebuilds the ID sheet for the current paper size and rotations. */
async function recompose(): Promise<void> {
  if (!idSessionId || composing || flow.scanning !== null) return;
  retryAction = async () => {
    hideError();
    await recompose();
  };
  composing = true;
  render();

  const result = await idCapture.compose({
    sessionId: idSessionId,
    paperSize: settings.paperSize,
    rotations: flow.rotations,
  });
  composing = false;

  if (result.kind === 'sheet') {
    adoptPreview(result.sheet.previewPath, result.sheet.releaseToken);
    retryAction = null;
    persist();
    await showPreview(result.sheet.previewPath);
    return;
  }
  if (result.kind === 'expired') {
    resetAfterExpiry(result.error);
    return;
  }
  showError(result.error, false, result.code);
}

function rotateSide(side: IdSide): void {
  if (composing) return;
  const before = flow;
  dispatch({ type: 'side-rotated', side });
  if (flow !== before) void recompose();
}

async function retryLastScan(): Promise<void> {
  if (retryAction) {
    await retryAction();
    return;
  }
  hideError();
  render();
  if (previewPath && !previewRendered) {
    await showPreview(previewPath);
    return;
  }
  if (flow.stage !== 'capture') return;
  if (flow.copyType === 'document') {
    await checkForDocument();
    return;
  }
  const side = nextIdScanTarget(flow);
  if (side) await scanIdSide(side);
}

// ── Events ──────────────────────────────────────────────────────────────────

for (const radio of copyTypeRadios) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    dispatch({
      type: 'copy-type-selected',
      copyType: radio.value === 'id' ? 'id' : 'document',
    });
  });
}

for (const radio of documentSizeRadios) {
  radio.addEventListener('change', () => {
    const size = parsePaperSize(radio.value);
    if (!radio.checked || !size || isCopyTypeLocked(flow)) return;
    documentSize = size;
    persist();
    render();
  });
}

for (const radio of paperSizeRadios) {
  radio.addEventListener('change', () => {
    const size = parsePaperSize(radio.value);
    if (!radio.checked || !size || flow.copyType !== 'id') return;
    if (size === settings.paperSize) return;
    settings = { ...settings, paperSize: size };
    positionBackSlot();
    persist();
    void recompose();
  });
}

for (const radio of colorModeRadios) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    settings = {
      ...settings,
      colorMode: radio.value === 'grayscale' ? 'grayscale' : 'colored',
    };
    persist();
    render();
  });
}

for (const radio of qualityRadios) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    settings = {
      ...settings,
      quality: radio.value === 'high' ? 'high' : 'standard',
    };
    persist();
    render();
  });
}

copiesDec?.addEventListener('click', () => {
  settings = { ...settings, copies: stepCopies(settings.copies, -1) };
  persist();
  render();
});
copiesInc?.addEventListener('click', () => {
  settings = { ...settings, copies: stepCopies(settings.copies, 1) };
  persist();
  render();
});

checkDocBtn?.addEventListener('click', () => void checkForDocument());
scanSideBtn?.addEventListener('click', () => {
  const side = nextIdScanTarget(flow);
  if (side) void scanIdSide(side);
});
flipScanBackBtn?.addEventListener('click', () => void scanIdSide('back'));
flipRetakeFrontBtn?.addEventListener('click', () => void scanIdSide('front'));
startOverBtn?.addEventListener('click', startOver);
changeCopyTypeBtn?.addEventListener('click', startOver);
scanAgainBtn?.addEventListener('click', startOver);
retakeFrontBtn?.addEventListener('click', () => void scanIdSide('front'));
retakeBackBtn?.addEventListener('click', () => void scanIdSide('back'));
rotateFrontBtn?.addEventListener('click', () => rotateSide('front'));
rotateBackBtn?.addEventListener('click', () => rotateSide('back'));
retryBtn?.addEventListener('click', () => void retryLastScan());

warningDialog?.addEventListener('cancel', (event) => event.preventDefault());
warningKeepBtn?.addEventListener('click', () => {
  dispatch({ type: 'warning-kept' });
});
warningRetakeBtn?.addEventListener('click', () => {
  const side = flow.pendingWarnings[0]?.side;
  dispatch({ type: 'warning-retake' });
  if (side) void scanIdSide(side);
});

backBtn?.addEventListener('click', () => {
  if (backBtn.getAttribute('aria-disabled') === 'true') return;
  releaseCurrentPreview('copy_back_home');
  clearCopyStorage();
});

continueBtn?.addEventListener('click', () => {
  if (!canContinue(flow) || !previewPath || !previewRendered) return;
  if (errorShown || composing) return;
  const orientation: Orientation =
    flow.copyType === 'document'
      ? (documentLayout?.orientation ?? 'portrait')
      : 'portrait';
  const config = buildCopyConfig({
    previewPath,
    releaseToken: previewReleaseToken,
    paperSize: outputPaperSize(),
    orientation,
    colorMode: settings.colorMode,
    quality: settings.quality,
    copies: settings.copies,
  });
  persist();
  sessionStorage.setItem('printbit.mode', 'copy');
  sessionStorage.removeItem('printbit.sessionId');
  sessionStorage.removeItem('printbit.uploadedFile');
  sessionStorage.setItem('printbit.config', JSON.stringify(config));
  navigateWithKioskMotion('/confirm');
});

let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (previewPath && previewRendered) void showPreview(previewPath);
    else render();
  }, 150);
});

// ── Start ───────────────────────────────────────────────────────────────────

async function initializeCopyPage(): Promise<void> {
  setupCopySocket();

  void fetch('/api/printer/simulation-status')
    .then((res) => (res.ok ? res.json() : null))
    .then(
      (
        data: {
          activeError?: string | null;
          simulation?: { activeError?: string | null };
        } | null,
      ) => {
        const activeError = data?.activeError ?? data?.simulation?.activeError;
        if (activeError === 'adf_error') showError(ADF_ERROR_MESSAGE, true);
      },
    )
    .catch(() => {});

  documentSize =
    parsePaperSize(sessionStorage.getItem(STORAGE_KEYS.sourcePaperSize)) ??
    'A4';
  previewPath = sessionStorage.getItem(STORAGE_KEYS.previewPath);
  previewReleaseToken = sessionStorage.getItem(STORAGE_KEYS.releaseToken);
  idSessionId = sessionStorage.getItem(STORAGE_KEYS.idSession);
  const snapshot = parseSnapshot(sessionStorage.getItem(STORAGE_KEYS.flow));

  if (
    previewPath &&
    snapshot &&
    (snapshot.copyType === 'document' || idSessionId)
  ) {
    // Back from /confirm, or a reload: restore scans, rotations and settings.
    settings = parseCopySettings(sessionStorage.getItem(STORAGE_KEYS.settings));
    flow = reduceCopyFlow(flow, { type: 'restored', snapshot });
  } else if (previewPath && !snapshot) {
    // A preview saved by the page before this change: a document scan.
    flow = reduceCopyFlow(flow, { type: 'document-scanned' });
  } else {
    // Nothing usable. Settings never carry over to a new customer.
    releaseCurrentPreview('copy_restore_discarded');
    previewPath = null;
    previewReleaseToken = null;
    idSessionId = null;
  }

  positionBackSlot();
  persist();
  render();
  if (previewPath) await showPreview(previewPath);
}

void initializeCopyPage();
