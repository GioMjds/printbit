import { initializePageIdleTimeout } from '@/services/idle-timeout';
import { initKioskLocalization } from '../shared/kiosk-i18n';
import { navigateWithKioskMotion } from '../shared/kiosk-navigation';
import { mountLoadingAnimation } from '../shared/loading-animation';
import {
  destroyPdfLoadingTask,
  type PdfLoadingTask,
} from '../shared/pdfjs-loading-task-cleanup';
import { getScanTroubleshootingGuide } from './troubleshooting';

export {};

void initKioskLocalization();

// ── Idle Timeout with Warning Modal (Scan Page) ───────────────────────────────────────────────

void initializePageIdleTimeout({
  showWarningModal: true,
  onTimeout: () => {
    console.log('[PAGE IDLE] Scan page timeout reached, redirecting to home');
    if (scanReleaseToken) {
      void releaseScanFile(scanReleaseToken, 'scan_idle_timeout');
      scanReleaseToken = null;
    }
    // Cancel server-side session if exists
    const sessionId = sessionStorage.getItem('printbit.sessionId');
    const sessionToken = sessionStorage.getItem('printbit.sessionToken');
    if (sessionId && sessionToken) {
      void fetch(
        `/api/wireless/sessions/${encodeURIComponent(sessionId)}/cancel?token=${encodeURIComponent(sessionToken)}`,
        { method: 'DELETE' },
      ).catch(() => {});
    }
    // Clear state before redirect
    sessionStorage.removeItem('printbit.config');
    sessionStorage.removeItem('printbit.sessionId');
    sessionStorage.removeItem('printbit.sessionToken');
    navigateWithKioskMotion('/', 'replace');
  },
});

type ScanSource = 'feeder' | 'glass';
type ScanColor = 'color' | 'grayscale';
type ScanDpi = '150' | '300' | '600';
type ScanPaperSize = 'A4' | 'Letter' | 'Legal';
export type ScanExportFormat = 'pdf' | 'jpg' | 'png';

interface ScanResponse {
  pages: string[];
  filename?: string;
  releaseToken?: string;
}

interface PricingResponse {
  printPerPage: number;
  copyPerPage: number;
  scanDocument: number;
  colorSurcharge: number;
}

interface StoredScanConfig {
  mode?: string;
  scanFilename?: string;
  scanReleaseToken?: string | null;
  scannedPages?: string[];
  currentPage?: number;
  paperSize?: string;
  scanFormat?: ScanExportFormat;
}

type PdfjsLib = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (src: { data: ArrayBuffer }) => PdfLoadingTask & {
    promise: Promise<{
      numPages: number;
      getPage: (num: number) => Promise<{
        getViewport: (options: { scale: number }) => {
          width: number;
          height: number;
        };
        render: (options: {
          canvasContext: CanvasRenderingContext2D;
          viewport: { width: number; height: number };
        }) => { promise: Promise<void> };
      }>;
    }>;
  };
};

const previewHint = document.getElementById('previewHint') as HTMLElement;
const stateIdle = document.getElementById('stateIdle') as HTMLElement;
const stateScanning = document.getElementById('stateScanning') as HTMLElement;
const scanLoadingAnimation = document.getElementById(
  'scanLoadingAnimation',
) as HTMLElement | null;
const scanLoadingCanvas = document.getElementById(
  'scanLoadingCanvas',
) as HTMLCanvasElement | null;
const stateResult = document.getElementById('stateResult') as HTMLElement;
const stateError = document.getElementById('stateError') as HTMLElement;
const scanProgress = document.getElementById('scanProgress') as HTMLElement;
const errorText = document.getElementById('errorText') as HTMLElement;

const scannedImage = document.getElementById(
  'scannedImage',
) as HTMLImageElement;
const scannedPdfCanvas = document.getElementById(
  'scannedPdfCanvas',
) as HTMLCanvasElement | null;
const scannedResult = document.getElementById(
  'scannedResult',
) as HTMLElement | null;
const pageCountBadge = document.getElementById('pageCountBadge') as HTMLElement;
const pageCountText = document.getElementById('pageCountText') as HTMLElement;

const previewControls = document.getElementById(
  'previewControls',
) as HTMLElement;
const pagePrev = document.getElementById('pagePrev') as HTMLButtonElement;
const pageNext = document.getElementById('pageNext') as HTMLButtonElement;
const pagerLabel = document.getElementById('pagerLabel') as HTMLElement;

const scanBtn = document.getElementById('scanBtn') as HTMLButtonElement;
const scanBtnLabel = document.getElementById('scanBtnLabel') as HTMLElement;
const rescanBtn = document.getElementById('rescanBtn') as HTMLButtonElement;
const clearBtn = document.getElementById('clearBtn') as HTMLButtonElement | null;
const proceedBtn = document.getElementById('proceedBtn') as HTMLButtonElement;
const proceedBtnLabel = document.getElementById(
  'proceedBtnLabel',
) as HTMLElement;
const softCopyFeeText = document.getElementById(
  'softCopyFeeText',
) as HTMLElement;
const scanErrorNotice = document.getElementById(
  'scanErrorNotice',
) as HTMLElement | null;
const scanErrorNoticeTitle = document.getElementById(
  'scanErrorNoticeTitle',
) as HTMLElement | null;
const scanErrorNoticeSummary = document.getElementById(
  'scanErrorNoticeSummary',
) as HTMLElement | null;
const scanErrorNoticeChecks = document.getElementById(
  'scanErrorNoticeChecks',
) as HTMLUListElement | null;

const errorSubtext = stateError?.querySelector(
  '.preview-state__sub',
) as HTMLElement | null;

const backBtn = document.querySelector<HTMLAnchorElement>('a.back-btn');
const documentCareModal = document.getElementById('documentCareModal');
document.getElementById('documentCareBtn')?.addEventListener('click', () => { documentCareModal?.classList.add('is-open'); documentCareModal?.setAttribute('aria-hidden', 'false'); });
document.getElementById('documentCareClose')?.addEventListener('click', () => { documentCareModal?.classList.remove('is-open'); documentCareModal?.setAttribute('aria-hidden', 'true'); });
documentCareModal?.addEventListener('click', (event) => { if (event.target === documentCareModal) document.getElementById('documentCareClose')?.click(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') document.getElementById('documentCareClose')?.click(); });

const scanLoadingController =
  scanLoadingAnimation && scanLoadingCanvas
    ? mountLoadingAnimation({
        root: scanLoadingAnimation,
        canvas: scanLoadingCanvas,
        mode: 'scan',
      })
    : null;

window.addEventListener('pagehide', (event) => {
  if (!event.persisted) scanLoadingController?.destroy();
});

const PREVIEW_STATES: Record<
  'idle' | 'scanning' | 'result' | 'error',
  HTMLElement
> = {
  idle: stateIdle,
  scanning: stateScanning,
  result: stateResult,
  error: stateError,
};

let scannedPages: string[] = [];
let currentPage = 0;
let scanFilename: string | null = null;
let scanReleaseToken: string | null = null;
let scanDocumentPrice = 5;

const SCAN_SOURCE: ScanSource = 'feeder';
const SCAN_COLOR: ScanColor = 'color';
const SCAN_DPI: ScanDpi = '300';

const scanSourcePaperSizeRadios = document.querySelectorAll<HTMLInputElement>(
  'input[name="scanSourcePaperSize"]',
);

function getSelectedScanPaperSize(): ScanPaperSize {
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="scanSourcePaperSize"]:checked',
  );
  if (checked?.value === 'Letter' || checked?.value === 'Legal') {
    return checked.value;
  }
  return 'A4';
}

function setScanSourcePaperSize(paperSize: ScanPaperSize): void {
  for (const radio of scanSourcePaperSizeRadios) {
    radio.checked = radio.value === paperSize;
  }
}

function setScanSourceRadiosDisabled(disabled: boolean): void {
  for (const radio of scanSourcePaperSizeRadios) {
    radio.disabled = disabled;
  }
}

const scanExportFormatRadios = document.querySelectorAll<HTMLInputElement>(
  'input[name="scanExportFormat"]',
);

function getSelectedScanFormat(): ScanExportFormat {
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="scanExportFormat"]:checked',
  );
  if (checked?.value === 'jpg' || checked?.value === 'png') {
    return checked.value;
  }
  return 'pdf';
}

function setScanExportFormat(format: ScanExportFormat): void {
  for (const radio of scanExportFormatRadios) {
    radio.checked = radio.value === format;
  }
}

function setScanFormatRadiosDisabled(disabled: boolean): void {
  for (const radio of scanExportFormatRadios) {
    radio.disabled = disabled;
  }
}

let currentPdfLoadingTask: PdfLoadingTask | null = null;
let currentPdfDoc: {
  numPages: number;
  getPage: (num: number) => Promise<{
    getViewport: (options: { scale: number }) => {
      width: number;
      height: number;
    };
    render: (options: {
      canvasContext: CanvasRenderingContext2D;
      viewport: { width: number; height: number };
    }) => { promise: Promise<void> };
  }>;
} | null = null;
let pdfPageCount = 0;

async function loadAndDisplayPdf(previewUrl: string, targetPage = 0): Promise<void> {
  const dynImport = new Function('u', 'return import(u)') as (
    u: string,
  ) => Promise<Record<string, unknown>>;
  const mod = await dynImport('/libs/pdfjs/pdf.min.mjs');
  const pdfjs = (mod.default ?? mod) as PdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = `${window.location.origin}/libs/pdfjs/pdf.worker.min.mjs`;

  const res = await fetch(previewUrl);
  if (!res.ok) throw new Error('Could not fetch PDF preview');
  const buf = await res.arrayBuffer();

  if (currentPdfLoadingTask) {
    await destroyPdfLoadingTask(currentPdfLoadingTask);
    currentPdfLoadingTask = null;
  }

  const loadingTask = pdfjs.getDocument({ data: buf });
  currentPdfLoadingTask = loadingTask;
  currentPdfDoc = await loadingTask.promise;
  pdfPageCount = currentPdfDoc.numPages;

  await renderPdfPage(targetPage);
}

async function renderPdfPage(n: number): Promise<void> {
  if (!currentPdfDoc || !scannedPdfCanvas) return;
  n = Math.max(0, Math.min(pdfPageCount - 1, n));
  currentPage = n;

  const page = await currentPdfDoc.getPage(n + 1);
  const baseViewport = page.getViewport({ scale: 1 });

  const container = scannedResult || document.getElementById('scannedResult');
  const targetWidth = Math.max((container?.clientWidth ?? 480) - 16, 200);
  const targetHeight = Math.max((container?.clientHeight ?? 600) - 16, 260);

  const dpr = window.devicePixelRatio || 1;
  const scale = Math.min(
    targetWidth / baseViewport.width,
    targetHeight / baseViewport.height,
  ) * dpr;

  const viewport = page.getViewport({ scale: Math.max(scale, 0.5) });
  scannedPdfCanvas.width = Math.floor(viewport.width);
  scannedPdfCanvas.height = Math.floor(viewport.height);

  const ctx = scannedPdfCanvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, scannedPdfCanvas.width, scannedPdfCanvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
  }

  scannedImage.style.display = 'none';
  scannedPdfCanvas.style.display = 'block';

  pagerLabel.textContent = `${n + 1} / ${pdfPageCount}`;
  pagePrev.disabled = n <= 0;
  pageNext.disabled = n >= pdfPageCount - 1;
  pageCountText.textContent = `${pdfPageCount} page${pdfPageCount !== 1 ? 's' : ''}`;

  const multi = pdfPageCount > 1;
  previewControls.style.display = multi ? 'flex' : 'none';
  pageCountBadge.style.display = multi ? 'inline-flex' : 'none';

  saveScanStateToSession();
}

const RELEASE_TIMEOUT_MS = 1_500;

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

function hideScanTroubleshooting(): void {
  scanErrorNotice?.classList.add('hidden');
  if (scanErrorNoticeTitle) scanErrorNoticeTitle.textContent = '';
  if (scanErrorNoticeSummary) scanErrorNoticeSummary.textContent = '';
  replaceListItems(scanErrorNoticeChecks, []);
}

function showScanTroubleshooting(
  rawMessage: string,
  showInlineNotice: boolean,
): string {
  const guide = getScanTroubleshootingGuide(rawMessage);
  const userFriendlyTitle = guide.title;

  if (errorSubtext) {
    errorSubtext.textContent = guide.summary;
  }

  if (showInlineNotice) {
    if (scanErrorNoticeTitle) scanErrorNoticeTitle.textContent = userFriendlyTitle;
    if (scanErrorNoticeSummary) scanErrorNoticeSummary.textContent = guide.summary;
    replaceListItems(scanErrorNoticeChecks, guide.checks);
    scanErrorNotice?.classList.remove('hidden');
  }

  return userFriendlyTitle;
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

async function releaseScanFile(
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

function showPreview(
  name: 'idle' | 'scanning' | 'result' | 'error',
  hint?: string,
): void {
  scanLoadingController?.setActive(name === 'scanning');
  for (const [key, el] of Object.entries(PREVIEW_STATES)) {
    el.classList.toggle('hidden', key !== name);
  }
  if (hint !== undefined) previewHint.textContent = hint;
}

function goToPage(n: number): void {
  if (currentPdfDoc) {
    void renderPdfPage(n);
    return;
  }

  if (scannedPdfCanvas) scannedPdfCanvas.style.display = 'none';
  scannedImage.style.display = 'block';

  n = Math.max(0, Math.min(scannedPages.length - 1, n));
  currentPage = n;
  scannedImage.src = scannedPages[n];
  scannedImage.removeAttribute('data-gray');

  const total = scannedPages.length;
  pagerLabel.textContent = `${n + 1} / ${total}`;
  pagePrev.disabled = n <= 0;
  pageNext.disabled = n >= total - 1;
  pageCountText.textContent = `${total} page${total !== 1 ? 's' : ''}`;

  saveScanStateToSession();
}

function updatePager(): void {
  const multi = scannedPages.length > 1;
  previewControls.style.display = multi ? 'flex' : 'none';
  pageCountBadge.style.display = multi ? 'inline-flex' : 'none';
  if (scannedPages.length > 0) goToPage(currentPage);
}

function formatPeso(value: number): string {
  return `₱${value}`;
}

function updateSoftCopyPricingUi(): void {
  proceedBtnLabel.textContent = `Proceed to Pay (${formatPeso(scanDocumentPrice)})`;
  softCopyFeeText.textContent = `A soft copy fee of ${formatPeso(scanDocumentPrice)} applies. Pay on the next screen to get your download QR code.`;
}

async function loadPricing(): Promise<void> {
  try {
    const response = await fetch('/api/pricing');
    if (!response.ok) throw new Error('Failed to load pricing information.');

    const payload = (await response.json()) as Partial<PricingResponse>;
    if (
      typeof payload.scanDocument === 'number' &&
      Number.isFinite(payload.scanDocument)
    ) {
      scanDocumentPrice = payload.scanDocument;
    }
  } catch {
    scanDocumentPrice = 5;
  } finally {
    updateSoftCopyPricingUi();
  }
}

function saveScanStateToSession(
  paperSize: ScanPaperSize = getSelectedScanPaperSize(),
  scanFormat: ScanExportFormat = getSelectedScanFormat(),
): void {
  if (!scanFilename) return;
  sessionStorage.setItem(
    'printbit.config',
    JSON.stringify({
      mode: 'scan',
      scanFilename,
      scanReleaseToken,
      scannedPages,
      currentPage,
      sessionId: null,
      colorMode: 'colored',
      copies: 1,
      orientation: 'portrait',
      paperSize,
      scanFormat,
      rotationDeg: 0,
    }),
  );
}

async function restoreScanPreviewFromSession(): Promise<boolean> {
  const rawConfig = sessionStorage.getItem('printbit.config');
  if (!rawConfig) return false;

  let storedConfig: StoredScanConfig;
  try {
    storedConfig = JSON.parse(rawConfig) as StoredScanConfig;
  } catch {
    return false;
  }

  if (storedConfig.mode !== 'scan') return false;
  const restoredFilename =
    typeof storedConfig.scanFilename === 'string'
      ? storedConfig.scanFilename.trim()
      : '';
  if (!restoredFilename) return false;

  const previewUrl = `/api/scan/preview/${encodeURIComponent(restoredFilename)}`;

  try {
    const response = await fetch(previewUrl, { cache: 'no-store' });
    if (!response.ok) {
      if (response.status === 404) {
        sessionStorage.removeItem('printbit.config');
      }
      return false;
    }
  } catch {
    return false;
  }

  if (Array.isArray(storedConfig.scannedPages) && storedConfig.scannedPages.length > 0) {
    scannedPages = storedConfig.scannedPages;
  } else {
    scannedPages = [previewUrl];
  }

  scanFilename = restoredFilename;
  scanReleaseToken =
    typeof storedConfig.scanReleaseToken === 'string' &&
    storedConfig.scanReleaseToken.trim().length > 0
      ? storedConfig.scanReleaseToken.trim()
      : null;
  currentPage = typeof storedConfig.currentPage === 'number' ? storedConfig.currentPage : 0;
  currentPage = Math.max(0, Math.min(scannedPages.length - 1, currentPage));

  if (
    storedConfig.paperSize === 'A4' ||
    storedConfig.paperSize === 'Letter' ||
    storedConfig.paperSize === 'Legal'
  ) {
    setScanSourcePaperSize(storedConfig.paperSize);
  }
  setScanSourceRadiosDisabled(true);

  if (
    storedConfig.scanFormat === 'pdf' ||
    storedConfig.scanFormat === 'jpg' ||
    storedConfig.scanFormat === 'png'
  ) {
    setScanExportFormat(storedConfig.scanFormat);
  }
  setScanFormatRadiosDisabled(true);

  if (restoredFilename.toLowerCase().endsWith('.pdf')) {
    try {
      await loadAndDisplayPdf(previewUrl, currentPage);
      showPreview('result', 'Restored your scanned document preview.');
    } catch {
      showPreview('result', 'Restored your scanned document preview.');
    }
  } else {
    if (scannedPdfCanvas) scannedPdfCanvas.style.display = 'none';
    scannedImage.style.display = 'block';
    showPreview('result', 'Restored your scanned document preview.');
    updatePager();
  }
  hideScanTroubleshooting();
  updateSoftCopyPricingUi();
  if (clearBtn) clearBtn.style.display = 'flex';
  rescanBtn.style.display = 'flex';
  proceedBtn.style.display = 'flex';
  proceedBtn.disabled = false;
  proceedBtn.setAttribute('aria-disabled', 'false');
  scanBtn.disabled = false;
  scanBtn.setAttribute('aria-disabled', 'false');

  return true;
}

async function startScan(): Promise<void> {
  const paperSize = getSelectedScanPaperSize();
  const scanFormat = getSelectedScanFormat();
  const previousPages = scannedPages.slice();
  const previousPage = currentPage;
  const previousFilename = scanFilename;
  const previousReleaseToken = scanReleaseToken;
  const hasPreviousPreview =
    previousPages.length > 0 && Boolean(previousFilename);

  setBackNavigationLocked(true);
  setScanSourceRadiosDisabled(true);
  setScanFormatRadiosDisabled(true);
  hideScanTroubleshooting();
  showPreview('scanning', 'Scanning your document…');
  scanBtn.disabled = true;
  scanBtn.setAttribute('aria-disabled', 'true');
  rescanBtn.style.display = 'none';
  if (clearBtn) clearBtn.style.display = 'none';
  proceedBtn.style.display = 'none';
  scanProgress.textContent = 'Feeding document…';

  const progressMessages = [
    'Feeding document…',
    'Scanning page…',
    'Processing image',
    'Finalizing…',
  ];
  let progIdx = 0;
  const progTimer = window.setInterval(() => {
    progIdx = Math.min(progIdx + 1, progressMessages.length - 1);
    scanProgress.textContent = progressMessages[progIdx];
  }, 1200);

  try {
    const res = await fetch('/api/scanner/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: SCAN_SOURCE,
        color: SCAN_COLOR,
        dpi: SCAN_DPI,
        paperSize,
        format: scanFormat,
      }),
    });

    clearInterval(progTimer);

    const data = (await res.json()) as ScanResponse & { error?: string };
    if (!res.ok) {
      throw new Error(data.error ?? 'Scan failed');
    }

    if (
      !data.pages ||
      data.pages.length === 0 ||
      !data.filename ||
      !data.releaseToken
    ) {
      throw new Error('No pages returned from scanner');
    }

    scannedPages = data.pages;
    scanFilename = data.filename;
    scanReleaseToken = data.releaseToken;
    currentPage = 0;

    saveScanStateToSession(paperSize, scanFormat);

    if (previousReleaseToken && previousReleaseToken !== data.releaseToken) {
      void releaseScanFile(previousReleaseToken, 'scan_replaced_by_new_scan');
    }

    if (data.filename.toLowerCase().endsWith('.pdf')) {
      try {
        await loadAndDisplayPdf(data.pages[0], 0);
        showPreview('result', `Page 1 of ${pdfPageCount || 1}`);
      } catch (pdfErr) {
        console.warn('[SCAN] PDF preview render error:', pdfErr);
        showPreview('result', 'Scanned document ready');
      }
    } else {
      if (scannedPdfCanvas) scannedPdfCanvas.style.display = 'none';
      scannedImage.style.display = 'block';
      showPreview('result', `Page 1 of ${data.pages.length}`);
      updatePager();
    }
    updateSoftCopyPricingUi();

    if (clearBtn) clearBtn.style.display = 'flex';
    rescanBtn.style.display = 'flex';
    proceedBtn.style.display = 'flex';
    proceedBtn.disabled = false;
    proceedBtn.setAttribute('aria-disabled', 'false');
    scanBtnLabel.textContent = 'Scan Document';

    // ✨ FIX: This allows the rescan listener (!scanBtn.disabled) to fire successfully.
    scanBtn.disabled = false;
    scanBtn.setAttribute('aria-disabled', 'false');
  } catch (err) {
    clearInterval(progTimer);
    const rawMessage = err instanceof Error ? err.message : 'Scan failed';
    const userFriendlyTitle = showScanTroubleshooting(
      rawMessage,
      hasPreviousPreview,
    );

    if (hasPreviousPreview) {
      scannedPages = previousPages;
      scanFilename = previousFilename;
      scanReleaseToken = previousReleaseToken;
      currentPage = Math.max(
        0,
        Math.min(previousPage, previousPages.length - 1),
      );

      showPreview(
        'result',
        `Previous scan kept. New scan failed: ${userFriendlyTitle}`,
      );
      updatePager();
      updateSoftCopyPricingUi();
      if (clearBtn) clearBtn.style.display = 'flex';
      rescanBtn.style.display = 'flex';
      proceedBtn.style.display = 'flex';
      proceedBtn.disabled = false;
      proceedBtn.setAttribute('aria-disabled', 'false');
      scanBtn.disabled = false;
      scanBtn.setAttribute('aria-disabled', 'false');
      return;
    }

    setScanSourceRadiosDisabled(false);
    setScanFormatRadiosDisabled(false);
    errorText.textContent = userFriendlyTitle;
    showPreview('error', userFriendlyTitle);
    scanBtn.disabled = false;
    scanBtn.setAttribute('aria-disabled', 'false');
    rescanBtn.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'none';
  } finally {
    setBackNavigationLocked(false);
  }
}

pagePrev.addEventListener('click', () => goToPage(currentPage - 1));
pageNext.addEventListener('click', () => goToPage(currentPage + 1));

scanBtn.addEventListener('click', () => {
  if (!scanBtn.disabled) void startScan();
});

rescanBtn.addEventListener('click', () => {
  if (!scanBtn.disabled) void startScan();
});

function clearScan(): void {
  if (scanReleaseToken) {
    void releaseScanFile(scanReleaseToken, 'scan_clear');
    scanReleaseToken = null;
  }

  if (currentPdfLoadingTask) {
    void destroyPdfLoadingTask(currentPdfLoadingTask);
    currentPdfLoadingTask = null;
  }
  currentPdfDoc = null;
  pdfPageCount = 0;
  if (scannedPdfCanvas) scannedPdfCanvas.style.display = 'none';
  scannedImage.style.display = 'block';

  scannedPages = [];
  currentPage = 0;
  scanFilename = null;

  sessionStorage.removeItem('printbit.config');

  setScanSourceRadiosDisabled(false);
  setScanFormatRadiosDisabled(false);
  hideScanTroubleshooting();
  showPreview('idle', 'Insert document into the feeder and press Scan');
  previewControls.style.display = 'none';
  pageCountBadge.style.display = 'none';
  scannedImage.src = '';
  scannedImage.removeAttribute('data-gray');
  if (clearBtn) clearBtn.style.display = 'none';
  rescanBtn.style.display = 'none';
  proceedBtn.style.display = 'none';
  proceedBtn.disabled = true;
  proceedBtn.setAttribute('aria-disabled', 'true');
  scanBtnLabel.textContent = 'Scan Document';
  scanBtn.disabled = false;
  scanBtn.setAttribute('aria-disabled', 'false');
}

clearBtn?.addEventListener('click', () => {
  if (!scanBtn.disabled) clearScan();
});

proceedBtn.addEventListener('click', () => {
  if (!scannedPages.length || !scanFilename) return;

  saveScanStateToSession();
  sessionStorage.setItem('printbit.mode', 'scan');
  navigateWithKioskMotion('/confirm');
});

async function initializeScanPage(): Promise<void> {
  await loadPricing();
  const restored = await restoreScanPreviewFromSession();
  if (restored) return;

  hideScanTroubleshooting();
  showPreview('idle', 'Insert document into the feeder and press Scan');
  scanBtn.disabled = false;
  scanBtn.setAttribute('aria-disabled', 'false');
}

void initializeScanPage();
