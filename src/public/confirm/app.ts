export {};

type SocketLike = {
  on: (event: string, cb: (...args: unknown[]) => void) => void;
};

type ConfirmConfig = {
  mode: "print" | "copy";
  sessionId: string | null;
  colorMode: "colored" | "grayscale";
  copies: number;
  orientation: "portrait" | "landscape";
  paperSize: "A4" | "Letter" | "Legal";
};

type PricingResponse = {
  printPerPage: number;
  copyPerPage: number;
  colorSurcharge: number;
};

const modeValue = document.getElementById("modeValue");
const fileValue = document.getElementById("fileValue");
const colorValue = document.getElementById("colorValue");
const copiesValue = document.getElementById("copiesValue");
const orientationValue = document.getElementById("orientationValue");
const paperSizeValue = document.getElementById("paperSizeValue");
const priceValue = document.getElementById("priceValue");
const balanceValue = document.getElementById("balanceValue");
const statusMessage = document.getElementById("statusMessage");
const coinEventMessage = document.getElementById("coinEventMessage");
const confirmBtn = document.getElementById("confirmBtn") as HTMLButtonElement;
const resetBalanceBtn = document.getElementById(
  "resetBalanceBtn",
) as HTMLButtonElement;

const rawConfig = sessionStorage.getItem("printbit.config");
const uploadedFile = sessionStorage.getItem("printbit.uploadedFile");
const DEFAULT_PRICING: PricingResponse = {
  printPerPage: 5,
  copyPerPage: 3,
  colorSurcharge: 2,
};
let totalPrice = 0;
let pricingLoaded = false;

if (!rawConfig) {
  window.location.href = "/config";
  throw new Error("Missing print configuration");
}

const config = JSON.parse(rawConfig ?? "{}") as ConfirmConfig;

function calculateTotalPrice(pricing: PricingResponse): number {
  const base = config.mode === "copy" ? pricing.copyPerPage : pricing.printPerPage;
  const color = config.colorMode === "colored" ? pricing.colorSurcharge : 0;
  return Number(((base + color) * Math.max(1, config.copies)).toFixed(2));
}

if (confirmBtn) {
  confirmBtn.textContent =
    config.mode === "print" ? "Confirm & Print" : "Confirm & Copy";
}

const modalConfirmBtnSpan = document.querySelector("#modalConfirmBtn span");
if (modalConfirmBtnSpan) {
  modalConfirmBtnSpan.textContent = config.mode === "print" ? "Yes, Print" : "Yes, Copy";
}

if (modeValue) modeValue.textContent = config.mode.toUpperCase();
if (fileValue)
  fileValue.textContent =
    config.mode === "print"
      ? (uploadedFile ?? "No uploaded file")
      : "Physical document copy";
if (colorValue) colorValue.textContent = config.colorMode;
if (copiesValue) copiesValue.textContent = String(config.copies);
if (orientationValue) orientationValue.textContent = config.orientation;
if (paperSizeValue) paperSizeValue.textContent = config.paperSize;
if (priceValue) priceValue.textContent = "Loading...";

function updateBalanceUI(balance: number): void {
  if (balanceValue) balanceValue.textContent = `₱ ${balance.toFixed(2)}`;
  if (!statusMessage || !confirmBtn) return;
  if (!pricingLoaded) {
    statusMessage.textContent = "Loading pricing...";
    confirmBtn.disabled = true;
    confirmBtn.setAttribute("aria-disabled", "true");
    return;
  }

  if (balance >= totalPrice) {
    statusMessage.textContent =
      "Sufficient balance detected. You can confirm now.";
    confirmBtn.disabled = false;
    confirmBtn.setAttribute("aria-disabled", "false");
  } else {
    const needed = totalPrice - balance;
    statusMessage.textContent = `Insert more coins: ₱ ${needed.toFixed(2)} remaining.`;
    confirmBtn.disabled = true;
    confirmBtn.setAttribute("aria-disabled", "true");
  }
}

function setCoinEventMessage(message: string): void {
  if (coinEventMessage) coinEventMessage.textContent = message;
}

async function fetchInitialBalance(): Promise<void> {
  const response = await fetch("/api/balance");
  const data = (await response.json()) as { balance: number };
  updateBalanceUI(data.balance ?? 0);
}

async function loadPricing(): Promise<void> {
  let pricing = DEFAULT_PRICING;

  try {
    const response = await fetch("/api/pricing");
    if (!response.ok) throw new Error("Pricing request failed.");

    const payload = (await response.json()) as Partial<PricingResponse>;
    const safePrint =
      typeof payload.printPerPage === "number" && Number.isFinite(payload.printPerPage)
        ? payload.printPerPage
        : DEFAULT_PRICING.printPerPage;
    const safeCopy =
      typeof payload.copyPerPage === "number" && Number.isFinite(payload.copyPerPage)
        ? payload.copyPerPage
        : DEFAULT_PRICING.copyPerPage;
    const safeColor =
      typeof payload.colorSurcharge === "number" && Number.isFinite(payload.colorSurcharge)
        ? payload.colorSurcharge
        : DEFAULT_PRICING.colorSurcharge;

    pricing = {
      printPerPage: safePrint,
      copyPerPage: safeCopy,
      colorSurcharge: safeColor,
    };
  } catch {
    // Keep kiosk usable with safe defaults if admin pricing endpoint is unavailable.
  }

  totalPrice = calculateTotalPrice(pricing);
  pricingLoaded = true;
  if (priceValue) priceValue.textContent = `₱ ${totalPrice.toFixed(2)}`;
}

async function resetBalanceForTesting(): Promise<void> {
  if (!resetBalanceBtn) return;
  resetBalanceBtn.disabled = true;
  if (statusMessage) statusMessage.textContent = "Resetting coin balance...";

  const response = await fetch("/api/balance/reset", { method: "POST" });
  const payload = (await response.json()) as {
    balance?: number;
    error?: string;
  };

  if (!response.ok) {
    if (statusMessage)
      statusMessage.textContent = payload.error ?? "Failed to reset balance.";
    resetBalanceBtn.disabled = false;
    return;
  }

  updateBalanceUI(payload.balance ?? 0);
  if (statusMessage)
    statusMessage.textContent =
      "Coin balance reset to ₱ 0.00 (testing mode).";
  setCoinEventMessage("Balance reset manually for testing.");
  resetBalanceBtn.disabled = false;
}

const confirmModal = document.getElementById("confirmModal");
const modalCancelBtn = document.getElementById("modalCancelBtn") as HTMLButtonElement;
const modalConfirmBtn = document.getElementById("modalConfirmBtn") as HTMLButtonElement;
const modalFile = document.getElementById("modalFile");
const modalMode = document.getElementById("modalMode");
const modalColor = document.getElementById("modalColor");
const modalCopies = document.getElementById("modalCopies");
const modalOrientation = document.getElementById("modalOrientation");
const modalPaper = document.getElementById("modalPaper");
const modalPrice = document.getElementById("modalPrice");
const printingOverlay = document.getElementById("printingOverlay");
const thankYouOverlay = document.getElementById("thankYouOverlay");
const thankYouDoneBtn = document.getElementById("thankYouDoneBtn") as HTMLButtonElement;

function showModal(): void {
  if (!confirmModal) return;
  if (modalFile) modalFile.textContent = config.mode === "print"
    ? (uploadedFile ?? "No file")
    : "Physical document copy";
  if (modalMode) modalMode.textContent = config.mode.toUpperCase();
  if (modalColor) modalColor.textContent = config.colorMode;
  if (modalCopies) modalCopies.textContent = String(config.copies);
  if (modalOrientation) modalOrientation.textContent = config.orientation;
  if (modalPaper) modalPaper.textContent = config.paperSize;
  if (modalPrice) modalPrice.textContent = `₱ ${totalPrice.toFixed(2)}`;
  confirmModal.classList.add("is-visible");
  confirmModal.setAttribute("aria-hidden", "false");
}

function hideModal(): void {
  if (!confirmModal) return;
  confirmModal.classList.remove("is-visible");
  confirmModal.setAttribute("aria-hidden", "true");
}

function showOverlay(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.add("is-visible");
  el.setAttribute("aria-hidden", "false");
}

function hideOverlay(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.remove("is-visible");
  el.setAttribute("aria-hidden", "true");
}

confirmBtn?.addEventListener("click", () => {
  showModal();
});

modalCancelBtn?.addEventListener("click", () => {
  hideModal();
});

modalConfirmBtn?.addEventListener("click", async () => {
  modalConfirmBtn.disabled = true;
  hideModal();
  confirmBtn.disabled = true;

  showOverlay(printingOverlay);
  const MIN_OVERLAY_MS = 3_000;
  const overlayStart = Date.now();

  if (config.mode === "copy") {
    // Copy flow: create copy job and poll
    if (statusMessage) statusMessage.textContent = "Starting copy job...";

    try {
      const createRes = await fetch("/api/copy/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          copies: config.copies,
          colorMode: config.colorMode,
          orientation: config.orientation,
          paperSize: config.paperSize,
          amount: totalPrice,
        }),
      });

      if (!createRes.ok) {
        const payload = (await createRes.json()) as { error?: string };
        hideOverlay(printingOverlay);
        if (statusMessage) statusMessage.textContent = payload.error ?? "Failed to start copy job.";
        confirmBtn.disabled = false;
        modalConfirmBtn.disabled = false;
        return;
      }

      const createData = (await createRes.json()) as { id: string; state: string };
      const jobId = createData.id;

      // Poll job status
      const pollResult = await pollCopyJob(jobId);

      const remaining = MIN_OVERLAY_MS - (Date.now() - overlayStart);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      hideOverlay(printingOverlay);

      if (pollResult === "succeeded") {
        showOverlay(thankYouOverlay);
        if (statusMessage) statusMessage.textContent = "Your copies are ready!";
        sessionStorage.removeItem("printbit.config");
        sessionStorage.removeItem("printbit.uploadedFile");
        sessionStorage.removeItem("printbit.sessionId");
      } else if (pollResult === "failed") {
        if (statusMessage) statusMessage.textContent = "Copy job failed. Please try again.";
        confirmBtn.disabled = false;
        modalConfirmBtn.disabled = false;
      } else {
        if (statusMessage) statusMessage.textContent = "Copy was cancelled.";
        confirmBtn.disabled = false;
        modalConfirmBtn.disabled = false;
      }
    } catch {
      hideOverlay(printingOverlay);
      if (statusMessage) statusMessage.textContent = "Network error during copy job.";
      confirmBtn.disabled = false;
      modalConfirmBtn.disabled = false;
    }
  } else {
    // Print flow: existing behavior
    if (statusMessage) statusMessage.textContent = "Sending to printer…";

    const response = await fetch("/api/confirm-payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: totalPrice,
        mode: config.mode,
        sessionId: config.sessionId,
        copies: config.copies,
        colorMode: config.colorMode,
        orientation: config.orientation,
        paperSize: config.paperSize,
      }),
    });

    if (!response.ok) {
      hideOverlay(printingOverlay);
      const payload = (await response.json()) as { error?: string };
      if (statusMessage)
        statusMessage.textContent =
          payload.error ?? "Payment confirmation failed.";
      confirmBtn.disabled = false;
      modalConfirmBtn.disabled = false;
      return;
    }

    // Brief "Document sent!" confirmation before transitioning
    if (statusMessage) statusMessage.textContent = "Document sent to printer!";

    // Ensure the printing overlay is visible for at least MIN_OVERLAY_MS
    const remaining = MIN_OVERLAY_MS - (Date.now() - overlayStart);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));

    hideOverlay(printingOverlay);

    // Show thank-you overlay
    showOverlay(thankYouOverlay);

    if (statusMessage) {
      statusMessage.textContent = "Your document has been sent to the printer!";
    }
    sessionStorage.removeItem("printbit.config");
    sessionStorage.removeItem("printbit.uploadedFile");
    sessionStorage.removeItem("printbit.sessionId");
  }
});

async function pollCopyJob(jobId: string): Promise<string> {
  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/copy/jobs/${encodeURIComponent(jobId)}`);
        if (!res.ok) { clearInterval(interval); resolve("failed"); return; }
        const data = (await res.json()) as {
          state: string; progress?: { pagesCompleted: number; pagesTotal: number | null }
        };
        const { state, progress } = data;

        if (state === "queued" && statusMessage) {
          statusMessage.textContent = "Preparing scanner and feeder...";
        } else if (state === "running" && statusMessage) {
          if (progress && progress.pagesTotal) {
            statusMessage.textContent = `Copying page ${progress.pagesCompleted} of ${progress.pagesTotal}...`;
          } else {
            statusMessage.textContent = "Copying... please wait.";
          }
        }

        if (state === "succeeded" || state === "failed" || state === "cancelled") {
          clearInterval(interval);
          resolve(state);
        }
      } catch {
        clearInterval(interval);
        resolve("failed");
      }
    }, 1500);
  });
}

thankYouDoneBtn?.addEventListener("click", () => {
  hideOverlay(thankYouOverlay);
  window.location.href = "/";
});

resetBalanceBtn?.addEventListener("click", () => {
  void resetBalanceForTesting();
});

async function insertTestCoin(value: number): Promise<void> {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".coin-btn");
  buttons.forEach((b) => (b.disabled = true));

  try {
    const response = await fetch("/api/balance/add-test-coin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });

    const payload = (await response.json()) as { balance?: number; error?: string };
    if (!response.ok) {
      setCoinEventMessage(payload.error ?? "Failed to insert coin.");
    }
  } catch {
    setCoinEventMessage("Network error inserting test coin.");
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

document.querySelectorAll<HTMLButtonElement>(".coin-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const value = parseInt(btn.dataset.value ?? "0", 10);
    if (value > 0) void insertTestCoin(value);
  });
});

const ioFactory = (
  window as unknown as { io?: (...args: unknown[]) => SocketLike }
).io;

if (typeof ioFactory === "function") {
  const socket = ioFactory();
  socket.on("balance", (amount: unknown) => {
    if (typeof amount === "number") {
      updateBalanceUI(amount);
    }
  });

  socket.on("coinAccepted", (payload: unknown) => {
    if (
      payload &&
      typeof payload === "object" &&
      "value" in payload &&
      typeof (payload as { value: unknown }).value === "number"
    ) {
      const value = (payload as { value: number }).value;
      setCoinEventMessage(`Last accepted coin: ₱ ${value.toFixed(2)}`);
    }
  });

  socket.on("coinParserWarning", (payload: unknown) => {
    if (
      payload &&
      typeof payload === "object" &&
      "message" in payload &&
      typeof (payload as { message: unknown }).message === "string"
    ) {
      setCoinEventMessage(
        `Serial note: ${(payload as { message: string }).message}`,
      );
    }
  });
}

async function boot(): Promise<void> {
  await loadPricing();
  await fetchInitialBalance();
}

void boot();
