export {};

// ── DOM Elements ──────────────────────────────────────────────────────────────

const setupSection = document.getElementById("setupSection") as HTMLElement;
const scanProgressOverlay = document.getElementById("scanProgressOverlay") as HTMLElement;
const scanProgressTitle = document.getElementById("scanProgressTitle") as HTMLElement;
const scanProgressMessage = document.getElementById("scanProgressMessage") as HTMLElement;
const resultSection = document.getElementById("resultSection") as HTMLElement;
const resultSummary = document.getElementById("resultSummary") as HTMLElement;
const resultPages = document.getElementById("resultPages") as HTMLElement;
const resultFormat = document.getElementById("resultFormat") as HTMLElement;
const downloadBtn = document.getElementById("downloadBtn") as HTMLAnchorElement;
const errorSection = document.getElementById("errorSection") as HTMLElement;
const errorMessage = document.getElementById("errorMessage") as HTMLElement;

const startScanBtn = document.getElementById("startScanBtn") as HTMLButtonElement;
const cancelScanBtn = document.getElementById("cancelScanBtn") as HTMLButtonElement;
const sendToPrintBtn = document.getElementById("sendToPrintBtn") as HTMLButtonElement;
const scanAgainBtn = document.getElementById("scanAgainBtn") as HTMLButtonElement;
const retryBtn = document.getElementById("retryBtn") as HTMLButtonElement;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getRadio(name: string): string {
  return (
    document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)
      ?.value ?? ""
  );
}

let currentJobId: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── Section Visibility ────────────────────────────────────────────────────────

function showSetup(): void {
  setupSection.style.display = "";
  resultSection.style.display = "none";
  errorSection.style.display = "none";
  scanProgressOverlay.classList.remove("is-visible");
  scanProgressOverlay.setAttribute("aria-hidden", "true");
}

function showProgress(): void {
  setupSection.style.display = "none";
  resultSection.style.display = "none";
  errorSection.style.display = "none";
  scanProgressOverlay.classList.add("is-visible");
  scanProgressOverlay.setAttribute("aria-hidden", "false");
  scanProgressTitle.textContent = "Scanner is preparing...";
  scanProgressMessage.textContent = "Please wait while your document is being scanned.";
}

function showResult(pages: number, format: string, jobId: string): void {
  scanProgressOverlay.classList.remove("is-visible");
  scanProgressOverlay.setAttribute("aria-hidden", "true");
  setupSection.style.display = "none";
  errorSection.style.display = "none";
  resultSection.style.display = "";
  resultSummary.textContent = "Your document has been scanned successfully.";
  resultPages.textContent = String(pages);
  resultFormat.textContent = format.toUpperCase();
  downloadBtn.href = `/api/scan/jobs/${encodeURIComponent(jobId)}/result`;
}

function showError(msg: string): void {
  scanProgressOverlay.classList.remove("is-visible");
  scanProgressOverlay.setAttribute("aria-hidden", "true");
  setupSection.style.display = "none";
  resultSection.style.display = "none";
  errorSection.style.display = "";
  errorMessage.textContent = msg;
}

// ── Error Message Mapping ─────────────────────────────────────────────────────

function mapErrorMessage(code: string | undefined, fallback: string): string {
  switch (code) {
    case "SCANNER_BUSY":
      return "The scanner is currently busy. Please try again shortly.";
    case "SCANNER_OFFLINE":
      return "The scanner appears to be offline. Check the connection.";
    case "PAPER_JAM":
      return "Paper jam detected. Clear the jam and try again.";
    case "NO_DOCUMENT":
      return "No document detected. Place your document and try again.";
    default:
      return fallback || "Something went wrong while scanning.";
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(jobId: string, format: string): void {
  stopPolling();

  pollTimer = setInterval(async () => {
    let data: {
      state: string;
      progress?: { pagesCompleted: number; pagesTotal: number | null };
      failure?: { code: string; message: string; retryable: boolean };
    };

    try {
      const res = await fetch(`/api/scan/jobs/${encodeURIComponent(jobId)}`);
      if (!res.ok) {
        stopPolling();
        showError("Failed to check scan status.");
        return;
      }
      data = await res.json();
    } catch {
      stopPolling();
      showError("Network error while checking scan status.");
      return;
    }

    // Update progress UI
    if (data.state === "running" && data.progress && data.progress.pagesCompleted > 0) {
      scanProgressTitle.textContent = `Scanning page ${data.progress.pagesCompleted}...`;
    } else if (data.state === "running") {
      scanProgressTitle.textContent = "Scanning... please wait";
    }

    if (data.state === "succeeded") {
      stopPolling();
      showResult(data.progress?.pagesCompleted ?? 1, format, jobId);
    } else if (data.state === "failed") {
      stopPolling();
      showError(mapErrorMessage(data.failure?.code, data.failure?.message ?? "Scan failed."));
    } else if (data.state === "cancelled") {
      stopPolling();
      showSetup();
    }
  }, 1500);
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function startScan(): Promise<void> {
  const source = getRadio("source");
  const dpi = Number(getRadio("dpi"));
  const colorMode = getRadio("colorMode");
  const format = getRadio("format");

  showProgress();
  startScanBtn.disabled = true;

  try {
    const res = await fetch("/api/scan/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, dpi, colorMode, duplex: false, format }),
    });

    if (!res.ok) {
      let msg = "Could not start scan.";
      try {
        const body = await res.json();
        msg = mapErrorMessage(body.code, body.error ?? body.message ?? msg);
      } catch { /* plain text response */ }
      showError(msg);
      startScanBtn.disabled = false;
      return;
    }

    const data: { id: string } = await res.json();
    currentJobId = data.id;
    startPolling(data.id, format);
  } catch {
    showError("Network error — could not reach the server.");
  } finally {
    startScanBtn.disabled = false;
  }
}

async function cancelScan(): Promise<void> {
  stopPolling();

  if (currentJobId) {
    try {
      await fetch(`/api/scan/jobs/${encodeURIComponent(currentJobId)}/cancel`, {
        method: "POST",
      });
    } catch {
      // Best-effort cancel
    }
  }

  currentJobId = null;
  showSetup();
}

function sendToPrint(): void {
  if (!currentJobId) return;

  const format = getRadio("format") || resultFormat.textContent?.toLowerCase() || "pdf";
  const filename = `scan-${currentJobId}.${format}`;

  sessionStorage.setItem("printbit.mode", "print");
  sessionStorage.setItem("printbit.scanJobId", currentJobId);
  sessionStorage.setItem("printbit.uploadedFile", filename);

  window.location.href = "/config?mode=print";
}

function scanAgain(): void {
  currentJobId = null;
  showSetup();
}

// ── Event Listeners ───────────────────────────────────────────────────────────

startScanBtn.addEventListener("click", () => void startScan());
cancelScanBtn.addEventListener("click", () => void cancelScan());
sendToPrintBtn.addEventListener("click", sendToPrint);
scanAgainBtn.addEventListener("click", scanAgain);
retryBtn.addEventListener("click", scanAgain);
