import { initializePageIdleTimeout } from '@/services/idle-timeout';
import {
  calculatePrintLayout,
  DEFAULT_PRINT_SCALING,
  PAPER_POINTS,
  type PrintScaling,
  type PaperSize,
  type Orientation,
} from '../../shared/print-configuration';
import { initKioskLocalization } from '../shared/kiosk-i18n';
import { navigateWithKioskMotion } from '../shared/kiosk-navigation';
import { createConfigPreparationLoadingController } from './loading-state';
import { shouldPreparePreviewInBackground } from './office-preview';
import { getPreviewRequestTimeoutMs } from './preview-timeout';
import {
  fetchPublicPricing,
  formatPricingGuide,
} from '../shared/pricing-guide';
import {
  destroyPdfLoadingTask,
  type PdfLoadingTask,
} from '../shared/pdfjs-loading-task-cleanup';
import {
  formatLargePrintDisclaimer,
  isLargePrintDocument,
} from '../shared/large-print-warning';
import { buildColorDetectionEvidence } from './detection-evidence';
import {
  detectOrientationFromDimensions,
  detectPaperSizeFromDimensions,
} from './geometry-detection';

export {};

void initKioskLocalization();

void initializePageIdleTimeout({
  showWarningModal: true,
  onTimeout: async () => {
    console.log('[PAGE IDLE] Config page timeout reached, redirecting to home');
    const sessionId = sessionStorage.getItem('printbit.sessionId');
    const sessionToken = sessionStorage.getItem('printbit.sessionToken');
    if (sessionId && sessionToken) {
      try {
        await fetch(
          `/api/wireless/sessions/${encodeURIComponent(sessionId)}/cancel?token=${encodeURIComponent(sessionToken)}`,
          {
            method: 'DELETE',
          },
        );
      } catch {
        // Best-effort cleanup
      }
    }
    // Clear state before redirect
    sessionStorage.removeItem('printbit.config');
    sessionStorage.removeItem('printbit.mode');
    sessionStorage.removeItem('printbit.sessionId');
    sessionStorage.removeItem('printbit.sessionToken');
    sessionStorage.removeItem('printbit.uploadedFile');
    sessionStorage.removeItem('printbit.uploadedDocumentId');
    sessionStorage.removeItem('printbit.uploadedFiles');
    sessionStorage.removeItem('printbit.copyPreviewPath');
    sessionStorage.removeItem('printbit.copyPreviewReleaseToken');
    navigateWithKioskMotion('/', 'replace');
  },
});
type ColorMode = 'colored' | 'grayscale';
type PrintQuality = 'standard' | 'high';
type RotationDeg = 0 | 90 | 180 | 270;
type WorkflowMode = 'print' | 'copy' | 'scan';

const HTML_PREVIEW_LOAD_TIMEOUT_MS = 20_000;

type PageRangeSelection =
  | { type: 'all' }
  | { type: 'custom'; range: string }
  | { type: 'single'; page: number };

interface PrintConfig {
  scaling: PrintScaling;
  mode: 'print' | 'copy' | 'scan';
  sessionId: string | null;
  documentId: string | null;
  filename: string | null;
  scanFilename?: string | null;
  scanReleaseToken?: string | null;
  copyPreviewPath?: string | null;
  copyPreviewReleaseToken?: string | null;
  detectedColorMode?: ColorMode | null;
  colorMode: ColorMode;
  quality: PrintQuality;
  duplex: boolean;
  copies: number;
  orientation: Orientation;
  rotationDeg: RotationDeg;
  paperSize: PaperSize;
  pageRange: PageRangeSelection;
  totalPages: number;
  quote?: PrintQuote;
}

interface PrintQuote {
  requiredAmount: number;
  copies: number;
  duplex: boolean;
  pageRange: string | null;
  totalPages: number;
  selectedPages: number;
  selectedColorPages: number;
  selectedBwPages: number;
  billableColorPages: number;
  billableBwPages: number;
  requestedColorMode: ColorMode;
  effectiveColorMode: ColorMode;
  quality: PrintQuality;
  pricing: {
    printPerPage: number;
    colorSurcharge: number;
    highQualitySurcharge: number;
  };
  analysisConfidence: 'high' | 'medium' | 'low';
  billingPageDetection:
    | 'high-confidence-page-detection'
    | 'fallback-assumptions';
  analysisFallbackReasonFlags: string[];
}

interface PreviewConfig {
  scaling: PrintScaling;
  colorMode: ColorMode;
  orientation: Orientation;
  paperSize: PaperSize;
  rotationDeg: RotationDeg;
}

interface QuoteRequestBody {
  copies: number;
  colorMode: ColorMode;
  quality: PrintQuality;
  orientation: Orientation;
  rotationDeg: RotationDeg;
  paperSize: PaperSize;
  pageRange: PageRangeSelection;
  duplex: boolean;
  sessionId?: string;
  documentId?: string;
  isCopyJob?: true;
  copyPreviewPath?: string | null;
}

interface StoredConfigSeed {
  mode?: 'print' | 'copy' | 'scan';
  scanFilename?: string | null;
  scanReleaseToken?: string | null;
  orientation?: Orientation;
  rotationDeg?: number;
  quality?: PrintQuality;
  paperSize?: PaperSize;
}

// PDF.js types (loaded dynamically from /libs/pdfjs)
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

/** Return [widthPx, heightPx] of the paper sheet at 96 dpi,
 *  capped so the preview column (≤ 100%) never overflows.
 *  Portrait = narrow side first; Landscape = tall side first. */
function paperPx(size: PaperSize, orientation: Orientation): [number, number] {
  let [width, height] = PAPER_POINTS[size];
  if (orientation === 'landscape') [width, height] = [height, width];
  return [(width * 96) / 72, (height * 96) / 72];
}

function normalizeRotationDeg(value: unknown): RotationDeg | null {
  if (value === 0 || value === 90 || value === 180 || value === 270) {
    return value;
  }
  return null;
}

function parseWorkflowMode(
  value: string | null | undefined,
): WorkflowMode | null {
  if (value === 'print' || value === 'copy' || value === 'scan') {
    return value;
  }
  return null;
}

function previewLog(message: string, meta?: unknown): void {
  if (meta !== undefined) {
    console.log(`[CONFIG PREVIEW] ${message}`, meta);
    return;
  }
  console.log(`[CONFIG PREVIEW] ${message}`);
}

// ── Settings / Pricing Debug Logger ─────────────────────────────────────────
// Logs per-job pricing decisions for local debugging.

function settingsLog(message: string, meta?: unknown): void {
  if (meta !== undefined) {
    console.log(
      `%c[PRICING SETTINGS] ${message}`,
      'color:#a78bfa;font-weight:600',
      meta,
    );
    return;
  }
  console.log(
    `%c[PRICING SETTINGS] ${message}`,
    'color:#a78bfa;font-weight:600',
  );
}

function logQuoteBreakdown(quote: PrintQuote): void {
  console.groupCollapsed(
    `%c[PRICING SETTINGS] Quote resolved — ₱${quote.requiredAmount} payable`,
    'color:#a78bfa;font-weight:600',
  );
  settingsLog('effectiveColorMode', quote.effectiveColorMode);
  settingsLog('requestedColorMode', quote.requestedColorMode);
  settingsLog('selectedPages', quote.selectedPages);
  settingsLog('selectedColorPages', quote.selectedColorPages);
  settingsLog('selectedBwPages', quote.selectedBwPages);
  settingsLog('billableColorPages', quote.billableColorPages);
  settingsLog('billableBwPages', quote.billableBwPages);
  settingsLog('analysisConfidence', quote.analysisConfidence);
  settingsLog('billingPageDetection', quote.billingPageDetection);
  settingsLog('analysisFallbackReasonFlags', quote.analysisFallbackReasonFlags);
  console.groupEnd();
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

// Update Page Range when Preview navigates
function onPreviewPageChange(pageNum: number): void {
  if (pageModeSingle?.checked) {
    if (singlePageInput) {
      singlePageInput.value = String(pageNum);
      clampSinglePage();
      updateSummary();
      schedulePrintQuoteRefresh();
    }
  }
}

// Sync Preview when Range Mode changes
function syncPreviewPageWithRange(): void {
  if (pageModeSingle?.checked && singlePageInput) {
    const page = parseInt(singlePageInput.value, 10);
    if (!isNaN(page)) {
      void preview.goToPage(page);
    }
  }
}

class PrintPreview {
  private printConfig: PreviewConfig = {
    paperSize: 'A4',
    orientation: 'portrait',
    scaling: DEFAULT_PRINT_SCALING,
    rotationDeg: 0,
    colorMode: 'colored',
  };
  private viewport: HTMLElement;
  private sheet: HTMLElement;
  private canvas: HTMLCanvasElement;
  private imgStage: HTMLElement;
  private img: HTMLImageElement;
  private iframe: HTMLIFrameElement;
  private placeholder: HTMLElement;
  private loading: HTMLElement;
  private controls: HTMLElement;
  private hintEl: HTMLElement;
  private pagerLabel: HTMLElement;
  private pagePrev: HTMLButtonElement;
  private pageNext: HTMLButtonElement;

  private naturalW = 794; // natural paper width in px (A4 portrait @ 96dpi)
  private naturalH = 1123; // natural paper height in px

  private zoomScale = 1.0;
  private readonly ZOOM_MIN = 0.5;
  private readonly ZOOM_MAX = 3.0;
  private readonly ZOOM_STEP = 0.25;

  private pdfDoc: PDFDocumentProxy | null = null;
  private pdfLoadingTask: PdfLoadingTask | null = null;
  private currentPage = 1;
  private totalPages = 1;
  private latestImageInfo: {
    naturalWidth: number;
    naturalHeight: number;
  } | null = null;

  get pageCount(): number {
    return this.totalPages;
  }

  get currentPageNumber(): number {
    return this.currentPage;
  }

  get imageInfo(): { naturalWidth: number; naturalHeight: number } | null {
    return this.latestImageInfo;
  }

  async getNaturalDimensions(): Promise<{
    width: number;
    height: number;
  } | null> {
    if (this.pdfDoc) {
      try {
        const page = await this.pdfDoc.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        return { width: vp.width, height: vp.height };
      } catch {
        return null;
      }
    }
    if (this.latestImageInfo) {
      return {
        width: this.latestImageInfo.naturalWidth,
        height: this.latestImageInfo.naturalHeight,
      };
    }
    return null;
  }

  async getNaturalOrientation(): Promise<Orientation | null> {
    const dims = await this.getNaturalDimensions();
    if (!dims) return null;
    return detectOrientationFromDimensions(dims.width, dims.height);
  }

  async getDetectedPaperSize(): Promise<PaperSize | null> {
    if (!this.pdfDoc) return null;
    const dims = await this.getNaturalDimensions();
    if (!dims) return null;
    return detectPaperSizeFromDimensions(dims.width, dims.height);
  }

  private renderTask: Promise<void> | null = null;
  private pendingRenderPage: number | null = null;
  private resizeObserver: ResizeObserver;

  constructor() {
    this.viewport = document.getElementById('paperViewport')! as HTMLElement;
    this.sheet = document.getElementById('paperSheet')! as HTMLElement;
    this.canvas = document.getElementById(
      'previewCanvas',
    )! as HTMLCanvasElement;
    this.imgStage = document.getElementById('previewImgStage')! as HTMLElement;
    this.img = document.getElementById('previewImg')! as HTMLImageElement;
    this.iframe = document.getElementById('previewFrame')! as HTMLIFrameElement;
    this.placeholder = document.getElementById(
      'paperPlaceholder',
    )! as HTMLElement;
    this.loading = document.getElementById('paperLoading')! as HTMLElement;
    this.controls = document.getElementById('previewControls')! as HTMLElement;
    this.hintEl = document.getElementById('previewHint')! as HTMLElement;
    this.pagerLabel = document.getElementById('pagerLabel')! as HTMLElement;
    this.pagePrev = document.getElementById('pagePrev')! as HTMLButtonElement;
    this.pageNext = document.getElementById('pageNext')! as HTMLButtonElement;

    this.pagePrev.addEventListener('click', () =>
      this.goToPage(this.currentPage - 1),
    );
    this.pageNext.addEventListener('click', () =>
      this.goToPage(this.currentPage + 1),
    );

    const zoomInBtn = document.getElementById(
      'zoomIn',
    ) as HTMLButtonElement | null;
    const zoomOutBtn = document.getElementById(
      'zoomOut',
    ) as HTMLButtonElement | null;
    const zoomResetBtn = document.getElementById(
      'zoomReset',
    ) as HTMLButtonElement | null;
    zoomInBtn?.addEventListener('click', () => this.zoomIn());
    zoomOutBtn?.addEventListener('click', () => this.zoomOut());
    zoomResetBtn?.addEventListener('click', () => this.zoomReset());

    // Observe viewport resize → refit sheet, re-render PDF / recalc HTML pages
    this.resizeObserver = new ResizeObserver(() => {
      this.resizeSheet();
      if (this.pdfDoc) void this.renderPage(this.currentPage);
      else if (this.latestImageInfo) this.layoutImage();
      else if (this.iframe.style.display !== 'none') this.recalcHtmlPages();
    });
    this.resizeObserver.observe(this.viewport);
  }

  /** Scale the paper sheet to fill the viewport while keeping aspect ratio. */
  private resizeSheet(): void {
    const pad = 40;
    const vpW = this.viewport.clientWidth - pad;
    const vpH = this.viewport.clientHeight - pad;
    if (vpW <= 0 || vpH <= 0) return;
    const fitScale = Math.min(vpW / this.naturalW, vpH / this.naturalH);
    const finalScale = fitScale * this.zoomScale;
    // Preserve fractional CSS pixels so the visual paper boundary and the
    // PDF.js canvas share the same geometry at every zoom level.
    this.sheet.style.width = `${this.naturalW * finalScale}px`;
    this.sheet.style.height = `${this.naturalH * finalScale}px`;
    if (this.latestImageInfo) this.layoutImage();
  }

  applyConfig(cfg: PreviewConfig): void {
    this.printConfig = cfg;
    const [w, h] = paperPx(cfg.paperSize, cfg.orientation);
    const rotationScale =
      cfg.rotationDeg === 90 || cfg.rotationDeg === 270
        ? Math.min(w / h, h / w)
        : 1;

    // Store natural paper dimensions for resizeSheet()
    this.naturalW = w;
    this.naturalH = h;
    this.resizeSheet();
    this.sheet.style.setProperty('--preview-rotation', `${cfg.rotationDeg}deg`);
    this.sheet.style.setProperty(
      '--preview-rotation-scale',
      rotationScale.toFixed(4),
    );

    // Grayscale filter via data attribute → CSS handles the transition
    if (cfg.colorMode === 'grayscale') {
      this.sheet.setAttribute('data-gray', '');
    } else {
      this.sheet.removeAttribute('data-gray');
    }

    if (this.pdfDoc) {
      void this.renderPage(this.currentPage);
    } else if (this.latestImageInfo) {
      this.layoutImage();
    } else if (this.iframe.style.display !== 'none') {
      this.recalcHtmlPages();
    }
  }

  async load(sessionId: string, filename?: string): Promise<void> {
    this.iframe.onload = null; // clear any stale iframe load handler
    this.controls.style.display = 'none';
    this.showLoading(true);
    this.showCanvas(false);
    this.showImg(false);
    this.showFrame(false);
    this.setHint('Loading preview…');
    this.latestImageInfo = null;

    const previewParams = new URLSearchParams();
    if (filename) previewParams.set('filename', filename);
    if (sessionToken) previewParams.set('token', sessionToken);
    const previewQuery = previewParams.toString();
    let url = `/api/wireless/sessions/${encodeURIComponent(sessionId)}/preview`;
    if (previewQuery) url += `?${previewQuery}`;
    previewLog('load() start', { sessionId, filename: filename ?? null, url });

    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        getPreviewRequestTimeoutMs(filename),
      );
      previewLog('preview response received', {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get('Content-Type') ?? '',
      });
    } catch (error) {
      previewLog('preview fetch failed', error);
      const isAbortError =
        error instanceof DOMException && error.name === 'AbortError';
      this.showError(
        isAbortError
          ? 'Preview request timed out. Please retry.'
          : 'Network error — could not reach the server.',
      );
      return;
    }

    if (!response.ok) {
      let reason = 'Preview unavailable.';
      try {
        const body = (await response.json()) as {
          error?: string;
          code?: string;
        };
        if (body.code === 'UNSUPPORTED_PREVIEW')
          reason = `No preview for this file type.`;
        else if (body.code === 'PREVIEW_CONVERSION_FAILED')
          reason =
            'Conversion failed — ensure the PrintBit Worker and LibreOffice are installed on this machine.';
        else if (body.error) reason = body.error;
      } catch {
        /* plain text response */
      }
      this.showError(reason);
      return;
    }

    const contentType = response.headers.get('Content-Type') ?? '';
    previewLog('routing by content type', { contentType });

    if (contentType.startsWith('image/')) {
      // Convert response to blob URL to avoid double-fetch
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      previewLog('image blob created', {
        size: blob.size,
        type: blob.type,
      });
      await this.loadImage(blobUrl, true);
    } else if (contentType.includes('application/pdf')) {
      this.latestImageInfo = null;
      const buf = await response.arrayBuffer();
      previewLog('pdf buffer loaded', { bytes: buf.byteLength });
      await this.loadPdf(buf);
    } else if (contentType.includes('text/html')) {
      this.latestImageInfo = null;
      const html = await response.text();
      previewLog('html preview loaded', { chars: html.length });
      await this.loadHtml(html);
    } else {
      previewLog('unsupported preview content type', { contentType });
      this.latestImageInfo = null;
      this.showError('Unsupported preview format.');
    }
  }

  private async loadPdf(buf: ArrayBuffer): Promise<void> {
    previewLog('loadPdf() start', { bytes: buf.byteLength });
    if (this.pdfLoadingTask) {
      await destroyPdfLoadingTask(this.pdfLoadingTask);
      this.pdfLoadingTask = null;
      this.pdfDoc = null;
    }

    let pdfjs: PdfjsLib;
    try {
      const dynImport = new Function('u', 'return import(u)') as (
        u: string,
      ) => Promise<Record<string, unknown>>;
      const mod = await dynImport('/libs/pdfjs/pdf.min.mjs');
      pdfjs = (mod.default ?? mod) as PdfjsLib;
      pdfjs.GlobalWorkerOptions.workerSrc = `${window.location.origin}/libs/pdfjs/pdf.worker.min.mjs`;
    } catch (e) {
      console.error('PDF.js load error:', e);
      this.showError('PDF renderer not loaded.');
      return;
    }

    try {
      const loadingTask = pdfjs.getDocument({ data: buf });
      this.pdfLoadingTask = loadingTask;
      this.pdfDoc = await loadingTask.promise;
      this.totalPages = this.pdfDoc.numPages;
      this.currentPage = 1;
      this.updatePager();
      await this.renderPage(1);
    } catch (e) {
      await destroyPdfLoadingTask(this.pdfLoadingTask);
      this.pdfLoadingTask = null;
      this.pdfDoc = null;
      console.error('PDF load error:', e);
      previewLog('loadPdf() failed', e);
      this.showError('Could not parse PDF.');
    }
  }

  private async renderPage(pageNum: number): Promise<void> {
    if (!this.pdfDoc) return;

    // PDF.js cannot safely paint two pages into the same canvas at once. Keep
    // one latest request queued, rather than dropping it while a zoom/resize
    // render is in flight and leaving the canvas sized for the old sheet.
    if (this.renderTask) {
      this.pendingRenderPage = pageNum;
      return;
    }

    this.showLoading(true);

    const renderNow = async () => {
      try {
        const config = this.printConfig;
        const page = await this.pdfDoc!.getPage(pageNum);
        const sheetBounds = this.sheet.getBoundingClientRect();
        const sheetW = sheetBounds.width || 595;
        const sheetH = sheetBounds.height || 842;
        const baseVP = page.getViewport({ scale: 1 });

        // Fit the rotated source once inside the same target inset used by C#.
        const layout = calculatePrintLayout(
          baseVP.width,
          baseVP.height,
          config,
        );
        const dpr = window.devicePixelRatio || 1;
        const pixelsPerPoint = (sheetW / layout.width) * dpr;
        const scale = layout.scale * pixelsPerPoint;
        const viewport = page.getViewport({ scale });
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = Math.max(1, Math.ceil(viewport.width));
        sourceCanvas.height = Math.max(1, Math.ceil(viewport.height));
        await page.render({
          canvasContext: sourceCanvas.getContext('2d')!,
          viewport,
        }).promise;
        this.canvas.width = Math.max(1, Math.ceil(sheetW * dpr));
        this.canvas.height = Math.max(1, Math.ceil(sheetH * dpr));
        const ctx = this.canvas.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.save();
        ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
        ctx.rotate((config.rotationDeg * Math.PI) / 180);
        ctx.drawImage(
          sourceCanvas,
          -viewport.width / 2,
          -viewport.height / 2,
          viewport.width,
          viewport.height,
        );
        ctx.restore();

        this.showCanvas(true);
        this.showImg(false);
        this.showLoading(false);
        this.setHint(`Page ${pageNum} of ${this.totalPages}`);
      } catch (e) {
        console.error('Render error:', e);
        previewLog('renderPage() failed', e);
        this.showError('Render failed.');
      } finally {
        this.renderTask = null;
        const pendingPage = this.pendingRenderPage;
        this.pendingRenderPage = null;
        if (pendingPage !== null) void this.renderPage(pendingPage);
      }
    };

    this.renderTask = renderNow();
    await this.renderTask;
  }

  private layoutImage(): void {
    if (!this.latestImageInfo) return;
    const { naturalWidth, naturalHeight } = this.latestImageInfo;
    const layout = calculatePrintLayout(
      naturalWidth,
      naturalHeight,
      this.printConfig,
    );
    const pixelsPerPoint =
      this.sheet.getBoundingClientRect().width / layout.width;
    this.img.style.width = `${naturalWidth * layout.scale * pixelsPerPoint}px`;
    this.img.style.height = `${naturalHeight * layout.scale * pixelsPerPoint}px`;
    this.img.style.transform = `translate(-50%, -50%) rotate(${this.printConfig.rotationDeg}deg)`;
  }

  private async loadImage(url: string, isBlobUrl = false): Promise<void> {
    previewLog('loadImage() start', { isBlobUrl });
    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        previewLog('loadImage() timeout');
        this.latestImageInfo = null;
        this.showError('Image preview timed out. Please retry.');
        if (isBlobUrl) URL.revokeObjectURL(url);
        resolve();
      }, 15_000);

      this.img.onload = () => {
        window.clearTimeout(timeoutId);
        this.latestImageInfo = {
          naturalWidth: this.img.naturalWidth,
          naturalHeight: this.img.naturalHeight,
        };
        previewLog('loadImage() onload', {
          naturalWidth: this.img.naturalWidth,
          naturalHeight: this.img.naturalHeight,
        });
        this.totalPages = 1;
        this.currentPage = 1;
        this.updatePager();
        this.showImg(true);
        this.layoutImage();
        this.showLoading(false);
        this.setHint('Image preview');
        // Revoke blob URL after image loads to free memory
        if (isBlobUrl) URL.revokeObjectURL(url);

        resolve();
      };
      this.img.onerror = () => {
        window.clearTimeout(timeoutId);
        this.latestImageInfo = null;
        previewLog('loadImage() onerror');
        this.showError('Could not load image.');
        if (isBlobUrl) URL.revokeObjectURL(url);
        resolve();
      };
      this.img.src = url;
      this.img.style.display = 'block';
    });
  }

  async goToPage(n: number): Promise<void> {
    n = Math.max(1, Math.min(this.totalPages, n));
    if (n === this.currentPage) return;
    this.currentPage = n;
    this.updatePager();

    // Notify the app of the page change
    onPreviewPageChange(n);

    if (this.pdfDoc) {
      await this.renderPage(n);
    } else if (this.iframe.style.display !== 'none') {
      const viewH = this.iframe.clientHeight || 1;
      this.iframe.contentWindow?.scrollTo(0, (n - 1) * viewH);
    }
  }

  private updatePager(): void {
    const multi = this.totalPages > 1;
    this.controls.style.display = multi ? 'flex' : 'none';
    this.pagePrev.hidden = !multi;
    this.pageNext.hidden = !multi;
    this.pagerLabel.hidden = !multi;
    this.pagerLabel.textContent = `${this.currentPage} / ${this.totalPages}`;
    this.pagePrev.disabled = this.currentPage <= 1;
    this.pageNext.disabled = this.currentPage >= this.totalPages;
  }

  private loadHtml(html: string): Promise<void> {
    previewLog('loadHtml() start');
    // Show frame first so its dimensions are available when onload fires
    this.showCanvas(false);
    this.showImg(false);
    this.showFrame(true);
    this.showLoading(true);
    return new Promise((resolve) => {
      let settled = false;
      const complete = (loaded: boolean): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        this.iframe.onload = null;
        this.iframe.onerror = null;

        if (loaded) {
          previewLog('loadHtml() onload');
          this.recalcHtmlPages();
          this.showLoading(false);
          this.setHint('Document preview');
        } else {
          previewLog('loadHtml() failed');
          this.showError('Could not load HTML preview.');
        }
        resolve();
      };

      const timeoutId = window.setTimeout(
        () => complete(false),
        HTML_PREVIEW_LOAD_TIMEOUT_MS,
      );
      this.iframe.onload = () => complete(true);
      this.iframe.onerror = () => complete(false);
      this.iframe.srcdoc = html;
    });
  }

  private recalcHtmlPages(): void {
    const docEl = this.iframe.contentDocument?.documentElement;
    if (!docEl) return;
    const viewH = this.iframe.clientHeight || 1;
    this.totalPages = Math.max(1, Math.ceil(docEl.scrollHeight / viewH));
    this.currentPage = 1;
    this.iframe.contentWindow?.scrollTo(0, 0);
    this.updatePager();
  }

  private showFrame(on: boolean): void {
    this.iframe.style.display = on ? 'block' : 'none';
    this.placeholder.classList.toggle('hidden', on);
    if (on) {
      this.canvas.style.display = 'none';
      this.imgStage.style.display = 'none';
    }
  }

  private showLoading(on: boolean): void {
    this.loading.classList.toggle('hidden', !on);
  }

  private showCanvas(on: boolean): void {
    this.canvas.style.display = on ? 'block' : 'none';
    this.placeholder.classList.toggle('hidden', on);
    if (on) {
      this.iframe.style.display = 'none';
      this.imgStage.style.display = 'none';
    }
  }

  private showImg(on: boolean): void {
    this.imgStage.style.display = on ? 'grid' : 'none';
    this.img.style.display = on ? 'block' : 'none';
    if (on) {
      this.iframe.style.display = 'none';
      this.canvas.style.display = 'none';
      this.placeholder.classList.add('hidden');
    }
  }

  private showError(msg: string): void {
    previewLog('showError()', { message: msg });
    this.latestImageInfo = null;
    this.showLoading(false);
    this.showCanvas(false);
    this.showImg(false);
    this.controls.style.display = 'none';
    this.iframe.style.display = 'none';
    this.imgStage.style.display = 'none';
    const text = document.getElementById('placeholderText');
    if (text) text.textContent = msg;
    this.placeholder.classList.remove('hidden');
    this.setHint(msg);
  }

  private setHint(msg: string): void {
    this.hintEl.textContent = msg;
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    void destroyPdfLoadingTask(this.pdfLoadingTask);
    this.pdfLoadingTask = null;
    this.pdfDoc = null;
  }

  zoomIn(): void {
    this.zoomScale = Math.min(
      this.ZOOM_MAX,
      parseFloat((this.zoomScale + this.ZOOM_STEP).toFixed(2)),
    );
    this.resizeSheet();
    if (this.pdfDoc) void this.renderPage(this.currentPage);
    this.updateZoomDisplay();
  }

  zoomOut(): void {
    this.zoomScale = Math.max(
      this.ZOOM_MIN,
      parseFloat((this.zoomScale - this.ZOOM_STEP).toFixed(2)),
    );
    this.resizeSheet();
    if (this.pdfDoc) void this.renderPage(this.currentPage);
    this.updateZoomDisplay();
  }

  zoomReset(): void {
    this.zoomScale = 1.0;
    this.resizeSheet();
    if (this.pdfDoc) void this.renderPage(this.currentPage);
    this.updateZoomDisplay();
  }

  private updateZoomDisplay(): void {
    const el = document.getElementById('zoomLevel');
    if (el) el.textContent = `${Math.round(this.zoomScale * 100)}%`;
  }

  /** Load from a raw ArrayBuffer (used by copy preview) */
  async loadFromBuffer(buf: ArrayBuffer, mime: string): Promise<void> {
    if (mime === 'application/pdf') {
      await this.loadPdf(buf);
    } else if (mime.startsWith('image/')) {
      const blob = new Blob([buf], { type: mime });
      const url = URL.createObjectURL(blob);
      await this.loadImage(url, true);
    } else {
      this.showError('Unsupported preview format.');
    }
  }
}

const params = new URLSearchParams(window.location.search);
const rawStoredConfig = sessionStorage.getItem('printbit.config');
let storedConfig: StoredConfigSeed | null = null;
if (rawStoredConfig) {
  try {
    storedConfig = JSON.parse(rawStoredConfig) as StoredConfigSeed;
  } catch {
    storedConfig = null;
  }
}

const modeFromQuery = params.get('mode');
const modeFromStorage = sessionStorage.getItem('printbit.mode');
const mode: WorkflowMode =
  parseWorkflowMode(modeFromQuery) ??
  parseWorkflowMode(modeFromStorage) ??
  parseWorkflowMode(storedConfig?.mode) ??
  'print';
const sessionId =
  params.get('sessionId') ?? sessionStorage.getItem('printbit.sessionId');
const sessionToken =
  params.get('token') ?? sessionStorage.getItem('printbit.sessionToken');
const selectedFile =
  params.get('file') ?? sessionStorage.getItem('printbit.uploadedFile');
const selectedDocumentId =
  params.get('documentId') ??
  sessionStorage.getItem('printbit.uploadedDocumentId');
const copyPreviewPath = sessionStorage.getItem('printbit.copyPreviewPath');
const copyPreviewReleaseToken = sessionStorage.getItem(
  'printbit.copyPreviewReleaseToken',
);
const scanFilename =
  typeof storedConfig?.scanFilename === 'string'
    ? storedConfig.scanFilename.trim()
    : '';
const scanReleaseToken =
  typeof storedConfig?.scanReleaseToken === 'string' &&
  storedConfig.scanReleaseToken.trim().length > 0
    ? storedConfig.scanReleaseToken.trim()
    : null;
const hasStoredOrientation =
  storedConfig?.orientation === 'landscape' ||
  storedConfig?.orientation === 'portrait';
const hasStoredPaperSize =
  storedConfig?.paperSize === 'A4' ||
  storedConfig?.paperSize === 'Letter' ||
  storedConfig?.paperSize === 'Legal';
const initialOrientation: Orientation =
  storedConfig?.orientation === 'landscape' ? 'landscape' : 'portrait';
const initialPaperSize: PaperSize =
  storedConfig?.paperSize === 'Letter' || storedConfig?.paperSize === 'Legal'
    ? storedConfig.paperSize
    : 'A4';
const initialQuality: PrintQuality =
  storedConfig?.quality === 'high' ? 'high' : 'standard';
let rotationDeg: RotationDeg =
  normalizeRotationDeg(storedConfig?.rotationDeg) ?? 0;

const backLink = document.getElementById(
  'backLink',
) as HTMLAnchorElement | null;
const continueBtn = document.getElementById(
  'continueBtn',
) as HTMLButtonElement | null;
const filePillLabel = document.getElementById(
  'filePillLabel',
) as HTMLElement | null;
const footerSummary = document.getElementById(
  'footerSelections',
) as HTMLElement | null;
const footerBreakdown = document.getElementById(
  'footerBreakdown',
) as HTMLElement | null;
const footerTotal = document.getElementById(
  'footerTotal',
) as HTMLElement | null;
const largePrintDisclaimer = document.getElementById(
  'largePrintDisclaimer',
) as HTMLElement | null;
const openPricingBtn = document.getElementById('openPricingBtn');
const closePricingBtn = document.getElementById('closePricingBtn');
const pricingOverlay = document.getElementById('pricingOverlay');
const pricingGuideContent = document.getElementById('pricingGuideContent');
const copiesInput = document.getElementById(
  'copies',
) as HTMLInputElement | null;
const copiesDec = document.getElementById(
  'copiesDec',
) as HTMLButtonElement | null;
const copiesInc = document.getElementById(
  'copiesInc',
) as HTMLButtonElement | null;

const pageModeAll = document.getElementById(
  'pageModeAll',
) as HTMLInputElement | null;
const pageModeCustom = document.getElementById(
  'pageModeCustom',
) as HTMLInputElement | null;
const pageModeSingle = document.getElementById(
  'pageModeSingle',
) as HTMLInputElement | null;
const pageRangeGroup = document.getElementById(
  'pageRangeGroup',
) as HTMLElement | null;
const pageRangeCustomWrap = document.getElementById(
  'pageRangeCustomWrap',
) as HTMLElement | null;
const pageRangeSingleWrap = document.getElementById(
  'pageRangeSingleWrap',
) as HTMLElement | null;
const pageRangeInput = document.getElementById(
  'pageRangeInput',
) as HTMLInputElement | null;
const customRangeDisplay = document.getElementById(
  'customRangeDisplay',
) as HTMLElement | null;
const customRangeStartInput = document.getElementById(
  'customRangeStartInput',
) as HTMLInputElement | null;
const customRangeStartDec = document.getElementById(
  'customRangeStartDec',
) as HTMLButtonElement | null;
const customRangeStartInc = document.getElementById(
  'customRangeStartInc',
) as HTMLButtonElement | null;
const customRangeEndInput = document.getElementById(
  'customRangeEndInput',
) as HTMLInputElement | null;
const customRangeEndDec = document.getElementById(
  'customRangeEndDec',
) as HTMLButtonElement | null;
const customRangeEndInc = document.getElementById(
  'customRangeEndInc',
) as HTMLButtonElement | null;
const singlePageInput = document.getElementById(
  'singlePageInput',
) as HTMLInputElement | null;
const singlePageDec = document.getElementById(
  'singlePageDec',
) as HTMLButtonElement | null;
const singlePageInc = document.getElementById(
  'singlePageInc',
) as HTMLButtonElement | null;
const colorModeGroup = document.getElementById(
  'colorModeGroup',
) as HTMLElement | null;
const qualityGroup = document.getElementById(
  'qualityGroup',
) as HTMLElement | null;
const orientationGroup = document.getElementById(
  'orientationGroup',
) as HTMLElement | null;
const rotationGroup = document.getElementById(
  'rotationGroup',
) as HTMLElement | null;
const paperSizeGroup = document.getElementById(
  'paperSizeGroup',
) as HTMLElement | null;
const copiesGroup = document.getElementById(
  'copiesGroup',
) as HTMLElement | null;
const rotateLeftBtn = document.getElementById(
  'rotateLeftBtn',
) as HTMLButtonElement | null;
const rotateRightBtn = document.getElementById(
  'rotateRightBtn',
) as HTMLButtonElement | null;
const rotationValue = document.getElementById('rotationValue');
const colorDetectionEvidence = document.getElementById(
  'colorDetectionEvidence',
) as HTMLElement | null;
const colorDetectionSummary = document.getElementById(
  'colorDetectionSummary',
) as HTMLElement | null;
const colorDetectionMeter = document.getElementById(
  'colorDetectionMeter',
) as HTMLElement | null;
const colorDetectionMeterFill = document.getElementById(
  'colorDetectionMeterFill',
) as HTMLElement | null;
const colorDetectionCounts = document.getElementById(
  'colorDetectionCounts',
) as HTMLElement | null;
const colorDetectionConfidence = document.getElementById(
  'colorDetectionConfidence',
) as HTMLElement | null;
const qualityRadios = document.querySelectorAll<HTMLInputElement>(
  'input[name="printQuality"]',
);

const initialOrientationInput = document.querySelector<HTMLInputElement>(
  `input[name="orientation"][value="${initialOrientation}"]`,
);
if (initialOrientationInput) {
  initialOrientationInput.checked = true;
}

const initialPaperSizeInput = document.querySelector<HTMLInputElement>(
  `input[name="paperSize"][value="${initialPaperSize}"]`,
);
if (initialPaperSizeInput) {
  initialPaperSizeInput.checked = true;
}

const initialQualityInput = document.querySelector<HTMLInputElement>(
  `input[name="printQuality"][value="${initialQuality}"]`,
);
if (initialQualityInput) {
  initialQualityInput.checked = true;
}

function setContinueEnabled(canContinue: boolean): void {
  if (!continueBtn) return;
  continueBtn.disabled = !canContinue;
  continueBtn.setAttribute('aria-disabled', canContinue ? 'false' : 'true');
}

const preparationLoading = createConfigPreparationLoadingController({
  setContinueEnabled,
});

if (backLink) {
  backLink.href =
    mode === 'copy' ? '/copy' : mode === 'scan' ? '/scan' : '/print';
}
if (filePillLabel) {
  filePillLabel.textContent =
    mode === 'scan' ? scanFilename || '—' : (selectedFile ?? '—');
}

if (mode === 'print' && continueBtn) {
  setContinueEnabled(false);
}

if (mode === 'copy' && continueBtn) {
  pageRangeGroup?.classList.add('hidden');
  const hasCopyPreview = Boolean(copyPreviewPath);
  setContinueEnabled(hasCopyPreview);
  if (footerSummary)
    footerSummary.textContent = hasCopyPreview
      ? 'Copy mode — checked document ready.'
      : 'No checked document found — go back to /copy first.';
}

if (mode === 'scan') {
  colorModeGroup?.classList.add('hidden');
  qualityGroup?.classList.add('hidden');
  orientationGroup?.classList.remove('hidden');
  rotationGroup?.classList.remove('hidden');
  paperSizeGroup?.classList.add('hidden');
  pageRangeGroup?.classList.add('hidden');
  copiesGroup?.classList.add('hidden');
  const hasScanPreview = scanFilename.length > 0;
  setContinueEnabled(hasScanPreview);
  if (footerSummary) {
    footerSummary.textContent = hasScanPreview
      ? 'Scan preview loaded — set orientation and rotation.'
      : 'No scanned file found — go back to /scan first.';
  }
}

let currentPrintQuote: PrintQuote | null = null;
let detectedColorMode: ColorMode | null = null;
let quoteError: string | null = null;
let quoteLoading = false;
let quoteRequestVersion = 0;
let quoteDebounceHandle: number | null = null;
let analysisPendingQuoteRetryHandle: number | null = null;
const QUOTE_409_RETRY_ATTEMPTS = 20;
const QUOTE_409_RETRY_DELAY_MS = 500;
const ANALYSIS_PENDING_QUOTE_RETRY_DELAY_MS = 2_000;

const detectionConfidenceLabels: Record<
  PrintQuote['analysisConfidence'],
  string
> = {
  high: 'High-confidence page analysis',
  medium: 'Review recommended — some pages used a fallback',
  low: 'Lower-confidence analysis — review the preview',
};

function renderColorDetectionEvidence(): void {
  if (!colorDetectionEvidence) return;

  const quote = currentPrintQuote;
  const shouldShow =
    mode !== 'scan' && Boolean(quote) && !quoteLoading && !quoteError;
  colorDetectionEvidence.hidden = !shouldShow;
  if (!shouldShow || !quote) return;

  const evidence = buildColorDetectionEvidence({
    selectedColorPages: quote.selectedColorPages,
    selectedBwPages: quote.selectedBwPages,
    analysisConfidence: quote.analysisConfidence,
  });
  const pageLabel = evidence.selectedPages === 1 ? 'page' : 'pages';

  if (colorDetectionSummary) {
    colorDetectionSummary.textContent = `Color detected on ${evidence.colorPercentage}% of selected ${pageLabel}`;
  }
  if (colorDetectionMeter) {
    colorDetectionMeter.setAttribute(
      'aria-valuenow',
      String(evidence.colorPercentage),
    );
    colorDetectionMeter.setAttribute(
      'aria-label',
      `${evidence.colorPercentage}% of selected pages contain color`,
    );
  }
  if (colorDetectionMeterFill) {
    colorDetectionMeterFill.style.width = `${evidence.colorPercentage}%`;
  }
  if (colorDetectionCounts) {
    colorDetectionCounts.textContent = `${evidence.colorPages} Color · ${evidence.grayscalePages} Grayscale`;
  }
  if (colorDetectionConfidence) {
    colorDetectionConfidence.textContent =
      detectionConfidenceLabels[evidence.confidence];
  }
}

function getPageRangeMaxPages(): number {
  return Math.max(1, preview.pageCount || 1);
}

function syncCustomRangeInputs(
  changed: 'start' | 'end' | 'both' = 'both',
): void {
  if (!pageRangeInput) return;
  const max = getPageRangeMaxPages();
  let start = parseInt(customRangeStartInput?.value ?? '1', 10) || 1;
  let end = parseInt(customRangeEndInput?.value ?? '1', 10) || 1;

  start = Math.max(1, Math.min(max, start));
  end = Math.max(1, Math.min(max, end));

  if (start > end) {
    if (changed === 'start') end = start;
    else start = end;
  }

  if (customRangeStartInput) {
    customRangeStartInput.min = '1';
    customRangeStartInput.max = String(max);
    customRangeStartInput.value = String(start);
  }
  if (customRangeEndInput) {
    customRangeEndInput.min = '1';
    customRangeEndInput.max = String(max);
    customRangeEndInput.value = String(end);
  }

  const normalizedRange = start === end ? String(start) : `${start}-${end}`;
  pageRangeInput.value = normalizedRange;
  if (customRangeDisplay) {
    if (pageModeAll?.checked) {
      customRangeDisplay.textContent = `All pages (${max === 1 ? '1 page' : `1–${max}`})`;
    } else {
      customRangeDisplay.textContent = `Selected: ${normalizedRange}`;
    }
  }
}

function updateCustomRangeWithDelta(
  target: 'start' | 'end',
  delta: number,
): void {
  if (pageModeAll?.checked) return;
  const input =
    target === 'start' ? customRangeStartInput : customRangeEndInput;
  if (!input) return;
  const next = (parseInt(input.value || '1', 10) || 1) + delta;
  input.value = String(next);
  syncCustomRangeInputs(target);
  syncCustomRangeValidity();
  updateSummary();
  schedulePrintQuoteRefresh();
}

const customRangeStepperControls: Array<{
  el: HTMLButtonElement | null;
  target: 'start' | 'end';
  delta: number;
}> = [
  { el: customRangeStartDec, target: 'start', delta: -1 },
  { el: customRangeStartInc, target: 'start', delta: 1 },
  { el: customRangeEndDec, target: 'end', delta: -1 },
  { el: customRangeEndInc, target: 'end', delta: 1 },
];

customRangeStepperControls.forEach(({ el, target, delta }) => {
  el?.addEventListener('click', () => {
    updateCustomRangeWithDelta(target, delta);
  });
});

customRangeStartInput?.addEventListener('change', () => {
  if (pageModeAll?.checked) return;
  syncCustomRangeInputs('start');
  syncCustomRangeValidity();
  updateSummary();
  schedulePrintQuoteRefresh();
});

customRangeEndInput?.addEventListener('change', () => {
  if (pageModeAll?.checked) return;
  syncCustomRangeInputs('end');
  syncCustomRangeValidity();
  updateSummary();
  schedulePrintQuoteRefresh();
});

pageRangeCustomWrap?.addEventListener('click', () => {
  if (pageModeAll?.checked && pageModeCustom) {
    pageModeCustom.checked = true;
    pageModeCustom.dispatchEvent(new Event('change', { bubbles: true }));
  }
});

singlePageDec?.addEventListener('click', () => {
  if (pageModeAll?.checked) return;
  if (!singlePageInput) return;
  const next = Math.max(1, clampSinglePage() - 1);
  singlePageInput.value = String(next);
  clampSinglePage();
  void preview.goToPage(next);
  updateSummary();
  schedulePrintQuoteRefresh();
});

singlePageInc?.addEventListener('click', () => {
  if (pageModeAll?.checked) return;
  if (!singlePageInput) return;
  const next = Math.min(getPageRangeMaxPages(), clampSinglePage() + 1);
  singlePageInput.value = String(next);
  clampSinglePage();
  void preview.goToPage(next);
  updateSummary();
  schedulePrintQuoteRefresh();
});

singlePageInput?.addEventListener('change', () => {
  if (pageModeAll?.checked) return;
  const page = clampSinglePage();
  void preview.goToPage(page);
  updateSummary();
  schedulePrintQuoteRefresh();
});

pageRangeSingleWrap?.addEventListener('click', () => {
  if (pageModeAll?.checked && pageModeSingle) {
    pageModeSingle.checked = true;
    pageModeSingle.dispatchEvent(new Event('change', { bubbles: true }));
  }
});

function clampSinglePage(): number {
  const max = getPageRangeMaxPages();
  const raw = parseInt(singlePageInput?.value ?? '1', 10) || 1;
  const next = Math.max(1, Math.min(max, raw));
  if (singlePageInput) {
    singlePageInput.max = String(max);
    singlePageInput.value = String(next);
  }
  return next;
}

function isValidCustomRange(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  return /^\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*$/.test(value);
}

function syncCustomRangeValidity(): void {
  if (!pageRangeInput) return;
  syncCustomRangeInputs();
  if (!pageModeCustom?.checked) {
    pageRangeInput.setCustomValidity('');
    return;
  }

  const raw = pageRangeInput.value;
  if (isValidCustomRange(raw)) {
    pageRangeInput.setCustomValidity('');
    return;
  }

  pageRangeInput.setCustomValidity(
    'Use formats like 1-3, 5, 7-9 or a single page number.',
  );
}

function getPageRange(): PageRangeSelection {
  if (!hasMultiplePages()) {
    return { type: 'all' };
  }
  if (pageModeCustom?.checked) {
    const range = (pageRangeInput?.value ?? '').trim();
    return { type: 'custom', range };
  }
  if (pageModeSingle?.checked) {
    return { type: 'single', page: clampSinglePage() };
  }
  return { type: 'all' };
}

function pageRangeLabel(sel: PageRangeSelection): string {
  if (sel.type === 'single') return `Page ${sel.page}`;
  if (sel.type === 'custom')
    return sel.range ? `Pages ${sel.range}` : 'Pages (custom)';
  return 'All pages';
}

function syncPageRangeUI(): void {
  const rangeVisible = pageRangeGroup
    ? !pageRangeGroup.classList.contains('hidden')
    : true;
  const isAll = Boolean(pageModeAll?.checked);
  const isCustom = Boolean(pageModeCustom?.checked);
  const isSingle = Boolean(pageModeSingle?.checked);

  // If "All Pages" is selected, hide the extra options in Custom Range and Single Page
  const showCustom = rangeVisible && isCustom && !isAll;
  const showSingle = rangeVisible && isSingle && !isAll;

  pageRangeCustomWrap?.classList.toggle('hidden', !showCustom);
  pageRangeSingleWrap?.classList.toggle('hidden', !showSingle);

  const customControls = [
    customRangeStartDec,
    customRangeStartInput,
    customRangeStartInc,
    customRangeEndDec,
    customRangeEndInput,
    customRangeEndInc,
  ];
  customControls.forEach((el) => {
    if (el) {
      el.disabled = !isCustom;
      if (!isCustom) {
        el.setAttribute('aria-disabled', 'true');
      } else {
        el.removeAttribute('aria-disabled');
      }
    }
  });

  const singleControls = [singlePageDec, singlePageInput, singlePageInc];
  singleControls.forEach((el) => {
    if (el) {
      el.disabled = !isSingle;
      if (!isSingle) {
        el.setAttribute('aria-disabled', 'true');
      } else {
        el.removeAttribute('aria-disabled');
      }
    }
  });
}

function hasMultiplePages(): boolean {
  return mode === 'print' && getPageRangeMaxPages() > 1;
}

function syncPageRangeAvailability(): void {
  const visible = hasMultiplePages();
  const maxPages = getPageRangeMaxPages();
  const maxAllowed: number = 30; // Maximum pages allowed for custom range selection

  pageRangeGroup?.classList.toggle('hidden', !visible);

  if (pageModeAll) {
    if (!visible) {
      pageModeAll.checked = true;
      pageModeAll.disabled = false;
    } else if (maxPages > maxAllowed) {
      pageModeAll.disabled = true; // Disable "All Pages"
      if (pageModeAll.checked) {
        if (pageModeCustom) pageModeCustom.checked = true; // Auto-select "Page Range"
        if (customRangeStartInput) customRangeStartInput.value = '1';
        if (customRangeEndInput)
          customRangeEndInput.value = String(Math.min(maxAllowed, maxPages));
      }
    } else {
      pageModeAll.disabled = false;
    }
  }

  const allPagesLabel = pageModeAll?.closest<HTMLElement>('.option-card');
  if (allPagesLabel) {
    allPagesLabel.style.display = maxPages > maxAllowed ? 'none' : '';
    allPagesLabel.setAttribute(
      'title',
      maxPages > maxAllowed ? 'Max 30 pages allowed' : '',
    );
  }

  syncPageRangeUI();
  syncCustomRangeInputs();
  syncCustomRangeValidity();
}

function getRadio(name: string): string {
  return (
    document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)
      ?.value ?? ''
  );
}

function getSelectedQuality(): PrintQuality {
  return document.querySelector<HTMLInputElement>(
    'input[name="printQuality"][value="high"]:checked',
  )
    ? 'high'
    : 'standard';
}

function getCopies(): number {
  return Math.max(
    1,
    Math.min(30, parseInt(copiesInput?.value ?? '1', 10) || 1),
  );
}

function currentPreviewConfig(): PreviewConfig {
  return {
    scaling: DEFAULT_PRINT_SCALING,
    colorMode: (getRadio('colorMode') as ColorMode) || 'colored',
    orientation: (getRadio('orientation') as Orientation) || 'portrait',
    paperSize: (getRadio('paperSize') as PaperSize) || 'A4',
    rotationDeg,
  };
}

function setPricingModalOpen(open: boolean): void {
  if (!pricingOverlay) return;
  pricingOverlay.classList.toggle('is-open', open);
  pricingOverlay.setAttribute('aria-hidden', String(!open));
  if (open) closePricingBtn?.focus();
  else openPricingBtn?.focus();
}

openPricingBtn?.addEventListener('click', () => setPricingModalOpen(true));
closePricingBtn?.addEventListener('click', () => setPricingModalOpen(false));
pricingOverlay?.addEventListener('click', (event) => {
  if (event.target === pricingOverlay) setPricingModalOpen(false);
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setPricingModalOpen(false);
});

void fetchPublicPricing()
  .then((pricing) => {
    if (pricingGuideContent)
      pricingGuideContent.innerHTML = formatPricingGuide(pricing);
  })
  .catch(() => {
    if (pricingGuideContent)
      pricingGuideContent.textContent =
        'Printing prices are unavailable right now.';
  });

function setPrintContinueState(): void {
  if (mode !== 'print') return;
  const hasCustomRangeError =
    hasMultiplePages() &&
    Boolean(pageModeCustom?.checked) &&
    Boolean(pageRangeInput?.validationMessage);
  const canContinue =
    Boolean(currentPrintQuote) && !quoteLoading && !hasCustomRangeError;
  setContinueEnabled(canContinue);
}

function waitForQuoteRetry(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function requestDocumentAnalysisRetry(): Promise<boolean> {
  if (mode !== 'print' || !sessionId || !sessionToken) {
    return false;
  }

  const payload = selectedDocumentId ? { documentId: selectedDocumentId } : {};

  try {
    const response = await fetch(
      `/api/wireless/sessions/${encodeURIComponent(sessionId)}/analyze?token=${encodeURIComponent(sessionToken)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function refreshPrintQuote(): Promise<void> {
  if ((mode !== 'print' && mode !== 'copy') || (!sessionId && mode === 'print'))
    return;

  if (analysisPendingQuoteRetryHandle !== null) {
    window.clearTimeout(analysisPendingQuoteRetryHandle);
    analysisPendingQuoteRetryHandle = null;
  }

  if (
    mode === 'print' &&
    hasMultiplePages() &&
    pageModeCustom?.checked &&
    pageRangeInput &&
    !pageRangeInput.checkValidity()
  ) {
    quoteRequestVersion += 1;
    currentPrintQuote = null;
    quoteError = pageRangeInput.validationMessage || 'Invalid page range.';
    quoteLoading = false;
    updateSummary();
    setPrintContinueState();
    return;
  }

  const requestVersion = ++quoteRequestVersion;
  quoteLoading = true;
  quoteError = null;
  updateSummary();
  setPrintContinueState();

  try {
    const cfg = currentPreviewConfig();
    const requestBody: QuoteRequestBody = {
      copies: getCopies(),
      colorMode: cfg.colorMode,
      quality: getSelectedQuality(),
      orientation: cfg.orientation,
      rotationDeg: cfg.rotationDeg,
      paperSize: cfg.paperSize,
      pageRange: getPageRange(),
      duplex: false,
    };

    if (mode === 'print') {
      requestBody.sessionId = sessionId ?? undefined;
      requestBody.documentId = selectedDocumentId ?? undefined;
    } else if (mode === 'copy') {
      requestBody.sessionId = 'copy-session';
      requestBody.isCopyJob = true;
      requestBody.copyPreviewPath = copyPreviewPath;
    }

    let resolvedQuote: PrintQuote | null = null;
    let resolvedError: string | null = null;
    let attemptedAnalysisRecovery = false;
    let analysisStillPending = false;

    const endpoint = mode === 'print' ? '/api/print/quote' : '/api/copy/quote';

    for (let attempt = 0; attempt < QUOTE_409_RETRY_ATTEMPTS; attempt += 1) {
      if (requestVersion !== quoteRequestVersion) return;

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });
      } catch {
        resolvedError = 'Network error while calculating price.';
        break;
      }

      if (requestVersion !== quoteRequestVersion) return;

      let payload: { error?: string; code?: string; quote?: PrintQuote } = {};
      try {
        payload = (await response.json()) as {
          error?: string;
          code?: string;
          quote?: PrintQuote;
        };
      } catch {
        payload = {};
      }

      const responseCode =
        typeof payload.code === 'string' ? payload.code : null;
      const isAnalysisPending = responseCode === 'ANALYSIS_PENDING';
      const isAnalysisFailed = responseCode === 'ANALYSIS_FAILED';
      const isAnalysisUnavailable = responseCode === 'ANALYSIS_UNAVAILABLE';

      if (
        response.status === 409 &&
        (isAnalysisPending || isAnalysisFailed || isAnalysisUnavailable) &&
        attempt < QUOTE_409_RETRY_ATTEMPTS - 1
      ) {
        if (
          (isAnalysisFailed || isAnalysisUnavailable) &&
          !attemptedAnalysisRecovery
        ) {
          attemptedAnalysisRecovery = true;
          const retryQueued = await requestDocumentAnalysisRetry();
          if (!retryQueued) {
            console.warn('[config] Failed to queue analysis retry.');
          }
        }
        await waitForQuoteRetry(QUOTE_409_RETRY_DELAY_MS);
        continue;
      }

      if (response.status === 409 && attempt < QUOTE_409_RETRY_ATTEMPTS - 1) {
        await waitForQuoteRetry(QUOTE_409_RETRY_DELAY_MS);
        continue;
      }

      if (!response.ok || !payload.quote) {
        analysisStillPending = isAnalysisPending;
        resolvedError = isAnalysisPending
          ? 'Document preparation is still in progress.'
          : (payload.error ?? 'Failed to calculate price.');
        break;
      }

      resolvedQuote = payload.quote;
      break;
    }

    if (requestVersion !== quoteRequestVersion) return;

    if (resolvedQuote) {
      currentPrintQuote = resolvedQuote;
      quoteError = null;
      logQuoteBreakdown(resolvedQuote);
    } else {
      currentPrintQuote = null;
      quoteError = resolvedError ?? 'Failed to calculate price.';
      settingsLog('Quote failed to resolve', { error: resolvedError });
      if (analysisStillPending) {
        scheduleAnalysisPendingQuoteRetry(requestVersion);
      }
    }
  } catch {
    if (requestVersion !== quoteRequestVersion) return;
    currentPrintQuote = null;
    quoteError = 'Network error while calculating price.';
  } finally {
    if (requestVersion === quoteRequestVersion) {
      quoteLoading = false;
      updateSummary();
      setPrintContinueState();
    }
  }
}

function scheduleAnalysisPendingQuoteRetry(requestVersion: number): void {
  if (mode !== 'print' && mode !== 'copy') return;

  analysisPendingQuoteRetryHandle = window.setTimeout(() => {
    analysisPendingQuoteRetryHandle = null;
    if (requestVersion !== quoteRequestVersion) return;
    void refreshPrintQuote();
  }, ANALYSIS_PENDING_QUOTE_RETRY_DELAY_MS);
}

function schedulePrintQuoteRefresh(): void {
  if (mode !== 'print' && mode !== 'copy') return;
  if (analysisPendingQuoteRetryHandle !== null) {
    window.clearTimeout(analysisPendingQuoteRetryHandle);
    analysisPendingQuoteRetryHandle = null;
  }
  if (quoteDebounceHandle !== null) {
    window.clearTimeout(quoteDebounceHandle);
  }
  quoteDebounceHandle = window.setTimeout(() => {
    quoteDebounceHandle = null;
    void refreshPrintQuote();
  }, 120);
}

function updateSummary(): void {
  renderColorDetectionEvidence();
  if (largePrintDisclaimer) {
    const shouldShow =
      mode === 'print' && isLargePrintDocument(preview.pageCount);
    largePrintDisclaimer.hidden = !shouldShow;
    largePrintDisclaimer.textContent = shouldShow
      ? formatLargePrintDisclaimer(preview.pageCount)
      : '';
    if (shouldShow) {
      sessionStorage.setItem('printbit.largePrintNoticeShown', 'true');
    }
  }
  if (!footerSummary) return;
  if (mode === 'scan') {
    const cfg = currentPreviewConfig();
    footerSummary.classList.add('ready');
    footerSummary.textContent = 'Scan ready';
    if (footerBreakdown) {
      footerBreakdown.textContent =
        `${cfg.orientation === 'portrait' ? 'Portrait' : 'Landscape'} · ` +
        `Rotation ${cfg.rotationDeg}°`;
    }
    if (footerTotal) footerTotal.textContent = 'Ready to scan';
    return;
  }

  const cfg = currentPreviewConfig();
  const n = getCopies();

  if (quoteLoading) {
    if (footerBreakdown)
      footerBreakdown.textContent =
        'Checking selected pages, color, and print quality.';
    if (footerTotal) footerTotal.textContent = '…';
    footerSummary.classList.remove('ready');
    return;
  }

  if (currentPrintQuote) {
    footerSummary.classList.add('ready');
    if (footerBreakdown) {
      footerBreakdown.textContent =
        `${currentPrintQuote.selectedPages} ${currentPrintQuote.selectedPages === 1 ? 'page' : 'pages'} × ` +
        `${n} ${n === 1 ? 'copy' : 'copies'} · ` +
        `${currentPrintQuote.effectiveColorMode === 'colored' ? 'Color' : 'Grayscale'} · ` +
        `${cfg.paperSize} · ${currentPrintQuote.quality === 'high' ? 'High quality' : 'Standard quality'}`;
    }
    if (footerTotal)
      footerTotal.textContent = `₱${currentPrintQuote.requiredAmount}`;
    return;
  }

  if (quoteError) {
    footerSummary.textContent = 'Price unavailable';
    if (footerBreakdown)
      footerBreakdown.textContent = `${quoteError} Check the connection, then change a setting to recalculate.`;
    if (footerTotal) footerTotal.textContent = '—';
    footerSummary.classList.remove('ready');
    return;
  }

  if (mode === 'copy') {
    const hasCopyPreview = Boolean(copyPreviewPath);
    if (hasCopyPreview) {
      footerSummary.textContent = 'Copy ready';
      if (footerBreakdown)
        footerBreakdown.textContent =
          'Choose settings to calculate your total.';
    } else {
      footerSummary.textContent = 'No document detected';
      if (footerBreakdown)
        footerBreakdown.textContent =
          'Go back to scan a document before continuing.';
    }
    if (footerTotal) footerTotal.textContent = '—';
    return;
  }

  footerSummary.textContent = 'Choose your print settings';
  if (footerBreakdown) {
    footerBreakdown.textContent =
      `${pageRangeLabel(getPageRange())} · ${n} ${n === 1 ? 'copy' : 'copies'} · ` +
      `${cfg.colorMode === 'colored' ? 'Color' : 'Grayscale'} · ${cfg.paperSize}`;
  }
  if (footerTotal) footerTotal.textContent = '—';
}

const preview = new PrintPreview();

function renderRotationValue(): void {
  if (rotationValue) {
    rotationValue.textContent = `${rotationDeg}°`;
  }
}

function setRotation(next: number): void {
  const normalized = normalizeRotationDeg(((next % 360) + 360) % 360);
  rotationDeg = normalized ?? 0;
  renderRotationValue();
  const cfg = currentPreviewConfig();
  preview.applyConfig(cfg);
  updateSummary();
  schedulePrintQuoteRefresh();
}

renderRotationValue();
preview.applyConfig(currentPreviewConfig());

let userManuallyAdjustedOrientation = false;
let userManuallyAdjustedPaperSize = false;
let suppressOrientationAutoTracking = false;
let suppressPaperSizeAutoTracking = false;

document
  .querySelectorAll<HTMLInputElement>('input[name="orientation"]')
  .forEach((el) => {
    el.addEventListener('change', () => {
      if (suppressOrientationAutoTracking) return;
      userManuallyAdjustedOrientation = true;
    });
  });

document
  .querySelectorAll<HTMLInputElement>('input[name="paperSize"]')
  .forEach((el) => {
    el.addEventListener('change', () => {
      if (suppressPaperSizeAutoTracking) return;
      userManuallyAdjustedPaperSize = true;
    });
  });

document
  .querySelectorAll<HTMLInputElement>('input[type=radio]')
  .forEach((el) => {
    el.addEventListener('change', () => {
      if (el.name === 'pageRangeMode') {
        syncPreviewPageWithRange();
        syncPageRangeUI();
        syncCustomRangeInputs();
        syncCustomRangeValidity();
      }
      const cfg = currentPreviewConfig();
      preview.applyConfig(cfg);
      updateSummary();
      schedulePrintQuoteRefresh();
    });
  });

qualityRadios.forEach((radio) => {
  radio.addEventListener('change', () => {
    updateSummary();
    schedulePrintQuoteRefresh();
  });
});

rotateLeftBtn?.addEventListener('click', () => {
  setRotation(rotationDeg - 90);
});

rotateRightBtn?.addEventListener('click', () => {
  setRotation(rotationDeg + 90);
});

copiesDec?.addEventListener('click', () => {
  const v = getCopies();
  if (v > 1 && copiesInput) {
    copiesInput.value = String(v - 1);
    updateSummary();
    schedulePrintQuoteRefresh();
  }
});
copiesInc?.addEventListener('click', () => {
  const v = getCopies();
  if (v < 30 && copiesInput) {
    copiesInput.value = String(v + 1);
    updateSummary();
    schedulePrintQuoteRefresh();
  }
});
copiesInput?.addEventListener('change', () => {
  if (copiesInput) {
    copiesInput.value = String(getCopies());
    updateSummary();
    schedulePrintQuoteRefresh();
  }
});

updateSummary();
syncPageRangeAvailability();
clampSinglePage();
syncCustomRangeValidity();
setPrintContinueState();

async function applyDocumentAutoDetection(): Promise<void> {
  let changed = false;

  if (!hasStoredOrientation && !userManuallyAdjustedOrientation) {
    try {
      const detectedOrientation = await preview.getNaturalOrientation();
      if (detectedOrientation) {
        const currentOrientation = getRadio('orientation');
        if (currentOrientation !== detectedOrientation) {
          const target = document.querySelector<HTMLInputElement>(
            `input[name="orientation"][value="${detectedOrientation}"]`,
          );
          if (target) {
            previewLog('Auto-applying detected orientation', {
              detectedOrientation,
            });
            suppressOrientationAutoTracking = true;
            try {
              target.checked = true;
              target.dispatchEvent(new Event('change', { bubbles: true }));
              changed = true;
            } finally {
              suppressOrientationAutoTracking = false;
            }
          }
        }
      }
    } catch (err) {
      previewLog('Failed to auto-detect document orientation', err);
    }
  }

  if (!hasStoredPaperSize && !userManuallyAdjustedPaperSize) {
    try {
      const detectedPaperSize = await preview.getDetectedPaperSize();
      if (detectedPaperSize) {
        const currentPaperSize = getRadio('paperSize');
        if (currentPaperSize !== detectedPaperSize) {
          const target = document.querySelector<HTMLInputElement>(
            `input[name="paperSize"][value="${detectedPaperSize}"]`,
          );
          if (target) {
            previewLog('Auto-applying detected paper size', {
              detectedPaperSize,
            });
            suppressPaperSizeAutoTracking = true;
            try {
              target.checked = true;
              target.dispatchEvent(new Event('change', { bubbles: true }));
              changed = true;
            } finally {
              suppressPaperSizeAutoTracking = false;
            }
          }
        }
      }
    } catch (err) {
      previewLog('Failed to auto-detect document paper size', err);
    }
  }

  if (changed) {
    preview.applyConfig(currentPreviewConfig());
  }
}

async function loadPreview(): Promise<void> {
  previewLog('loadPreview() start', {
    mode,
    sessionId: sessionId ?? null,
    selectedFile: selectedFile ?? null,
    selectedDocumentId: selectedDocumentId ?? null,
  });
  if (mode === 'copy') {
    const copyPreview = copyPreviewPath;
    if (!copyPreview) return;

    const url = `/api/scan/preview/${encodeURIComponent(copyPreview)}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return;
      const buf = await resp.arrayBuffer();
      await preview.loadFromBuffer(buf, 'application/pdf');
      await applyDocumentAutoDetection();
    } catch {
      // Preview not critical for copy mode
    }

    try {
      const analysisResp = await fetch(
        `/api/scan/color-analysis/${encodeURIComponent(copyPreview)}`,
      );
      if (analysisResp.ok) {
        const { isGrayscale } = (await analysisResp.json()) as {
          isGrayscale: boolean;
        };
        if (isGrayscale) {
          resetColorLock(); // ensure clean state
          lockColorMode();
        }
      }
    } catch {
      // non-fatal
    }

    if (footerSummary)
      footerSummary.textContent =
        'Copy preview loaded — adjust settings above.';
    return;
  }

  if (mode === 'scan') {
    if (!scanFilename) {
      previewLog('loadPreview() scan mode - no scanFilename');
      return;
    }

    const url = `/api/scan/preview/${encodeURIComponent(scanFilename)}`;
    previewLog('loadPreview() scan mode - loading', { url });
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) {
        previewLog('loadPreview() scan mode - HTTP error', {
          status: resp.status,
          statusText: resp.statusText,
        });
        return;
      }
      let mime = (resp.headers.get('Content-Type') ?? '').toLowerCase();
      previewLog('loadPreview() scan mode - content type', { mime });

      if (!mime || mime === '' || mime === 'application/octet-stream') {
        const ext = scanFilename.toLowerCase().split('.').pop() || '';
        if (ext === 'pdf') mime = 'application/pdf';
        else if (['jpg', 'jpeg'].includes(ext)) mime = 'image/jpeg';
        else if (ext === 'png') mime = 'image/png';
      }

      const buf = await resp.arrayBuffer();
      await preview.loadFromBuffer(buf, mime || 'application/octet-stream');
      await applyDocumentAutoDetection();
    } catch (err) {
      previewLog('loadPreview() scan mode - exception', err);
    }

    updateSummary();
    return;
  }

  if (mode !== 'print') {
    return;
  }

  if (!sessionId) {
    const text = document.getElementById('placeholderText');
    if (text) text.textContent = 'No session — go back to /print';
    document.getElementById('paperLoading')?.classList.add('hidden');
    return;
  }

  const filename = selectedFile ?? undefined;
  const previewPromise = preview.load(sessionId, filename);

  if (shouldPreparePreviewInBackground(filename)) {
    void previewPromise.then(async () => {
      await applyDocumentAutoDetection();
      syncPageRangeAvailability();
      clampSinglePage();
      updateSummary();
    });
    void applyColorAnalysis(sessionId, selectedFile);
    syncPageRangeAvailability();
    clampSinglePage();
    updateSummary();
    void refreshPrintQuote();
    return;
  }

  await previewPromise;
  await applyDocumentAutoDetection();
  if (sessionId) await applyColorAnalysis(sessionId, selectedFile);
  syncPageRangeAvailability();
  clampSinglePage();
  updateSummary();
  await refreshPrintQuote();
}

function restoreContinueAfterPreparation(): void {
  if (mode === 'print') {
    setPrintContinueState();
    return;
  }

  if (mode === 'copy') {
    setContinueEnabled(Boolean(copyPreviewPath));
    return;
  }

  setContinueEnabled(scanFilename.length > 0);
}

function lockColorMode(): void {
  const grayRadio = document.querySelector<HTMLInputElement>(
    'input[name="colorMode"][value="grayscale"]',
  );
  if (grayRadio) {
    grayRadio.checked = true;
    grayRadio.dispatchEvent(new Event('change', { bubbles: true }));
  }

  document
    .querySelectorAll<HTMLInputElement>('input[name="colorMode"]')
    .forEach((radio) => {
      radio.disabled = true;
      radio
        .closest<HTMLElement>('.option-card')
        ?.setAttribute('data-locked', 'true');
    });

  const colorGroup = document.querySelector<HTMLElement>(
    '.option-group:has(input[name="colorMode"])',
  );
  if (colorGroup && !colorGroup.querySelector('.color-lock-notice')) {
    const notice = document.createElement('p');
    notice.className = 'color-lock-notice';
    notice.textContent =
      'Color printing is unavailable — this document contains only grayscale content.';
    colorGroup.appendChild(notice);
  }
}

function resetColorLock(): void {
  document
    .querySelectorAll<HTMLInputElement>('input[name="colorMode"]')
    .forEach((radio) => {
      radio.disabled = false;
      radio
        .closest<HTMLElement>('.option-card')
        ?.removeAttribute('data-locked');
    });

  document.querySelector('.color-lock-notice')?.remove();
}

async function applyColorAnalysis(
  sessionId: string,
  filename?: string | null,
): Promise<void> {
  resetColorLock();
  detectedColorMode = null;

  const analysisParams = new URLSearchParams();
  if (filename) analysisParams.set('filename', filename);
  if (sessionToken) analysisParams.set('token', sessionToken);
  const analysisQuery = analysisParams.toString();
  let url = `/api/wireless/sessions/${encodeURIComponent(sessionId)}/color-analysis`;
  if (analysisQuery) url += `?${analysisQuery}`;

  try {
    const resp = await fetchWithTimeout(url, 10_000);
    if (!resp.ok) return;

    const { isGrayscale } = (await resp.json()) as { isGrayscale: boolean };
    detectedColorMode = isGrayscale ? 'grayscale' : 'colored';
    if (!isGrayscale) return;

    const grayRadio = document.querySelector<HTMLInputElement>(
      'input[name="colorMode"][value="grayscale"]',
    );
    if (grayRadio) {
      grayRadio.checked = true;
      grayRadio.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch {
    detectedColorMode = null;
  }
}

continueBtn?.addEventListener('click', () => {
  if (mode === 'print' && !sessionId) return;
  if (mode === 'print' && !currentPrintQuote) return;
  if (mode === 'copy' && !copyPreviewPath) return;
  if (mode === 'scan' && !scanFilename) return;

  const cfg = currentPreviewConfig();
  const config: PrintConfig = {
    scaling: cfg.scaling,
    mode,
    sessionId: mode === 'scan' ? null : sessionId,
    documentId: mode === 'print' ? selectedDocumentId : null,
    filename: mode === 'scan' ? scanFilename : selectedFile,
    scanFilename: mode === 'scan' ? scanFilename : null,
    scanReleaseToken: mode === 'scan' ? scanReleaseToken : null,
    copyPreviewPath: mode === 'copy' ? copyPreviewPath : null,
    copyPreviewReleaseToken: mode === 'copy' ? copyPreviewReleaseToken : null,
    detectedColorMode: mode === 'print' ? detectedColorMode : null,
    colorMode: cfg.colorMode,
    quality: getSelectedQuality(),
    duplex: false,
    copies: mode === 'scan' ? 1 : getCopies(),
    orientation: cfg.orientation,
    rotationDeg: cfg.rotationDeg,
    paperSize: cfg.paperSize,
    pageRange: mode === 'scan' ? { type: 'all' } : getPageRange(),
    totalPages: preview.pageCount,
    quote: mode === 'scan' ? undefined : (currentPrintQuote ?? undefined),
  };

  sessionStorage.setItem('printbit.mode', mode);
  if (sessionId) sessionStorage.setItem('printbit.sessionId', sessionId);
  else sessionStorage.removeItem('printbit.sessionId');
  if (sessionToken)
    sessionStorage.setItem('printbit.sessionToken', sessionToken);
  else sessionStorage.removeItem('printbit.sessionToken');
  if (selectedFile)
    sessionStorage.setItem('printbit.uploadedFile', selectedFile);
  else sessionStorage.removeItem('printbit.uploadedFile');
  if (selectedDocumentId)
    sessionStorage.setItem('printbit.uploadedDocumentId', selectedDocumentId);
  else sessionStorage.removeItem('printbit.uploadedDocumentId');
  sessionStorage.setItem('printbit.config', JSON.stringify(config));

  navigateWithKioskMotion('/confirm');
});

async function prepareDocumentPreview(): Promise<void> {
  preparationLoading.start('Preparing document');

  const isNonPdfPrintDocument =
    mode === 'print' &&
    typeof selectedFile === 'string' &&
    selectedFile.trim().length > 0 &&
    !selectedFile.toLowerCase().endsWith('.pdf');

  if (mode === 'copy') {
    preparationLoading.setMessage(
      'Preparing copy preview',
      'Loading the scanned pages…',
    );
  } else if (mode === 'scan') {
    preparationLoading.setMessage(
      'Preparing scan preview',
      'Loading your scanned document…',
    );
  } else if (isNonPdfPrintDocument) {
    preparationLoading.setMessage(
      'Converting document',
      'Converting document to PDF for preview and printing...',
    );
  } else {
    preparationLoading.setMessage(
      'Analyzing document',
      'Checking pages, color, and orientation…',
    );
  }

  try {
    await loadPreview();
    restoreContinueAfterPreparation();
  } catch (error) {
    previewLog('document preparation failed', error);
    preparationLoading.fail();
  } finally {
    preparationLoading.finish();
  }
}

window.addEventListener(
  'pagehide',
  () => {
    preparationLoading.destroy();
  },
  { once: true },
);

void prepareDocumentPreview();
