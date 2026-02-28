export {};

// ── Types ─────────────────────────────────────────────────────────────────────

type ColorMode = "colored" | "grayscale";
type Orientation = "portrait" | "landscape";
type PaperSize = "A4" | "Letter" | "Legal";

interface PrintConfig {
  mode: "print" | "copy";
  sessionId: string | null;
  filename: string | null;
  copyPreviewPath?: string | null;
  colorMode: ColorMode;
  copies: number;
  orientation: Orientation;
  paperSize: PaperSize;
}

interface PreviewConfig {
  colorMode: ColorMode;
  orientation: Orientation;
  paperSize: PaperSize;
}

// PDF.js types (loaded dynamically from /libs/pdfjs)
type PdfjsLib = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (src: string | ArrayBuffer | { data: ArrayBuffer }) => {
    promise: Promise<PDFDocumentProxy>;
  };
};

interface PDFDocumentProxy {
  numPages: number;
  getPage: (n: number) => Promise<PDFPageProxy>;
  destroy: () => void;
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

const PAPER_MM: Record<PaperSize, [number, number]> = {
  A4: [210, 297],
  Letter: [216, 279],
  Legal: [216, 356],
};

/** Return [widthPx, heightPx] of the paper sheet at 96 dpi,
 *  capped so the preview column (≤ 100%) never overflows.
 *  Portrait = narrow side first; Landscape = tall side first. */
function paperPx(size: PaperSize, orientation: Orientation): [number, number] {
  const MM_TO_PX = 96 / 25.4;
  let [wMM, hMM] = PAPER_MM[size];
  if (orientation === "landscape") [wMM, hMM] = [hMM, wMM];
  return [Math.round(wMM * MM_TO_PX), Math.round(hMM * MM_TO_PX)];
}

class PrintPreview {
  private viewport: HTMLElement;
  private sheet: HTMLElement;
  private canvas: HTMLCanvasElement;
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

  private pdfDoc: PDFDocumentProxy | null = null;
  private currentPage = 1;
  private totalPages = 1;
  private renderTask: Promise<void> | null = null;
  private resizeObserver: ResizeObserver;

  constructor() {
    this.viewport = document.getElementById("paperViewport")! as HTMLElement;
    this.sheet = document.getElementById("paperSheet")! as HTMLElement;
    this.canvas = document.getElementById(
      "previewCanvas",
    )! as HTMLCanvasElement;
    this.img = document.getElementById("previewImg")! as HTMLImageElement;
    this.iframe = document.getElementById(
      "previewFrame",
    )! as HTMLIFrameElement;
    this.placeholder = document.getElementById(
      "paperPlaceholder",
    )! as HTMLElement;
    this.loading = document.getElementById("paperLoading")! as HTMLElement;
    this.controls = document.getElementById("previewControls")! as HTMLElement;
    this.hintEl = document.getElementById("previewHint")! as HTMLElement;
    this.pagerLabel = document.getElementById("pagerLabel")! as HTMLElement;
    this.pagePrev = document.getElementById("pagePrev")! as HTMLButtonElement;
    this.pageNext = document.getElementById("pageNext")! as HTMLButtonElement;

    this.pagePrev.addEventListener("click", () =>
      this.goToPage(this.currentPage - 1),
    );
    this.pageNext.addEventListener("click", () =>
      this.goToPage(this.currentPage + 1),
    );

    // Observe viewport resize → refit sheet, re-render PDF / recalc HTML pages
    this.resizeObserver = new ResizeObserver(() => {
      this.resizeSheet();
      if (this.pdfDoc) void this.renderPage(this.currentPage);
      else if (this.iframe.style.display !== "none") this.recalcHtmlPages();
    });
    this.resizeObserver.observe(this.viewport);
  }

  /** Scale the paper sheet to fill the viewport while keeping aspect ratio. */
  private resizeSheet(): void {
    const pad = 48; // 24 px padding each side
    const vpW = this.viewport.clientWidth - pad;
    const vpH = this.viewport.clientHeight - pad;
    if (vpW <= 0 || vpH <= 0) return;
    const scale = Math.min(vpW / this.naturalW, vpH / this.naturalH);
    this.sheet.style.width = `${Math.floor(this.naturalW * scale)}px`;
    this.sheet.style.height = `${Math.floor(this.naturalH * scale)}px`;
  }

  applyConfig(cfg: PreviewConfig): void {
    const [w, h] = paperPx(cfg.paperSize, cfg.orientation);

    // Store natural paper dimensions for resizeSheet()
    this.naturalW = w;
    this.naturalH = h;
    this.resizeSheet();

    // Grayscale filter via data attribute → CSS handles the transition
    if (cfg.colorMode === "grayscale") {
      this.sheet.setAttribute("data-gray", "");
    } else {
      this.sheet.removeAttribute("data-gray");
    }
  }

  async load(sessionId: string): Promise<void> {
    this.iframe.onload = null; // clear any stale iframe load handler
    this.showLoading(true);
    this.showCanvas(false);
    this.showImg(false);
    this.setHint("Loading preview…");

    const url = `/api/wireless/sessions/${encodeURIComponent(sessionId)}/preview`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      this.showError("Network error — could not reach the server.");
      return;
    }

    if (!response.ok) {
      let reason = "Preview unavailable.";
      try {
        const body = (await response.json()) as {
          error?: string;
          code?: string;
        };
        if (body.code === "UNSUPPORTED_PREVIEW")
          reason = `No preview for this file type.`;
        else if (body.code === "PREVIEW_CONVERSION_FAILED")
          reason = "Conversion failed — ensure LibreOffice is installed.";
        else if (body.error) reason = body.error;
      } catch {
        /* plain text response */
      }
      this.showError(reason);
      return;
    }

    const contentType = response.headers.get("Content-Type") ?? "";

    if (contentType.startsWith("image/")) {
      await this.loadImage(url);
    } else if (contentType.includes("application/pdf")) {
      const buf = await response.arrayBuffer();
      await this.loadPdf(buf);
    } else if (contentType.includes("text/html")) {
      const html = await response.text();
      this.loadHtml(html);
    } else {
      this.showError("Unsupported preview format.");
    }
  }

  private async loadPdf(buf: ArrayBuffer): Promise<void> {
    // Destroy any existing document
    if (this.pdfDoc) {
      this.pdfDoc.destroy();
      this.pdfDoc = null;
    }

    let pdfjs: PdfjsLib;
    try {
      pdfjs = (await import("/libs/pdfjs/pdf.min.mjs"));
      pdfjs.GlobalWorkerOptions.workerSrc = "/libs/pdfjs/pdf.worker.min.mjs";
    } catch {
      this.showError("PDF renderer not loaded.");
      return;
    }

    try {
      this.pdfDoc = await pdfjs.getDocument({ data: buf }).promise;
      this.totalPages = this.pdfDoc.numPages;
      this.currentPage = 1;
      this.updatePager();
      await this.renderPage(1);
    } catch (e) {
      console.error("PDF load error:", e);
      this.showError("Could not parse PDF.");
    }
  }

  private async renderPage(pageNum: number): Promise<void> {
    if (!this.pdfDoc) return;

    // Debounce — if already rendering, skip until it completes
    if (this.renderTask) return;

    this.showLoading(true);

    const renderNow = async () => {
      try {
        const page = await this.pdfDoc!.getPage(pageNum);
        const sheetW = this.sheet.clientWidth || 595;
        const sheetH = this.sheet.clientHeight || 842;
        const baseVP = page.getViewport({ scale: 1 });

        // Scale to fit sheet, accounting for device pixel ratio for crispness
        const dpr = window.devicePixelRatio || 1;
        const scaleW = sheetW / baseVP.width;
        const scaleH = sheetH / baseVP.height;
        const scale = Math.min(scaleW, scaleH) * dpr;
        const viewport = page.getViewport({ scale });

        // Size the canvas in physical pixels; CSS sizes it to 100%/100%
        this.canvas.width = viewport.width;
        this.canvas.height = viewport.height;

        const ctx = this.canvas.getContext("2d")!;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        await page.render({ canvasContext: ctx, viewport }).promise;

        this.showCanvas(true);
        this.showImg(false);
        this.showLoading(false);
        this.setHint(`Page ${pageNum} of ${this.totalPages}`);
      } catch (e) {
        console.error("Render error:", e);
        this.showError("Render failed.");
      } finally {
        this.renderTask = null;
      }
    };

    this.renderTask = renderNow();
    await this.renderTask;
  }

  private async loadImage(url: string): Promise<void> {
    return new Promise((resolve) => {
      this.img.onload = () => {
        this.showImg(true);
        this.showCanvas(false);
        this.showLoading(false);
        this.setHint("Image preview");
        resolve();
      };
      this.img.onerror = () => {
        this.showError("Could not load image.");
        resolve();
      };
      this.img.src = url;
      this.img.style.display = "block";
    });
  }

  private async goToPage(n: number): Promise<void> {
    n = Math.max(1, Math.min(this.totalPages, n));
    if (n === this.currentPage) return;
    this.currentPage = n;
    this.updatePager();
    if (this.pdfDoc) {
      await this.renderPage(n);
    } else if (this.iframe.style.display !== "none") {
      const viewH = this.iframe.clientHeight || 1;
      this.iframe.contentWindow?.scrollTo(0, (n - 1) * viewH);
    }
  }

  private updatePager(): void {
    const multi = this.totalPages > 1;
    this.controls.style.display = multi ? "flex" : "none";
    this.pagerLabel.textContent = `${this.currentPage} / ${this.totalPages}`;
    this.pagePrev.disabled = this.currentPage <= 1;
    this.pageNext.disabled = this.currentPage >= this.totalPages;
  }

  private loadHtml(html: string): void {
    // Show frame first so its dimensions are available when onload fires
    this.showCanvas(false);
    this.showImg(false);
    this.showFrame(true);
    this.showLoading(true);
    this.iframe.onload = () => {
      this.recalcHtmlPages();
      this.showLoading(false);
      this.setHint("Document preview");
    };
    this.iframe.srcdoc = html;
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
    this.iframe.style.display = on ? "block" : "none";
    this.placeholder.classList.toggle("hidden", on);
  }

  private showLoading(on: boolean): void {
    this.loading.classList.toggle("hidden", !on);
  }

  private showCanvas(on: boolean): void {
    this.canvas.style.display = on ? "block" : "none";
    if (on) this.iframe.style.display = "none";
    this.placeholder.classList.toggle("hidden", on);
  }

  private showImg(on: boolean): void {
    this.img.style.display = on ? "block" : "none";
    if (on) {
      this.iframe.style.display = "none";
      this.placeholder.classList.add("hidden");
    }
  }

  private showError(msg: string): void {
    this.showLoading(false);
    this.showCanvas(false);
    this.showImg(false);
    this.iframe.style.display = "none";
    const text = document.getElementById("placeholderText");
    if (text) text.textContent = msg;
    this.placeholder.classList.remove("hidden");
    this.setHint(msg);
  }

  private setHint(msg: string): void {
    this.hintEl.textContent = msg;
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.pdfDoc?.destroy();
  }

  /** Load from a raw ArrayBuffer (used by copy preview) */
  async loadFromBuffer(buf: ArrayBuffer, mime: string): Promise<void> {
    if (mime === "application/pdf") {
      await this.loadPdf(buf);
    } else if (mime.startsWith("image/")) {
      const blob = new Blob([buf], { type: mime });
      const url = URL.createObjectURL(blob);
      await this.loadImage(url);
    } else {
      this.showError("Unsupported preview format.");
    }
  }
}

const params = new URLSearchParams(window.location.search);
const mode =
  (params.get("mode") as "print" | "copy" | null) ??
  (sessionStorage.getItem("printbit.mode") as "print" | "copy" | null) ??
  "print";
const sessionId =
  params.get("sessionId") ?? sessionStorage.getItem("printbit.sessionId");
const selectedFile =
  params.get("file") ?? sessionStorage.getItem("printbit.uploadedFile");
const copyPreviewPath = sessionStorage.getItem("printbit.copyPreviewPath");

const backLink = document.getElementById(
  "backLink",
) as HTMLAnchorElement | null;
const continueBtn = document.getElementById(
  "continueBtn",
) as HTMLButtonElement | null;
const filePillLabel = document.getElementById(
  "filePillLabel",
) as HTMLElement | null;
const footerSummary = document.getElementById(
  "footerSummary",
) as HTMLElement | null;
const copiesInput = document.getElementById(
  "copies",
) as HTMLInputElement | null;
const copiesDec = document.getElementById(
  "copiesDec",
) as HTMLButtonElement | null;
const copiesInc = document.getElementById(
  "copiesInc",
) as HTMLButtonElement | null;

if (backLink) backLink.href = mode === "copy" ? "/copy" : "/print";
if (filePillLabel) filePillLabel.textContent = selectedFile ?? "—";

if (mode === "print" && continueBtn) {
  continueBtn.disabled = true;
  continueBtn.setAttribute("aria-disabled", "true");
}

if (mode === "copy" && continueBtn) {
  const hasCopyPreview = Boolean(copyPreviewPath);
  continueBtn.disabled = !hasCopyPreview;
  continueBtn.setAttribute("aria-disabled", hasCopyPreview ? "false" : "true");
  if (footerSummary)
    footerSummary.textContent = hasCopyPreview
      ? "Copy mode — checked document ready."
      : "No checked document found — go back to /copy first.";
}

function getRadio(name: string): string {
  return (
    document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)
      ?.value ?? ""
  );
}

function getCopies(): number {
  return Math.max(
    1,
    Math.min(99, parseInt(copiesInput?.value ?? "1", 10) || 1),
  );
}

function currentPreviewConfig(): PreviewConfig {
  return {
    colorMode: (getRadio("colorMode") as ColorMode) || "colored",
    orientation: (getRadio("orientation") as Orientation) || "portrait",
    paperSize: (getRadio("paperSize") as PaperSize) || "A4",
  };
}

function updateSummary(): void {
  if (!footerSummary || mode === "copy") return;
  const cfg = currentPreviewConfig();
  const n = getCopies();
  footerSummary.textContent =
    `${n} cop${n === 1 ? "y" : "ies"} · ${cfg.paperSize} · ` +
    `${cfg.orientation === "portrait" ? "Portrait" : "Landscape"} · ` +
    `${cfg.colorMode === "colored" ? "Colour" : "Grayscale"}`;
  footerSummary.classList.add("ready");
}

const preview = new PrintPreview();

preview.applyConfig(currentPreviewConfig());

document
  .querySelectorAll<HTMLInputElement>("input[type=radio]")
  .forEach((el) => {
    el.addEventListener("change", () => {
      const cfg = currentPreviewConfig();
      preview.applyConfig(cfg);
      updateSummary();
    });
  });

copiesDec?.addEventListener("click", () => {
  const v = getCopies();
  if (v > 1 && copiesInput) {
    copiesInput.value = String(v - 1);
    updateSummary();
  }
});
copiesInc?.addEventListener("click", () => {
  const v = getCopies();
  if (v < 99 && copiesInput) {
    copiesInput.value = String(v + 1);
    updateSummary();
  }
});
copiesInput?.addEventListener("change", () => {
  if (copiesInput) {
    copiesInput.value = String(getCopies());
    updateSummary();
  }
});

updateSummary();

async function loadPreview(): Promise<void> {
  if (mode === "copy") {
    const copyPreview = copyPreviewPath;
    if (!copyPreview) return;

    const url = `/api/scan/preview/${encodeURIComponent(copyPreview)}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return;
      const buf = await resp.arrayBuffer();
      await preview.loadFromBuffer(buf, "application/pdf");
    } catch {
      // Preview not critical for copy mode
    }

    if (footerSummary)
      footerSummary.textContent = "Copy preview loaded — adjust settings above.";
    return;
  }

  if (mode !== "print") return;

  if (!sessionId) {
    // Show error state in the paper placeholder
    const text = document.getElementById("placeholderText");
    if (text) text.textContent = "No session — go back to /print";
    document.getElementById("paperLoading")?.classList.add("hidden");
    return;
  }

  await preview.load(sessionId);

  // Enable continue now that preview has loaded successfully
  if (continueBtn) {
    continueBtn.disabled = false;
    continueBtn.setAttribute("aria-disabled", "false");
  }
}

continueBtn?.addEventListener("click", () => {
  if (mode === "print" && !sessionId) return;
  if (mode === "copy" && !copyPreviewPath) return;

  const cfg = currentPreviewConfig();
  const config: PrintConfig = {
    mode,
    sessionId,
    filename: selectedFile,
    copyPreviewPath: mode === "copy" ? copyPreviewPath : null,
    colorMode: cfg.colorMode,
    copies: getCopies(),
    orientation: cfg.orientation,
    paperSize: cfg.paperSize,
  };

  sessionStorage.setItem("printbit.mode", mode);
  if (sessionId) sessionStorage.setItem("printbit.sessionId", sessionId);
  if (selectedFile)
    sessionStorage.setItem("printbit.uploadedFile", selectedFile);
  sessionStorage.setItem("printbit.config", JSON.stringify(config));

  window.location.href = "/confirm";
});

void loadPreview();
