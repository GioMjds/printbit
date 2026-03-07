import QRCode from "qrcode";

export {};

type ScannerState = "checking" | "ready" | "scanning" | "done" | "error";
type ScanSource = "feeder" | "glass";
type ScanColor = "color" | "grayscale";
type ScanDpi = "150" | "300" | "600";
type DeliveryMode = "wired" | "wireless";

interface ScanStatusResponse {
  connected: boolean;
  name?: string;
  error?: string;
}

interface ScanResponse {
  pages: string[];
  filename?: string;
}

interface RemovableDrive {
  drive: string;
  label: string | null;
  freeBytes: number;
  totalBytes: number;
}

interface DrivesResponse {
  drives: RemovableDrive[];
  error?: string;
}

interface WirelessLinkResponse {
  token: string;
  downloadUrl: string;
  expiresAt: string;
  error?: string;
}

interface PricingResponse {
  printPerPage: number;
  copyPerPage: number;
  scanDocument: number;
  colorSurcharge: number;
}

interface SoftCopyChargeResponse {
  ok?: boolean;
  charged?: boolean;
  alreadyPaid?: boolean;
  requiredAmount?: number;
  error?: string;
}

const scannerPill = document.getElementById("scannerPill") as HTMLElement;
const scannerPillText = document.getElementById(
  "scannerPillText",
) as HTMLElement;
const scannerStatusCard = document.getElementById(
  "scannerStatusCard",
) as HTMLElement;
const scannerStatusLabel = document.getElementById(
  "scannerStatusLabel",
) as HTMLElement;
const scannerStatusDetail = document.getElementById(
  "scannerStatusDetail",
) as HTMLElement;

const previewHint = document.getElementById("previewHint") as HTMLElement;
const stateIdle = document.getElementById("stateIdle") as HTMLElement;
const stateScanning = document.getElementById("stateScanning") as HTMLElement;
const stateResult = document.getElementById("stateResult") as HTMLElement;
const stateError = document.getElementById("stateError") as HTMLElement;
const scanProgress = document.getElementById("scanProgress") as HTMLElement;
const errorText = document.getElementById("errorText") as HTMLElement;

const scannedImage = document.getElementById(
  "scannedImage",
) as HTMLImageElement;
const pageCountBadge = document.getElementById("pageCountBadge") as HTMLElement;
const pageCountText = document.getElementById("pageCountText") as HTMLElement;

const previewControls = document.getElementById(
  "previewControls",
) as HTMLElement;
const pagePrev = document.getElementById("pagePrev") as HTMLButtonElement;
const pageNext = document.getElementById("pageNext") as HTMLButtonElement;
const pagerLabel = document.getElementById("pagerLabel") as HTMLElement;

const scanBtn = document.getElementById("scanBtn") as HTMLButtonElement;
const scanBtnLabel = document.getElementById("scanBtnLabel") as HTMLElement;
const rescanBtn = document.getElementById("rescanBtn") as HTMLButtonElement;
const proceedBtn = document.getElementById("proceedBtn") as HTMLButtonElement;
const proceedBtnLabel = document.getElementById(
  "proceedBtnLabel",
) as HTMLElement;
const softCopyFeeText = document.getElementById(
  "softCopyFeeText",
) as HTMLElement;

const deliveryPanel = document.getElementById("deliveryPanel") as HTMLElement;
const wiredDeliveryCard = document.getElementById(
  "wiredDeliveryCard",
) as HTMLElement;
const wirelessDeliveryCard = document.getElementById(
  "wirelessDeliveryCard",
) as HTMLElement;
const driveSelect = document.getElementById("driveSelect") as HTMLSelectElement;
const refreshDrivesBtn = document.getElementById(
  "refreshDrivesBtn",
) as HTMLButtonElement;
const exportUsbBtn = document.getElementById(
  "exportUsbBtn",
) as HTMLButtonElement;
const wiredStatusText = document.getElementById(
  "wiredStatusText",
) as HTMLElement;
const wirelessQrCanvas = document.getElementById(
  "wirelessQrCanvas",
) as HTMLCanvasElement;
const wirelessDownloadLink = document.getElementById(
  "wirelessDownloadLink",
) as HTMLAnchorElement;
const refreshWirelessLinkBtn = document.getElementById(
  "refreshWirelessLinkBtn",
) as HTMLButtonElement;
const wirelessStatusText = document.getElementById(
  "wirelessStatusText",
) as HTMLElement;

const PREVIEW_STATES: Record<
  "idle" | "scanning" | "result" | "error",
  HTMLElement
> = {
  idle: stateIdle,
  scanning: stateScanning,
  result: stateResult,
  error: stateError,
};

let scannerReady = false;
let scannedPages: string[] = [];
let currentPage = 0;
let scanFilename: string | null = null;
let wirelessLinkCache: { filename: string; link: WirelessLinkResponse } | null =
  null;
let paidSoftCopyFilename: string;
let scanDocumentPrice = 5;

function getRadio<T extends string>(name: string): T {
  return document.querySelector<HTMLInputElement>(
    `input[name="${name}"]:checked`,
  )?.value as T;
}

function getScanSource(): ScanSource {
  return getRadio<ScanSource>("scanSource") || "feeder";
}

function getScanColor(): ScanColor {
  return getRadio<ScanColor>("scanColor") || "color";
}

function getScanDpi(): ScanDpi {
  return getRadio<ScanDpi>("scanDpi") || "300";
}

function getDeliveryMode(): DeliveryMode {
  return getRadio<DeliveryMode>("scanDelivery") || "wireless";
}

function applyState(state: ScannerState): void {
  scannerPill.dataset.state = state;
  scannerStatusCard.dataset.state = state;

  const labels: Record<ScannerState, [string, string, string]> = {
    checking: ["Checking scanner…", "Please wait", "Checking…"],
    ready: ["Scanner Ready", "Place document and scan", "Ready"],
    scanning: ["Scanning…", "Do not move document", "Scanning…"],
    done: ["Scan Complete", "Review your document below", "Done"],
    error: ["Scanner Unavailable", "Check USB connection", "Error"],
  };

  const [cardTitle, cardDetail, pillText] = labels[state];
  scannerStatusLabel.textContent = cardTitle;
  scannerStatusDetail.textContent = cardDetail;
  scannerPillText.textContent = pillText;
}

function showPreview(
  name: "idle" | "scanning" | "result" | "error",
  hint?: string,
): void {
  for (const [key, el] of Object.entries(PREVIEW_STATES)) {
    el.classList.toggle("hidden", key !== name);
  }
  if (hint !== undefined) previewHint.textContent = hint;
}

function goToPage(n: number): void {
  n = Math.max(0, Math.min(scannedPages.length - 1, n));
  currentPage = n;
  scannedImage.src = scannedPages[n];

  if (getScanColor() === "grayscale") {
    scannedImage.setAttribute("data-gray", "");
  } else {
    scannedImage.removeAttribute("data-gray");
  }

  const total = scannedPages.length;
  pagerLabel.textContent = `${n + 1} / ${total}`;
  pagePrev.disabled = n <= 0;
  pageNext.disabled = n >= total - 1;
  pageCountText.textContent = `${total} page${total !== 1 ? "s" : ""}`;
}

function updatePager(): void {
  const multi = scannedPages.length > 1;
  previewControls.style.display = multi ? "flex" : "none";
  pageCountBadge.style.display = multi ? "inline-flex" : "none";
  if (scannedPages.length > 0) goToPage(currentPage);
}

function clearDeliveryMessages(): void {
  wiredStatusText.textContent = "";
  wirelessStatusText.textContent = "";
}

function formatPeso(value: number): string {
  return `₱${value.toFixed(2)}`;
}

function updateSoftCopyPricingUi(): void {
  proceedBtnLabel.textContent = `Get Soft Copy (${formatPeso(scanDocumentPrice)})`;
  softCopyFeeText.textContent = `A fee of ${formatPeso(scanDocumentPrice)} applies for soft copy access. You can pay at the kiosk or via the wireless link.`;
}

async function loadPricing(): Promise<void> {
  try {
    const response = await fetch("/api/pricing");
    if (!response.ok) throw new Error("Failed to load pricing information.");

    const payload = (await response.json()) as Partial<PricingResponse>;
    if (
      typeof payload.scanDocument === "number" &&
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

async function ensureSoftCopyPaid(filename: string): Promise<boolean> {
  if (!scanFilename) return false;
  if (paidSoftCopyFilename === scanFilename) return true;

  proceedBtn.disabled = true;
  proceedBtn.setAttribute("aria-disabled", "true");
  proceedBtnLabel.textContent = "Checking payment...";

  try {
    const response = await fetch("/api/scanner/soft-copy/charge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: scanFilename }),
    });

    const data = (await response.json()) as SoftCopyChargeResponse;
    if (!response.ok || data.ok === false) {
      throw new Error(data.error ?? "Unable to process soft-copy payment.");
    }

    if (
      typeof data.requiredAmount === "number" &&
      Number.isFinite(data.requiredAmount)
    ) {
      scanDocumentPrice = Number(data.requiredAmount.toFixed(2));
    }

    paidSoftCopyFilename = scanFilename;
    updateSoftCopyPricingUi();
    return true;
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Unable to process soft-copy payment.";
    previewHint.textContent = message;
    return false;
  } finally {
    proceedBtn.disabled = false;
    proceedBtn.setAttribute("aria-disabled", "false");
    updateSoftCopyPricingUi();
  }
}

async function checkScanner(): Promise<void> {
  applyState("checking");
  scanBtn.disabled = true;
  scanBtn.setAttribute("aria-disabled", "true");

  try {
    const res = await fetch("/api/scanner/status");
    if (!res.ok) throw new Error("Scanner API unavailable");

    const data = (await res.json()) as ScanStatusResponse;
    if (!data.connected) throw new Error(data.error ?? "No scanner found");

    applyState("ready");
    scannerStatusDetail.textContent = data.name
      ? `Connected: ${data.name}`
      : "Connected and ready";
    scannerReady = true;
    scanBtn.disabled = false;
    scanBtn.setAttribute("aria-disabled", "false");
    showPreview("idle", "Place document and press Scan");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Scanner check failed";
    applyState("error");
    errorText.textContent = msg;
    scannerStatusDetail.textContent = msg;
    scannerReady = false;
    showPreview("error", "Scanner unavailable");
  }
}

async function loadUsbDrives(): Promise<void> {
  if (!scanFilename) return;

  refreshDrivesBtn.disabled = true;
  wiredStatusText.textContent = "Checking USB drives…";
  exportUsbBtn.disabled = true;

  try {
    const res = await fetch("/api/scanner/wired/drives");
    const data = (await res.json()) as DrivesResponse;
    if (!res.ok) {
      throw new Error(data.error ?? "Failed to list USB drives.");
    }

    driveSelect.innerHTML = "";
    if (data.drives.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No USB drive detected";
      driveSelect.appendChild(option);
      wiredStatusText.textContent =
        "Insert a USB flash drive, then tap Refresh USB.";
      return;
    }

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select USB drive";
    driveSelect.appendChild(placeholder);

    for (const drive of data.drives) {
      const option = document.createElement("option");
      option.value = drive.drive;
      const freeGb = (drive.freeBytes / (1024 * 1024 * 1024)).toFixed(1);
      option.textContent = `${drive.drive} ${drive.label ? `(${drive.label})` : ""} • ${freeGb} GB free`;
      driveSelect.appendChild(option);
    }

    wiredStatusText.textContent = "Select a USB drive and tap Export to USB.";
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "USB detection failed.";
    wiredStatusText.textContent = message;
  } finally {
    refreshDrivesBtn.disabled = false;
    exportUsbBtn.disabled = !driveSelect.value;
  }
}

async function createWirelessLink(force = false): Promise<void> {
  if (!scanFilename) return;
  if (
    wirelessLinkCache &&
    wirelessLinkCache.filename === scanFilename &&
    !force
  ) {
    const cached = wirelessLinkCache.link;
    wirelessDownloadLink.href = cached.downloadUrl;
    wirelessDownloadLink.textContent = cached.downloadUrl;
    await QRCode.toCanvas(wirelessQrCanvas, cached.downloadUrl, {
      width: 180,
      margin: 1,
      color: { dark: "#1a1a2e", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
    return;
  }

  refreshWirelessLinkBtn.disabled = true;
  wirelessStatusText.textContent = "Generating secure QR link…";

  try {
    const res = await fetch("/api/scanner/wireless-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: scanFilename }),
    });
    const data = (await res.json()) as WirelessLinkResponse;
    if (!res.ok) {
      throw new Error(data.error ?? "Could not create wireless link.");
    }

    wirelessLinkCache = { filename: scanFilename, link: data };
    wirelessDownloadLink.href = data.downloadUrl;
    wirelessDownloadLink.textContent = data.downloadUrl;

    await QRCode.toCanvas(wirelessQrCanvas, data.downloadUrl, {
      width: 180,
      margin: 1,
      color: { dark: "#1a1a2e", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });

    const expiry = new Date(data.expiresAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    wirelessStatusText.textContent = `Link expires at ${expiry}.`;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to generate QR link.";
    wirelessStatusText.textContent = message;
  } finally {
    refreshWirelessLinkBtn.disabled = false;
  }
}

async function syncDeliveryPanel(): Promise<void> {
  if (!scanFilename) {
    deliveryPanel.style.display = "none";
    wiredDeliveryCard.style.display = "none";
    wirelessDeliveryCard.style.display = "none";
    return;
  }

  deliveryPanel.style.display = "flex";
  const mode = getDeliveryMode();

  if (mode === "wired") {
    wiredDeliveryCard.style.display = "flex";
    wirelessDeliveryCard.style.display = "none";
    await loadUsbDrives();
  } else {
    wirelessDeliveryCard.style.display = "flex";
    wiredDeliveryCard.style.display = "none";
    await createWirelessLink();
  }
}

async function startScan(): Promise<void> {
  if (!scannerReady) return;

  const source = getScanSource();
  const color = getScanColor();
  const dpi = getScanDpi();

  applyState("scanning");
  showPreview("scanning", "Scanning your document…");
  scanBtn.disabled = true;
  scanBtn.setAttribute("aria-disabled", "true");
  rescanBtn.style.display = "none";
  proceedBtn.style.display = "none";
  deliveryPanel.style.display = "none";
  clearDeliveryMessages();
  scanProgress.textContent =
    source === "feeder" ? "Feeding document…" : "Initialising scanner";

  const progressMessages =
    source === "feeder"
      ? [
          "Feeding document…",
          "Scanning page…",
          "Processing image",
          "Finalising…",
        ]
      : [
          "Initialising scanner",
          "Calibrating sensor",
          "Scanning page…",
          "Finalising…",
        ];
  let progIdx = 0;
  const progTimer = window.setInterval(() => {
    progIdx = Math.min(progIdx + 1, progressMessages.length - 1);
    scanProgress.textContent = progressMessages[progIdx];
  }, 1200);

  try {
    const res = await fetch("/api/scanner/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, color, dpi }),
    });

    clearInterval(progTimer);

    const data = (await res.json()) as ScanResponse & { error?: string };
    if (!res.ok) {
      throw new Error(data.error ?? "Scan failed");
    }

    if (!data.pages || data.pages.length === 0 || !data.filename) {
      throw new Error("No pages returned from scanner");
    }

    scannedPages = data.pages;
    scanFilename = data.filename;
    wirelessLinkCache = null;
    paidSoftCopyFilename = "";
    currentPage = 0;

    applyState("done");
    showPreview("result", `Page 1 of ${data.pages.length}`);
    updatePager();
    updateSoftCopyPricingUi();

    // Show rescan + "Get Soft Copy" — delivery panel only after user confirms
    rescanBtn.style.display = "flex";
    proceedBtn.style.display = "flex";
    proceedBtn.disabled = false;
    proceedBtn.setAttribute("aria-disabled", "false");
    scanBtnLabel.textContent = "Scan Document";
  } catch (err) {
    clearInterval(progTimer);
    const msg = err instanceof Error ? err.message : "Scan failed";
    applyState("error");
    errorText.textContent = msg;
    showPreview("error", msg);
    scanBtn.disabled = false;
    scanBtn.setAttribute("aria-disabled", "false");
    rescanBtn.style.display = "none";
    deliveryPanel.style.display = "none";
  }
}

function resetToIdle(): void {
  scannedPages = [];
  scanFilename = null;
  currentPage = 0;
  wirelessLinkCache = null;
  paidSoftCopyFilename = "";

  applyState("ready");
  showPreview("idle", "Place document and press Scan");
  previewControls.style.display = "none";
  pageCountBadge.style.display = "none";
  rescanBtn.style.display = "none";
  proceedBtn.style.display = "none";
  proceedBtn.disabled = true;
  deliveryPanel.style.display = "none";
  clearDeliveryMessages();

  scanBtn.disabled = false;
  scanBtn.setAttribute("aria-disabled", "false");
  scanBtnLabel.textContent = "Scan Document";
}

pagePrev.addEventListener("click", () => goToPage(currentPage - 1));
pageNext.addEventListener("click", () => goToPage(currentPage + 1));

document
  .querySelectorAll<HTMLInputElement>('input[name="scanColor"]')
  .forEach((el) => {
    el.addEventListener("change", () => {
      if (scannedPages.length > 0) goToPage(currentPage);
    });
  });

document
  .querySelectorAll<HTMLInputElement>('input[name="scanDelivery"]')
  .forEach((el) => {
    el.addEventListener("change", () => {
      if (scanFilename) void syncDeliveryPanel();
    });
  });

scanBtn.addEventListener("click", () => {
  if (!scanBtn.disabled) void startScan();
});

rescanBtn.addEventListener("click", resetToIdle);

refreshDrivesBtn.addEventListener("click", () => {
  void loadUsbDrives();
});

driveSelect.addEventListener("change", () => {
  exportUsbBtn.disabled = !driveSelect.value;
});

exportUsbBtn.addEventListener("click", async () => {
  if (!scanFilename || !driveSelect.value) return;

  exportUsbBtn.disabled = true;
  wiredStatusText.textContent = "Exporting scan to USB…";

  try {
    const res = await fetch("/api/scanner/wired/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: scanFilename,
        drive: driveSelect.value,
      }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      exportPath?: string;
      error?: string;
    };
    if (!res.ok || !data.ok) {
      throw new Error(data.error ?? "USB export failed.");
    }
    wiredStatusText.textContent = `Saved to ${data.exportPath ?? driveSelect.value}.`;
  } catch (err) {
    const message = err instanceof Error ? err.message : "USB export failed.";
    wiredStatusText.textContent = message;
  } finally {
    exportUsbBtn.disabled = !driveSelect.value;
  }
});

refreshWirelessLinkBtn.addEventListener("click", () => {
  void createWirelessLink(true);
});

proceedBtn.addEventListener("click", async () => {
  if (!scannedPages.length || !scanFilename) return;

  const paid = await ensureSoftCopyPaid(scanFilename);
  if (!paid) return;

  proceedBtn.style.display = "none";
  await syncDeliveryPanel();
});

void loadPricing();
void checkScanner();
