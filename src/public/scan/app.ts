export {};

type ScanSource = 'feeder' | 'glass';
type ScanColor = 'color' | 'grayscale';
type ScanDpi = '150' | '300' | '600';

interface ScanResponse {
  pages: string[];
  filename?: string;
}

interface PricingResponse {
  printPerPage: number;
  copyPerPage: number;
  scanDocument: number;
  colorSurcharge: number;
}

const previewHint = document.getElementById('previewHint') as HTMLElement;
const stateIdle = document.getElementById('stateIdle') as HTMLElement;
const stateScanning = document.getElementById('stateScanning') as HTMLElement;
const stateResult = document.getElementById('stateResult') as HTMLElement;
const stateError = document.getElementById('stateError') as HTMLElement;
const scanProgress = document.getElementById('scanProgress') as HTMLElement;
const errorText = document.getElementById('errorText') as HTMLElement;

const scannedImage = document.getElementById(
  'scannedImage',
) as HTMLImageElement;
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
const proceedBtn = document.getElementById('proceedBtn') as HTMLButtonElement;
const proceedBtnLabel = document.getElementById(
  'proceedBtnLabel',
) as HTMLElement;
const softCopyFeeText = document.getElementById(
  'softCopyFeeText',
) as HTMLElement;

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
let scanDocumentPrice = 5;

const SCAN_SOURCE: ScanSource = 'feeder';
const SCAN_COLOR: ScanColor = 'color';
const SCAN_DPI: ScanDpi = '600';

function showPreview(
  name: 'idle' | 'scanning' | 'result' | 'error',
  hint?: string,
): void {
  for (const [key, el] of Object.entries(PREVIEW_STATES)) {
    el.classList.toggle('hidden', key !== name);
  }
  if (hint !== undefined) previewHint.textContent = hint;
}

function goToPage(n: number): void {
  n = Math.max(0, Math.min(scannedPages.length - 1, n));
  currentPage = n;
  scannedImage.src = scannedPages[n];

  scannedImage.setAttribute('data-gray', '');

  const total = scannedPages.length;
  pagerLabel.textContent = `${n + 1} / ${total}`;
  pagePrev.disabled = n <= 0;
  pageNext.disabled = n >= total - 1;
  pageCountText.textContent = `${total} page${total !== 1 ? 's' : ''}`;
}

function updatePager(): void {
  const multi = scannedPages.length > 1;
  previewControls.style.display = multi ? 'flex' : 'none';
  pageCountBadge.style.display = multi ? 'inline-flex' : 'none';
  if (scannedPages.length > 0) goToPage(currentPage);
}

function formatPeso(value: number): string {
  return `₱${value.toFixed(2)}`;
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
      scanDocumentPrice = Number(payload.scanDocument.toFixed(2));
    }
  } catch {
    scanDocumentPrice = 5;
  } finally {
    updateSoftCopyPricingUi();
  }
}

async function startScan(): Promise<void> {
  showPreview('scanning', 'Scanning your document…');
  scanBtn.disabled = true;
  scanBtn.setAttribute('aria-disabled', 'true');
  rescanBtn.style.display = 'none';
  proceedBtn.style.display = 'none';
  scanProgress.textContent = 'Feeding document…';

  const progressMessages = [
    'Feeding document…',
    'Scanning page…',
    'Processing image',
    'Finalising…',
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
      }),
    });

    clearInterval(progTimer);

    const data = (await res.json()) as ScanResponse & { error?: string };
    if (!res.ok) {
      throw new Error(data.error ?? 'Scan failed');
    }

    if (!data.pages || data.pages.length === 0 || !data.filename) {
      throw new Error('No pages returned from scanner');
    }

    scannedPages = data.pages;
    scanFilename = data.filename;
    currentPage = 0;

    showPreview('result', `Page 1 of ${data.pages.length}`);
    updatePager();
    updateSoftCopyPricingUi();

    rescanBtn.style.display = 'flex';
    proceedBtn.style.display = 'flex';
    proceedBtn.disabled = false;
    proceedBtn.setAttribute('aria-disabled', 'false');
    scanBtnLabel.textContent = 'Scan Document';
  } catch (err) {
    clearInterval(progTimer);
    const msg = err instanceof Error ? err.message : 'Scan failed';
    errorText.textContent = msg;
    showPreview('error', msg);
    scanBtn.disabled = false;
    scanBtn.setAttribute('aria-disabled', 'false');
    rescanBtn.style.display = 'none';
  }
}

function resetToIdle(): void {
  scannedPages = [];
  scanFilename = null;
  currentPage = 0;

  showPreview('idle', 'Insert document into the feeder and press Scan');
  previewControls.style.display = 'none';
  pageCountBadge.style.display = 'none';
  rescanBtn.style.display = 'none';
  proceedBtn.style.display = 'none';
  proceedBtn.disabled = true;

  scanBtn.disabled = false;
  scanBtn.setAttribute('aria-disabled', 'false');
  scanBtnLabel.textContent = 'Scan Document';
}

pagePrev.addEventListener('click', () => goToPage(currentPage - 1));
pageNext.addEventListener('click', () => goToPage(currentPage + 1));

scanBtn.addEventListener('click', () => {
  if (!scanBtn.disabled) void startScan();
});

rescanBtn.addEventListener('click', resetToIdle);

proceedBtn.addEventListener('click', () => {
  if (!scannedPages.length || !scanFilename) return;

  sessionStorage.setItem(
    'printbit.config',
    JSON.stringify({
      mode: 'scan',
      scanFilename,
      sessionId: null,
      colorMode: 'colored',
      copies: 1,
      orientation: 'portrait',
      paperSize: 'A4',
    }),
  );
  window.location.href = '/confirm';
});

void loadPricing();
showPreview('idle', 'Insert document into the feeder and press Scan');
scanBtn.disabled = false;
scanBtn.setAttribute('aria-disabled', 'false');
