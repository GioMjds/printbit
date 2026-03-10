import QRCode from "qrcode";

type SocketLike = {
  on: (event: string, cb: (...args: unknown[]) => void) => void;
};

const ioFactory = (
  window as unknown as { io?: (...args: unknown[]) => SocketLike }
).io;

if (typeof ioFactory === "function") {
  const socket = ioFactory();
  socket.on("balance", (amount: unknown) => {
    const el = document.getElementById("balance");
    if (el && typeof amount === "number") el.textContent = String(amount);
  });
}

function navigateTo(path: string) {
  window.location.href = path;
}

const openPrint = document.getElementById("openPrintBtn");
const openCopy = document.getElementById("openCopyBtn");
const openScan = document.getElementById("openScanBtn");
const powerOff = document.getElementById("powerOffBtn");

openPrint?.addEventListener("click", () => navigateTo("/print"));
openCopy?.addEventListener("click", () => navigateTo("/copy"));
openScan?.addEventListener("click", () => navigateTo("/scan"));

powerOff?.addEventListener("click", () => {
  const ok = confirm("Power off device?");
  if (!ok) return;
  alert("Powering off...");
});

// ── Feedback QR modal ─────────────────────────────────────────────────────────

const openFeedbackBtn = document.getElementById("openFeedbackBtn");
const feedbackOverlay = document.getElementById("feedbackOverlay");
const closeFeedbackBtn = document.getElementById("closeFeedbackBtn");
const feedbackQrCanvas = document.getElementById(
  "feedbackQrCanvas",
) as HTMLCanvasElement | null;
const feedbackModalStatus = document.getElementById("feedbackModalStatus");
const feedbackModalTimer = document.getElementById("feedbackModalTimer");
const feedbackTimerCount = document.getElementById("feedbackTimerCount");

let feedbackTimerHandle: number | null = null;

interface FeedbackSessionResponse {
  sessionId: string;
  token: string;
  feedbackUrl: string;
  expiresAt: string;
}

function setFeedbackStatus(msg: string): void {
  if (feedbackModalStatus) feedbackModalStatus.textContent = msg;
}

function openFeedbackModal(): void {
  feedbackOverlay?.classList.add("is-visible");
  feedbackOverlay?.setAttribute("aria-hidden", "false");
  void loadFeedbackSession();
}

function closeFeedbackModal(): void {
  feedbackOverlay?.classList.remove("is-visible");
  feedbackOverlay?.setAttribute("aria-hidden", "true");
  if (feedbackTimerHandle !== null) {
    clearInterval(feedbackTimerHandle);
    feedbackTimerHandle = null;
  }
  if (feedbackModalTimer) feedbackModalTimer.style.display = "none";
  if (feedbackQrCanvas) {
    const ctx = feedbackQrCanvas.getContext("2d");
    ctx?.clearRect(0, 0, feedbackQrCanvas.width, feedbackQrCanvas.height);
  }
  setFeedbackStatus("Generating QR code\u2026");
}

function startExpiryCountdown(expiresAt: string): void {
  if (feedbackModalTimer) feedbackModalTimer.style.display = "block";

  const tick = (): void => {
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      if (feedbackTimerCount) feedbackTimerCount.textContent = "0:00";
      if (feedbackTimerHandle !== null) clearInterval(feedbackTimerHandle);
      setFeedbackStatus("Session expired. Close and reopen to get a new QR code.");
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0");
    if (feedbackTimerCount) feedbackTimerCount.textContent = `${mins}:${secs}`;
  };

  tick();
  feedbackTimerHandle = window.setInterval(tick, 1000);
}

async function loadFeedbackSession(): Promise<void> {
  setFeedbackStatus("Generating QR code\u2026");
  try {
    const res = await fetch("/api/feedback/sessions", { method: "POST" });
    if (!res.ok) {
      setFeedbackStatus("Failed to create session. Please try again.");
      return;
    }
    const data = (await res.json()) as FeedbackSessionResponse;

    if (!feedbackQrCanvas) return;
    await QRCode.toCanvas(feedbackQrCanvas, data.feedbackUrl, {
      width: 220,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    });

    setFeedbackStatus(data.feedbackUrl);
    startExpiryCountdown(data.expiresAt);
  } catch {
    setFeedbackStatus("Could not generate QR code. Please try again.");
  }
}

openFeedbackBtn?.addEventListener("click", openFeedbackModal);
closeFeedbackBtn?.addEventListener("click", closeFeedbackModal);
feedbackOverlay?.addEventListener("click", (e) => {
  if (e.target === feedbackOverlay) closeFeedbackModal();
});

// ── Report QR modal ───────────────────────────────────────────────────────────

const openReportBtn = document.getElementById("openReportBtn");
const reportOverlay = document.getElementById("reportOverlay");
const closeReportBtn = document.getElementById("closeReportBtn");
const reportQrCanvas = document.getElementById(
  "reportQrCanvas",
) as HTMLCanvasElement | null;
const reportModalStatus = document.getElementById("reportModalStatus");
const reportModalTimer = document.getElementById("reportModalTimer");
const reportTimerCount = document.getElementById("reportTimerCount");

let reportTimerHandle: number | null = null;

interface ReportSessionResponse {
  sessionId: string;
  token: string;
  reportUrl: string;
  expiresAt: string;
}

function setReportStatus(msg: string): void {
  if (reportModalStatus) reportModalStatus.textContent = msg;
}

function openReportModal(): void {
  reportOverlay?.classList.add("is-visible");
  reportOverlay?.setAttribute("aria-hidden", "false");
  void loadReportSession();
}

function closeReportModal(): void {
  reportOverlay?.classList.remove("is-visible");
  reportOverlay?.setAttribute("aria-hidden", "true");
  if (reportTimerHandle !== null) {
    clearInterval(reportTimerHandle);
    reportTimerHandle = null;
  }
  if (reportModalTimer) reportModalTimer.style.display = "none";
  if (reportQrCanvas) {
    const ctx = reportQrCanvas.getContext("2d");
    ctx?.clearRect(0, 0, reportQrCanvas.width, reportQrCanvas.height);
  }
  setReportStatus("Generating QR code…");
}

function startReportExpiry(expiresAt: string): void {
  if (reportModalTimer) reportModalTimer.style.display = "block";
  const tick = (): void => {
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      clearInterval(reportTimerHandle!);
      reportTimerHandle = null;
      setReportStatus("Session expired. Close and reopen to try again.");
      if (reportModalTimer) reportModalTimer.style.display = "none";
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0");
    if (reportTimerCount) reportTimerCount.textContent = `${mins}:${secs}`;
  };
  tick();
  reportTimerHandle = window.setInterval(tick, 1000);
}

async function loadReportSession(): Promise<void> {
  setReportStatus("Generating QR code…");
  try {
    const res = await fetch("/api/report-issues/sessions", { method: "POST" });
    if (!res.ok) {
      setReportStatus("Failed to create session. Please try again.");
      return;
    }
    const data = (await res.json()) as ReportSessionResponse;

    if (!reportQrCanvas) return;
    await QRCode.toCanvas(reportQrCanvas, data.reportUrl, {
      width: 220,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    });

    setReportStatus(data.reportUrl);
    startReportExpiry(data.expiresAt);
  } catch {
    setReportStatus("Could not generate QR code. Please try again.");
  }
}

openReportBtn?.addEventListener("click", openReportModal);
closeReportBtn?.addEventListener("click", closeReportModal);
reportOverlay?.addEventListener("click", (e) => {
  if (e.target === reportOverlay) closeReportModal();
});

export { navigateTo };
