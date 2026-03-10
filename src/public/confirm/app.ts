import QRCode from 'qrcode';

export {};

type SocketLike = {
  on: (event: string, cb: (...args: unknown[]) => void) => void;
};

type PageRangeSelection =
  | { type: 'all' }
  | { type: 'custom'; range: string }
  | { type: 'single'; page: number };

type ConfirmConfig = {
  mode: 'print' | 'copy' | 'scan';
  sessionId: string | null;
  scanFilename?: string;
  copyPreviewPath?: string | null;
  colorMode: 'colored' | 'grayscale';
  copies: number;
  orientation: 'portrait' | 'landscape';
  paperSize: 'A4' | 'Letter' | 'Legal';
  pageRange?: PageRangeSelection;
  totalPages?: number;
};

type PricingResponse = {
  printPerPage: number;
  copyPerPage: number;
  colorSurcharge: number;
  scanDocument: number;
};

const modeValue = document.getElementById('modeValue');
const fileValue = document.getElementById('fileValue');
const colorValue = document.getElementById('colorValue');
const copiesValue = document.getElementById('copiesValue');
const pagesValue = document.getElementById('pagesValue');
const pagesRow = document.getElementById('pagesRow');
const orientationValue = document.getElementById('orientationValue');
const paperSizeValue = document.getElementById('paperSizeValue');
const priceValue = document.getElementById('priceValue');
const balanceValue = document.getElementById('balanceValue');
const changeValue = document.getElementById('changeValue');
const changeRow = document.getElementById('changeRow');
const modalChange = document.getElementById('modalChange');
const modalChangeRow = document.getElementById('modalChangeRow');
const statusMessage = document.getElementById('statusMessage');
const coinEventMessage = document.getElementById('coinToast');
const confirmBtn = document.getElementById('confirmBtn') as HTMLButtonElement;
const resetBalanceBtn = document.getElementById(
  'resetBalanceBtn',
) as HTMLButtonElement;

const rawConfig = sessionStorage.getItem('printbit.config');
const uploadedFile = sessionStorage.getItem('printbit.uploadedFile');
const DEFAULT_PRICING: PricingResponse = {
  printPerPage: 5,
  copyPerPage: 3,
  colorSurcharge: 2,
  scanDocument: 5,
};
let totalPrice = 0;
let pricingLoaded = false;
let currentBalance = 0;

if (!rawConfig) {
  const storedSessionId = sessionStorage.getItem('printbit.sessionId');
  const fallback = storedSessionId
    ? `/config?sessionId=${encodeURIComponent(storedSessionId)}`
    : '/config';
  window.location.href = fallback;
  throw new Error('Missing print configuration');
}

const config = JSON.parse(rawConfig ?? '{}') as ConfirmConfig;

// Update back link to return to the correct config page with the session
const backLink = document.getElementById(
  'backLink',
) as HTMLAnchorElement | null;
if (backLink) {
  if (config.mode === 'copy') {
    backLink.href = '/copy';
  } else if (config.mode === 'scan') {
    backLink.href = '/scan';
  } else if (config.sessionId) {
    backLink.href = `/config?sessionId=${encodeURIComponent(config.sessionId)}`;
  }
}

function pageRangeLabel(sel?: PageRangeSelection): string {
  if (!sel || sel.type === 'all') return 'All Pages';
  if (sel.type === 'single') return `Page ${sel.page}`;
  return sel.range ? `Pages ${sel.range}` : 'Pages (custom)';
}

function countPrintPages(): number {
  const total = config.totalPages ?? 1;
  const range = config.pageRange;
  if (!range || range.type === "all") return total;
  if (range.type === "single") return 1;
  let count = 0;
  for (const part of range.range.split(",")) {
    const trimmed = part.trim();
    const m = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const from = Math.max(1, parseInt(m[1], 10));
      const to = Math.min(total, parseInt(m[2], 10));
      if (from <= to) count += to - from + 1;
    } else {
      const p = parseInt(trimmed, 10);
      if (!isNaN(p) && p >= 1 && p <= total) count += 1;
    }
  }
  return Math.max(1, count);
}

function calculateTotalPrice(pricing: PricingResponse): number {
  if (config.mode === 'scan') {
    return pricing.scanDocument ?? DEFAULT_PRICING.scanDocument;
  }
  const base =
    config.mode === 'copy' ? pricing.copyPerPage : pricing.printPerPage;
  const color = config.colorMode === 'colored' ? pricing.colorSurcharge : 0;
  const pages = config.mode === "print" ? countPrintPages() : 1;
  return (base + color) * pages * Math.max(1, config.copies);
}

if (confirmBtn) {
  confirmBtn.textContent =
    config.mode === 'print'
      ? 'Confirm & Print'
      : config.mode === 'copy'
        ? 'Confirm & Copy'
        : 'Confirm & Download';
}

const modalConfirmBtnSpan = document.querySelector('#modalConfirmBtn span');
if (modalConfirmBtnSpan) {
  modalConfirmBtnSpan.textContent =
    config.mode === 'print'
      ? 'Yes, Print'
      : config.mode === 'copy'
        ? 'Yes, Copy'
        : 'Yes, Download';
}

if (config.mode === 'copy' || config.mode === 'scan') {
  pagesRow?.setAttribute('hidden', '');
}

if (config.mode === 'scan') {
  colorValue?.closest('.summary-row')?.setAttribute('hidden', '');
  copiesValue?.closest('.summary-row')?.setAttribute('hidden', '');
  orientationValue?.closest('.summary-row')?.setAttribute('hidden', '');
  paperSizeValue?.closest('.summary-row')?.setAttribute('hidden', '');
}

if (modeValue) modeValue.textContent = config.mode.toUpperCase();
if (fileValue)
  fileValue.textContent =
    config.mode === 'print'
      ? (uploadedFile ?? 'No uploaded file')
      : config.mode === 'copy'
        ? 'Physical document copy'
        : (config.scanFilename ?? 'Scanned document');
if (colorValue) colorValue.textContent = config.colorMode;
if (copiesValue) copiesValue.textContent = String(config.copies);
if (pagesValue) pagesValue.textContent = pageRangeLabel(config.pageRange);
if (orientationValue) orientationValue.textContent = config.orientation;
if (paperSizeValue) paperSizeValue.textContent = config.paperSize;
if (priceValue) priceValue.textContent = 'Loading...';

function updateChangeDisplay(balance: number): void {
  const change = balance - totalPrice;
  const hasChange = pricingLoaded && change > 0;
  if (changeRow) {
    if (hasChange) {
      changeRow.removeAttribute('hidden');
    } else {
      changeRow.setAttribute('hidden', '');
    }
  }
  if (changeValue) {
    changeValue.textContent = hasChange ? `₱ ${change}` : '—';
  }
}

function updateBalanceUI(balance: number): void {
  currentBalance = balance;
  if (balanceValue) balanceValue.textContent = `₱ ${balance}`;
  updateChangeDisplay(balance);
  if (!statusMessage || !confirmBtn) return;
  if (isProcessingPayment) return;
  if (!pricingLoaded) {
    statusMessage.textContent = 'Loading pricing...';
    confirmBtn.disabled = true;
    confirmBtn.setAttribute('aria-disabled', 'true');
    return;
  }

  if (balance >= totalPrice) {
    statusMessage.textContent =
      'Sufficient balance detected. You can confirm now.';
    confirmBtn.disabled = false;
    confirmBtn.setAttribute('aria-disabled', 'false');
  } else {
    const needed = totalPrice - balance;
    statusMessage.textContent = `Insert more coins: ₱ ${needed} remaining.`;
    confirmBtn.disabled = true;
    confirmBtn.setAttribute('aria-disabled', 'true');
  }
}

function setCoinEventMessage(message: string): void {
  if (coinEventMessage) coinEventMessage.textContent = message;
}

function setPrintingPhase(
  phase: 'printing' | 'dispensing' | 'failed' | 'done',
): void {
  const modeLabel = config.mode === 'copy' ? 'Copying' : 'Printing';
  const modePast = config.mode === 'copy' ? 'Copy' : 'Print';

  if (phase === 'printing') {
    if (printingSubtitle) {
      printingSubtitle.textContent =
        `Please wait while your document is being ${modeLabel.toLowerCase()}...`;
    }
    if (printingHint) {
      printingHint.textContent = 'Do not turn off the machine.';
    }
    return;
  }

  if (phase === 'dispensing') {
    if (printingSubtitle) {
      printingSubtitle.textContent =
        `${modeLabel} done. Dispensing your coin change...`;
    }
    if (printingHint) {
      printingHint.textContent = 'Please wait until the dispenser completes.';
    }
    return;
  }

  if (phase === 'failed') {
    if (printingSubtitle) {
      printingSubtitle.textContent =
        `${modePast} completed, but coin change dispensing failed.`;
    }
    if (printingHint) {
      printingHint.textContent =
        'Please contact staff for manual change settlement.';
    }
    return;
  }

  if (printingSubtitle) {
    printingSubtitle.textContent = `${modePast} and change handling completed.`;
  }
  if (printingHint) {
    printingHint.textContent = 'Thank you for using PrintBit.';
  }
}

async function showScanQrOverlay(downloadUrl: string, expiresAt?: string): Promise<void> {
  const scanQrOverlay = document.getElementById("scanQrOverlay");
  const scanQrCanvas = document.getElementById("scanQrCanvas") as HTMLCanvasElement | null;
  const scanQrLinkText = document.getElementById("scanQrLinkText");
  const scanQrExpiry = document.getElementById("scanQrExpiry");

  if (!scanQrOverlay || !scanQrCanvas) return;

  await QRCode.toCanvas(scanQrCanvas, downloadUrl, {
    width: 220,
    margin: 1,
    color: { dark: "#1a1a2e", light: "#ffffff" },
    errorCorrectionLevel: "M",
  });

  if (scanQrLinkText) scanQrLinkText.textContent = downloadUrl;
  if (scanQrExpiry && expiresAt) {
    const expiry = new Date(expiresAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    scanQrExpiry.textContent = `Link expires at ${expiry}`;
  }

  showOverlay(scanQrOverlay);

  // Accessibility: move focus into the scan QR overlay and trap focus while it is active.
  // Try to focus the dedicated "Done" button if present; otherwise, fall back to the first focusable element.
  const getFocusableElements = (): HTMLElement[] => {
    const focusableSelector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(
      scanQrOverlay.querySelectorAll<HTMLElement>(focusableSelector),
    ).filter((el) => !el.hasAttribute("disabled") && !el.getAttribute("aria-hidden"));
  };

  const focusInitialElement = (): void => {
    // Prefer a specific Done button if the markup provides one.
    const doneButton =
      scanQrOverlay.querySelector<HTMLButtonElement>("#scanQrDoneButton") ??
      scanQrOverlay.querySelector<HTMLButtonElement>('button[data-scan-qr-done]');

    if (doneButton) {
      doneButton.focus();
      return;
    }

    const focusable = getFocusableElements();
    if (focusable.length > 0) {
      focusable[0].focus();
    }
  };

  // Use requestAnimationFrame to ensure the overlay is visible before moving focus.
  if (typeof window !== "undefined" && "requestAnimationFrame" in window) {
    window.requestAnimationFrame(focusInitialElement);
  } else {
    focusInitialElement();
  }

  // Initialize a simple focus trap once per overlay element.
  if (!(scanQrOverlay as HTMLElement).dataset.focusTrapInitialized) {
    (scanQrOverlay as HTMLElement).dataset.focusTrapInitialized = "true";

    scanQrOverlay.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;

      const focusable = getFocusableElements();
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        // Shift+Tab: cycle from first to last.
        if (activeElement === first || !scanQrOverlay.contains(activeElement)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        // Tab: cycle from last to first.
        if (activeElement === last || !scanQrOverlay.contains(activeElement)) {
          event.preventDefault();
          first.focus();
        }
      }
    });
  }
}

async function fetchInitialBalance(): Promise<void> {
  const response = await fetch('/api/balance');
  const data = (await response.json()) as { balance: number };
  updateBalanceUI(data.balance ?? 0);
}

async function loadPricing(): Promise<void> {
  let pricing = DEFAULT_PRICING;

  const response = await fetch('/api/pricing');
  if (!response.ok) throw new Error('Pricing request failed.');

  const payload = (await response.json()) as Partial<PricingResponse>;
  const safePrint =
    typeof payload.printPerPage === 'number' &&
    Number.isFinite(payload.printPerPage)
      ? payload.printPerPage
      : DEFAULT_PRICING.printPerPage;
  const safeCopy =
    typeof payload.copyPerPage === 'number' &&
    Number.isFinite(payload.copyPerPage)
      ? payload.copyPerPage
      : DEFAULT_PRICING.copyPerPage;
  const safeColor =
    typeof payload.colorSurcharge === 'number' &&
    Number.isFinite(payload.colorSurcharge)
      ? payload.colorSurcharge
      : DEFAULT_PRICING.colorSurcharge;

  const safeScan =
    typeof payload.scanDocument === 'number' &&
    Number.isFinite(payload.scanDocument)
      ? payload.scanDocument
      : DEFAULT_PRICING.scanDocument;

  pricing = {
    printPerPage: safePrint,
    copyPerPage: safeCopy,
    colorSurcharge: safeColor,
    scanDocument: safeScan,
  };

  totalPrice = calculateTotalPrice(pricing);
  pricingLoaded = true;
  if (priceValue) priceValue.textContent = `₱ ${totalPrice}`;
}

async function resetBalanceForTesting(): Promise<void> {
  if (!resetBalanceBtn) return;
  resetBalanceBtn.disabled = true;
  if (statusMessage) statusMessage.textContent = 'Resetting coin balance...';

  const response = await fetch('/api/balance/reset', { method: 'POST' });
  const payload = (await response.json()) as {
    balance?: number;
    error?: string;
  };

  if (!response.ok) {
    if (statusMessage)
      statusMessage.textContent = payload.error ?? 'Failed to reset balance.';
    resetBalanceBtn.disabled = false;
    return;
  }

  updateBalanceUI(payload.balance ?? 0);
  if (statusMessage)
    statusMessage.textContent = 'Coin balance reset to ₱ 0.00 (testing mode).';
  setCoinEventMessage('Balance reset manually for testing.');
  resetBalanceBtn.disabled = false;
}

const confirmModal = document.getElementById('confirmModal');
const modalCancelBtn = document.getElementById(
  'modalCancelBtn',
) as HTMLButtonElement;
const modalConfirmBtn = document.getElementById(
  'modalConfirmBtn',
) as HTMLButtonElement;
const modalFile = document.getElementById('modalFile');
const modalMode = document.getElementById('modalMode');
const modalColor = document.getElementById('modalColor');
const modalCopies = document.getElementById('modalCopies');
const modalPages = document.getElementById('modalPages');
const modalPagesRow = document.getElementById('modalPagesRow');
const modalOrientation = document.getElementById('modalOrientation');
const modalPaper = document.getElementById('modalPaper');
const modalPrice = document.getElementById('modalPrice');
const printingOverlay = document.getElementById('printingOverlay');
const printingSubtitle = document.getElementById('printingSubtitle');
const printingHint = document.getElementById('printingHint');
const thankYouOverlay = document.getElementById('thankYouOverlay');
const thankYouDoneBtn = document.getElementById(
  'thankYouDoneBtn',
) as HTMLButtonElement;
let isProcessingPayment = false;

if (config.mode === 'copy' || config.mode === 'scan') {
  modalPagesRow?.setAttribute('hidden', '');
}

function showModal(): void {
  if (!confirmModal) return;
  if (modalFile)
    modalFile.textContent =
      config.mode === 'print'
        ? (uploadedFile ?? 'No file')
        : 'Physical document copy';
  if (modalMode) modalMode.textContent = config.mode.toUpperCase();
  if (modalColor) modalColor.textContent = config.colorMode;
  if (modalCopies) modalCopies.textContent = String(config.copies);
  if (modalPages) modalPages.textContent = pageRangeLabel(config.pageRange);
  if (modalOrientation) modalOrientation.textContent = config.orientation;
  if (modalPaper) modalPaper.textContent = config.paperSize;
  if (modalPrice) modalPrice.textContent = `₱ ${totalPrice}`;
  const change = currentBalance - totalPrice;
  if (modalChangeRow && modalChange) {
    if (change > 0) {
      modalChangeRow.removeAttribute('hidden');
      modalChange.textContent = `₱ ${change}`;
    } else {
      modalChangeRow.setAttribute('hidden', '');
      modalChange.textContent = '—';
    }
  }
  confirmModal.classList.add('is-visible');
  confirmModal.setAttribute('aria-hidden', 'false');
  // Move focus into modal for accessibility
  (modalCancelBtn as HTMLElement | null)?.focus();
}

function hideModal(): void {
  if (!confirmModal) return;
  confirmModal.classList.remove('is-visible');
  confirmModal.setAttribute('aria-hidden', 'true');
  // Return focus to the trigger button
  (confirmBtn as HTMLElement | null)?.focus();
}

function showOverlay(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.add('is-visible');
  el.setAttribute('aria-hidden', 'false');
}

function hideOverlay(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.remove('is-visible');
  el.setAttribute('aria-hidden', 'true');
}

confirmBtn?.addEventListener('click', () => {
  showModal();
});

modalCancelBtn?.addEventListener('click', () => {
  hideModal();
});

modalConfirmBtn?.addEventListener('click', async () => {
  modalConfirmBtn.disabled = true;
  hideModal();
  confirmBtn.disabled = true;
  isProcessingPayment = true;

  showOverlay(printingOverlay);

  const printingTitle = document.querySelector('.printingTitle');
  if (printingTitle && config.mode === "scan") {
    printingTitle.textContent = "Your file is preparing...";
  }

  if (config.mode === "scan") {
    if (printingSubtitle) printingSubtitle.textContent = "Processing your payment...";
    if (printingHint) printingHint.textContent = "Please wait while we secure your download link.";
  } else {
    setPrintingPhase("printing");
  }
  const MIN_OVERLAY_MS = 3_000;
  const overlayStart = Date.now();

  if (config.mode === "scan") {
    if (!config.scanFilename) {
      hideOverlay(printingOverlay);
      if (statusMessage) statusMessage.textContent = "No scan file found. Please go back and scan again.";
      isProcessingPayment = false;
      confirmBtn.disabled = false;
      modalConfirmBtn.disabled = false;
      return;
    }

    try {
      const chargeRes = await fetch("/api/scanner/soft-copy/charge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: config.scanFilename }),
      });
      const chargeData = (await chargeRes.json()) as { ok?: boolean; error?: string };
      if (!chargeRes.ok || chargeData.ok === false) {
        hideOverlay(printingOverlay);
        if (statusMessage) statusMessage.textContent = chargeData.error ?? "Payment failed. Please add more coins.";
        isProcessingPayment = false;
        confirmBtn.disabled = false;
        modalConfirmBtn.disabled = false;
        return;
      }

      const linkRes = await fetch("/api/scanner/wireless-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: config.scanFilename }),
      });
      const linkData = (await linkRes.json()) as {
        downloadUrl?: string;
        expiresAt?: string;
        error?: string;
      };
      if (!linkRes.ok || !linkData.downloadUrl) {
        hideOverlay(printingOverlay);
        if (statusMessage) statusMessage.textContent = linkData.error ?? "Failed to generate download link.";
        isProcessingPayment = false;
        confirmBtn.disabled = false;
        modalConfirmBtn.disabled = false;
        return;
      }

      const remaining = MIN_OVERLAY_MS - (Date.now() - overlayStart);
      if (remaining > 0) await new Promise<void>((r) => setTimeout(r, remaining));
      hideOverlay(printingOverlay);

      await showScanQrOverlay(linkData.downloadUrl, linkData.expiresAt);

      sessionStorage.removeItem("printbit.config");
      sessionStorage.removeItem("printbit.uploadedFile");
      sessionStorage.removeItem("printbit.sessionId");
    } catch {
      hideOverlay(printingOverlay);
      if (statusMessage) statusMessage.textContent = "Network error. Please try again.";
      isProcessingPayment = false;
      confirmBtn.disabled = false;
      modalConfirmBtn.disabled = false;
    }
    isProcessingPayment = false;
    return;
  } else if (config.mode === "copy") {
    // Copy flow: print the already checked scan file
    if (!config.copyPreviewPath) {
      hideOverlay(printingOverlay);
      if (statusMessage) {
        statusMessage.textContent =
          'No checked document found. Please go back to /copy and tap Check for Document again.';
      }
      isProcessingPayment = false;
      confirmBtn.disabled = false;
      modalConfirmBtn.disabled = false;
      return;
    }

    if (statusMessage)
      statusMessage.textContent = 'Sending checked document to printer...';

    try {
      const createRes = await fetch('/api/copy/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          copies: config.copies,
          colorMode: config.colorMode,
          orientation: config.orientation,
          paperSize: config.paperSize,
          amount: totalPrice,
          previewPath: config.copyPreviewPath,
        }),
      });

      if (!createRes.ok) {
        const payload = (await createRes.json()) as { error?: string };
        hideOverlay(printingOverlay);
        if (statusMessage)
          statusMessage.textContent =
            payload.error ?? 'Failed to start copy job.';
        isProcessingPayment = false;
        confirmBtn.disabled = false;
        modalConfirmBtn.disabled = false;
        return;
      }

      const createData = (await createRes.json()) as {
        id: string;
        state: string;
      };
      const jobId = createData.id;

      // Poll job status
      const pollResult = await pollCopyJob(jobId);

      const remaining = MIN_OVERLAY_MS - (Date.now() - overlayStart);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      hideOverlay(printingOverlay);

      if (pollResult === 'succeeded') {
        showOverlay(thankYouOverlay);
        if (statusMessage) statusMessage.textContent = 'Your copies are ready!';
        sessionStorage.removeItem('printbit.config');
        sessionStorage.removeItem('printbit.copyPreviewPath');
        sessionStorage.removeItem('printbit.uploadedFile');
        sessionStorage.removeItem('printbit.sessionId');
      } else if (pollResult === 'failed') {
        if (statusMessage)
          statusMessage.textContent = 'Copy job failed. Please try again.';
        isProcessingPayment = false;
        confirmBtn.disabled = false;
        modalConfirmBtn.disabled = false;
      } else {
        if (statusMessage) statusMessage.textContent = 'Copy was cancelled.';
        isProcessingPayment = false;
        confirmBtn.disabled = false;
        modalConfirmBtn.disabled = false;
      }
    } catch {
      hideOverlay(printingOverlay);
      if (statusMessage)
        statusMessage.textContent = 'Network error during copy job.';
      isProcessingPayment = false;
      confirmBtn.disabled = false;
      modalConfirmBtn.disabled = false;
    }
  } else {
    // Print flow: existing behavior
    if (statusMessage) statusMessage.textContent = 'Sending to printer…';

    const response = await fetch('/api/confirm-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: totalPrice,
        mode: config.mode,
        sessionId: config.sessionId,
        copies: config.copies,
        colorMode: config.colorMode,
        orientation: config.orientation,
        paperSize: config.paperSize,
        pageRange: config.pageRange,
      }),
    });

    if (!response.ok) {
      hideOverlay(printingOverlay);
      const payload = (await response.json()) as { error?: string };
      if (statusMessage)
        statusMessage.textContent =
          payload.error ?? 'Payment confirmation failed.';
      isProcessingPayment = false;
      confirmBtn.disabled = false;
      modalConfirmBtn.disabled = false;
      return;
    }

    const payload = (await response.json()) as {
      change?: {
        state?: 'none' | 'dispensed' | 'failed';
        requested?: number;
        message?: string;
      };
    };

    if (payload.change?.state === 'failed') {
      setPrintingPhase('failed');
      if (statusMessage) {
        statusMessage.textContent =
          'Document printed. Change dispensing failed. Please contact staff.';
      }
      setCoinEventMessage(
        `Change owed: ₱ ${payload.change.requested ?? 0}. Staff assistance required.`,
      );
    } else if (payload.change?.state === 'dispensed') {
      setPrintingPhase('done');
      if (statusMessage) {
        statusMessage.textContent = 'Document printed and change dispensed.';
      }
    } else if (statusMessage) {
      statusMessage.textContent = 'Document sent to printer!';
    }

    // Ensure the printing overlay is visible for at least MIN_OVERLAY_MS
    const remaining = MIN_OVERLAY_MS - (Date.now() - overlayStart);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));

    hideOverlay(printingOverlay);

    // Show thank-you overlay
    showOverlay(thankYouOverlay);

    if (statusMessage) {
      statusMessage.textContent = 'Your document has been sent to the printer!';
    }
    sessionStorage.removeItem('printbit.config');
    sessionStorage.removeItem('printbit.copyPreviewPath');
    sessionStorage.removeItem('printbit.uploadedFile');
    sessionStorage.removeItem('printbit.sessionId');
  }
  isProcessingPayment = false;
});

async function pollCopyJob(jobId: string): Promise<string> {
  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/copy/jobs/${encodeURIComponent(jobId)}`);
        if (!res.ok) {
          clearInterval(interval);
          resolve('failed');
          return;
        }
        const data = (await res.json()) as {
          state: string;
          progress?: { pagesCompleted: number; pagesTotal: number | null };
        };
        const { state, progress } = data;

        if (state === 'queued' && statusMessage) {
          statusMessage.textContent = 'Preparing printer...';
        } else if (state === 'running' && statusMessage) {
          if (progress && progress.pagesTotal) {
            statusMessage.textContent = `Printing copy ${progress.pagesCompleted} of ${progress.pagesTotal}...`;
          } else {
            statusMessage.textContent = 'Printing your copy... please wait.';
          }
        }

        if (
          state === 'succeeded' ||
          state === 'failed' ||
          state === 'cancelled'
        ) {
          clearInterval(interval);
          resolve(state);
        }
      } catch {
        clearInterval(interval);
        resolve('failed');
      }
    }, 1500);
  });
}

thankYouDoneBtn?.addEventListener('click', () => {
  hideOverlay(thankYouOverlay);
  window.location.href = '/';
});
const scanQrDoneBtn = document.getElementById("scanQrDoneBtn") as HTMLButtonElement | null;
scanQrDoneBtn?.addEventListener("click", () => {
  window.location.href = "/";
});
resetBalanceBtn?.addEventListener('click', () => {
  void resetBalanceForTesting();
});

async function insertTestCoin(value: number): Promise<void> {
  const buttons = document.querySelectorAll<HTMLButtonElement>('.coin-btn');
  buttons.forEach((b) => (b.disabled = true));

  try {
    const response = await fetch('/api/balance/add-test-coin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });

    const payload = (await response.json()) as {
      balance?: number;
      error?: string;
    };
    if (!response.ok) {
      setCoinEventMessage(payload.error ?? 'Failed to insert coin.');
    }
  } catch {
    setCoinEventMessage('Network error inserting test coin.');
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

document.querySelectorAll<HTMLButtonElement>('.coin-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const value = parseInt(btn.dataset.value ?? '0', 10);
    if (value > 0) void insertTestCoin(value);
  });
});

const ioFactory = (
  window as unknown as { io?: (...args: unknown[]) => SocketLike }
).io;

if (typeof ioFactory === 'function') {
  const socket = ioFactory();
  socket.on('balance', (amount: unknown) => {
    if (typeof amount === 'number') {
      updateBalanceUI(amount);
    }
  });

  socket.on('coinAccepted', (payload: unknown) => {
    if (
      payload &&
      typeof payload === 'object' &&
      'value' in payload &&
      typeof (payload as { value: unknown }).value === 'number'
    ) {
      const value = (payload as { value: number }).value;
      setCoinEventMessage(`Last accepted coin: ₱ ${value}`);
    }
  });

  socket.on('coinParserWarning', (payload: unknown) => {
    if (
      payload &&
      typeof payload === 'object' &&
      'message' in payload &&
      typeof (payload as { message: unknown }).message === 'string'
    ) {
      setCoinEventMessage(
        `Serial note: ${(payload as { message: string }).message}`,
      );
    }
  });

  socket.on('changeDispenseStatus', (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;

    const state =
      'state' in payload &&
      typeof (payload as { state: unknown }).state === 'string'
        ? (payload as { state: string }).state
        : '';
    const amount =
      'amount' in payload &&
      typeof (payload as { amount: unknown }).amount === 'number'
        ? (payload as { amount: number }).amount
        : 0;

    if (state === 'dispensing') {
      setPrintingPhase('dispensing');
      if (statusMessage) {
        statusMessage.textContent = `Dispensing change: ₱ ${amount}...`;
      }
      return;
    }

    if (state === 'dispensed') {
      setPrintingPhase('done');
      if (statusMessage) {
        statusMessage.textContent = `Change dispensed: ₱ ${amount}.`;
      }
      return;
    }

    if (state === 'failed') {
      setPrintingPhase('failed');
      if (statusMessage) {
        statusMessage.textContent =
          'Change dispensing failed. Please contact staff for settlement.';
      }
    }
  });
}

async function boot(): Promise<void> {
  await loadPricing();
  await fetchInitialBalance();
}

void boot();
