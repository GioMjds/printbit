import QRCode from 'qrcode';
import { DotLottie } from '@lottiefiles/dotlottie-web';
import {
  initializePageIdleTimeout,
  setupPageIdleWarningButton,
} from '@/services/idle-timeout';
import { initKioskLocalization } from '../shared/kiosk-i18n';
import { navigateWithKioskMotion } from '../shared/kiosk-navigation';
import { mountLoadingAnimation } from '../shared/loading-animation';
import {
  applyConfirmationEvidence,
  createConfirmationOutcomeState,
  type ConfirmationOutcomeIdentity,
} from './confirmation-outcome';
import {
  buildMaintenanceReceiptView,
  isMaintenancePrintFailure,
} from './maintenance-receipt';
import { getMaintenanceGuidance } from './recovery-guidance';
import {
  getExpectedPrintPages,
  getMonotonicPrintedPages,
  getPrintingStage,
} from './printing-stage';
import { presentMaintenanceError } from './maintenance-view';
import {
  attachPowerSafetyOverlay,
  type PowerSafetyOverlayController,
} from '../shared/power-safety-overlay';
import {
  resolveWifiTroubleshootingDetails,
  type HotspotConfig,
} from '../shared/wifi-troubleshooting';
import { buildPhysicalPrintSettings } from './print-settings';

export {};

void initKioskLocalization();
void loadHotspotConfig();

// Initialize page idle timeout on load with warning modal
void setupPageIdleWarningButton();
void initializePageIdleTimeout({
  showWarningModal: true,
  // A paid or queued job must stay visible until the worker reports a terminal
  // result. Resume a full normal idle period after that result instead of
  // cancelling the customer's active work in the background.
  deferWhile: () => hasActiveJob(),
  onTimeout: async () => {
    console.log(
      '[PAGE IDLE] Confirm page timeout reached, redirecting to home',
    );
    await releaseTransientFilesForCurrentMode('confirm_idle_timeout');
    const sessionId = sessionStorage.getItem('printbit.sessionId');
    const sessionToken = sessionStorage.getItem('printbit.sessionToken');
    if (sessionId && sessionToken) {
      try {
        await fetch(
          `/api/wireless/sessions/${encodeURIComponent(sessionId)}/cancel?token=${encodeURIComponent(sessionToken)}`,
          { method: 'DELETE' },
        );
      } catch {
        // Best-effort cleanup
      }
    }
    // Clear state before redirect
    sessionStorage.removeItem('printbit.config');
    sessionStorage.removeItem('printbit.copyPreviewPath');
    sessionStorage.removeItem('printbit.copyPreviewReleaseToken');
    sessionStorage.removeItem('printbit.sessionId');
    sessionStorage.removeItem('printbit.sessionToken');
    navigateWithKioskMotion('/', 'replace');
  },
});

type SocketLike = {
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
};

type SocketIoFactory = (() => SocketLike) | undefined;

/** Payload shape for socket events the confirm page subscribes to. */
interface PrinterStatusPayload {
  connected?: boolean;
  status?: string;
  printError?: PrintError | null;
}

interface WorkerJobPayload {
  transactionId?: string | null;
  spoolerCorrelationKey?: string | null;
  message?: string | null;
  errorMessage?: string | null;
  failureStage?: string | null;
  errorType?: string | null;
  reason?: string | null;
  printError?: PrintError | null;
  pagesPrinted?: number;
  totalPages?: number;
}

let socket: SocketLike | null = null;

type PageRangeSelection =
  | { type: 'all' }
  | { type: 'custom'; range: string }
  | { type: 'single'; page: number };
type RotationDeg = 0 | 90 | 180 | 270;

export type PrintQuality = 'standard' | 'high';

export interface PrintConfig {
  mode: 'print' | 'copy' | 'scan';
  sessionId: string | null;
  documentId?: string | null;
  scanFilename?: string;
  scanReleaseToken?: string | null;
  copyPreviewPath?: string | null;
  copyPreviewReleaseToken?: string | null;
  detectedColorMode?: 'colored' | 'grayscale' | null;
  colorMode: 'colored' | 'grayscale';
  quality?: 'standard' | 'high';
  copies: number;
  orientation: 'portrait' | 'landscape';
  rotationDeg?: number;
  paperSize: 'A4' | 'Letter' | 'Legal';
  pageRange?: PageRangeSelection;
  totalPages?: number;
  quote?: PrintQuote;
}

type ConfirmConfig = PrintConfig;

type PricingResponse = {
  scanDocument: number;
};

type ReceiptLinkPayload = {
  receipt?: {
    viewUrl?: string | null;
    url?: string | null;
    expiresAt?: string | null;
  };
  receiptViewUrl?: string | null;
  receiptExpiresAt?: string | null;
  downloadLink?: {
    token?: string | null;
    downloadUrl?: string | null;
    expiresAt?: string | null;
  } | null;
};

type PrintQuote = {
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
  requestedColorMode: 'colored' | 'grayscale';
  effectiveColorMode: 'colored' | 'grayscale';
  pricing: {
    printPerPage: number;
    colorSurcharge: number;
  };
  analysisConfidence: 'high' | 'medium' | 'low';
  billingPageDetection:
    | 'high-confidence-page-detection'
    | 'fallback-assumptions';
  analysisFallbackReasonFlags: string[];
};

type PrintErrorSeverity = 'warning' | 'recoverable' | 'fatal';

type PrintError = {
  code: string;
  severity: PrintErrorSeverity;
  userMessage: string;
  hint?: string;
  timestamp?: string;
  canRetry?: boolean;
  canDismiss?: boolean;
  /** Correlation key of the spooler job this error refers to. */
  spoolerCorrelationKey?: string | null;
};

type PrintLifecycleStatePayload = {
  mode: 'print' | 'copy' | 'scan';
  state: 'queued' | 'processing' | 'printed' | 'failed';
  printerName?: string | null;
  transactionId?: string | null;
  spoolerCorrelationKey?: string | null;
  spoolerJobId?: number | null;
  jobStatus?: string | null;
  pagesPrinted?: number;
  totalPages?: number;
  reason?: string | null;
  printError?: PrintError | null;
  failureStage?: string;
  errorType?: string;
};

function normalizeRotationDeg(value: unknown): RotationDeg {
  if (value === 90 || value === 180 || value === 270) {
    return value;
  }
  return 0;
}

function truncateFilename(name: string, maxLen = 32): string {
  if (!name || name.length <= maxLen) return name;
  const lastDot = name.lastIndexOf('.');
  if (lastDot > 0 && name.length - lastDot <= 8) {
    const ext = name.slice(lastDot);
    const avail = maxLen - ext.length - 3;
    if (avail > 4) {
      return `${name.slice(0, avail)}...${ext}`;
    }
  }
  return `${name.slice(0, maxLen - 3)}...`;
}

const modeValue = document.getElementById('modeValue');
const priceValue = document.getElementById('priceValue');
const balanceValue = document.getElementById('balanceValue');
const balanceRing = document.getElementById('balanceRing');
const balanceArc = document.getElementById('balanceArc') as SVGCircleElement | null;
const changeValue = document.getElementById('changeValue');
const changeRow = document.getElementById('changeRow');
const statusMessage = document.getElementById('statusMessage');
const statusBadge = document.getElementById('statusBadge');
const coinInsertNote = document.getElementById('coinInsertNote');
const footerNote = document.getElementById('footerNote');
const confirmBtn = document.getElementById('confirmBtn') as HTMLButtonElement;

// Summary Table DOM Refs
const fileValue = document.getElementById('fileValue');
const mainSummaryFileRow = document.getElementById('mainSummaryFileRow');
const pagesCard = document.getElementById('pagesCard');
const pagesRangeValue = document.getElementById('pagesRangeValue');
const pagesTotalCount = document.getElementById('pagesTotalCount');
const bwPagesChip = document.getElementById('bwPagesChip');
const pagesBwCount = document.getElementById('pagesBwCount');
const colorPagesChip = document.getElementById('colorPagesChip');
const pagesColorCount = document.getElementById('pagesColorCount');

const settingsGrid = document.getElementById('settingsGrid');
const colorCard = document.getElementById('colorCard');
const colorModePrimary = document.getElementById('colorModePrimary');
const colorDetectedBadge = document.getElementById('colorDetectedBadge');
const colorSelectedBadge = document.getElementById('colorSelectedBadge');

const paperCard = document.getElementById('paperCard');
const paperSizePrimary = document.getElementById('paperSizePrimary');
const copiesTag = document.getElementById('copiesTag');
const orientationTag = document.getElementById('orientationTag');
const qualityTag = document.getElementById('qualityTag');
const rotationTag = document.getElementById('rotationTag');

const scanCard = document.getElementById('scanCard');

// Coin Lottie Refs
const coinLottieCanvas = document.getElementById('coinLottieCanvas') as HTMLCanvasElement | null;
const coinLottieWrapper = document.getElementById('coinLottieWrapper');

// Action column refs (spec: JS bridge)
const actionPriceValue = document.getElementById('actionPriceValue');
const actionCol = document.querySelector<HTMLElement>('.action-col');

// Printer Error Elements (Issue 124 & UX Enhancement)
const printerErrorBlock = document.getElementById('printerErrorBlock');
const printerErrorModal = document.getElementById('printerErrorModal');
const errorTitle = document.getElementById('errorTitle');
const errorSubtitle = document.getElementById('errorSubtitle');
const errorMessage = document.getElementById('errorMessage');
const maintenanceIssueDesc = document.getElementById('maintenanceIssueDesc');
const errorStepsList = document.getElementById('errorStepsList');
const errorHint = document.getElementById('errorHint');
const errorCloseBtn = document.getElementById(
  'errorCloseBtn',
) as HTMLButtonElement;
const errorSeverityText = document.getElementById('errorSeverityText');
const errorProgressEl = document.getElementById(
  'errorProgress',
) as HTMLParagraphElement | null;
const errorTechDetails = document.getElementById(
  'errorTechDetails',
) as HTMLElement | null;
const maintenanceResolution = document.getElementById(
  'maintenanceResolution',
) as HTMLElement | null;
const maintenanceReceiptContainer = document.getElementById(
  'maintenanceReceiptContainer',
) as HTMLElement | null;
const maintenanceReceiptPending = document.getElementById(
  'maintenanceReceiptPending',
) as HTMLElement | null;
const maintenanceReceiptQrCanvas = document.getElementById(
  'maintenanceReceiptQrCanvas',
) as HTMLCanvasElement | null;
const maintenanceReceiptQrExpiry = document.getElementById(
  'maintenanceReceiptQrExpiry',
) as HTMLElement | null;
const maintenanceDoneBtn = document.getElementById(
  'maintenanceDoneBtn',
) as HTMLButtonElement | null;

// Confirmation Modal Elements
const confirmModal = document.getElementById('confirmModal');
const modalTitle = document.getElementById('modalTitle');
const modalSubtitle = document.getElementById('modalSubtitle');
const modalPaperAlert = document.getElementById('modalPaperAlert');
const modalPaperAlertSize = document.getElementById('modalPaperAlertSize');
const modalCancelBtn = document.getElementById(
  'modalCancelBtn',
) as HTMLButtonElement;
const modalConfirmBtn = document.getElementById(
  'modalConfirmBtn',
) as HTMLButtonElement;
const modalFile = document.getElementById('modalFile');
const modalMode = document.getElementById('modalMode');
const modalColor = document.getElementById('modalColor');
const modalColorRow = document.getElementById('modalColorRow');
const modalQuality = document.getElementById('modalQuality');
const modalQualityRow = document.getElementById('modalQualityRow');
const modalCopies = document.getElementById('modalCopies');
const modalCopiesRow = document.getElementById('modalCopiesRow');
const modalPages = document.getElementById('modalPages');
const modalPagesRow = document.getElementById('modalPagesRow');
const modalOrientation = document.getElementById('modalOrientation');
const modalOrientationRow = document.getElementById('modalOrientationRow');
const modalRotation = document.getElementById('modalRotation');
const modalRotationRow = document.getElementById('modalRotationRow');
const modalPaper = document.getElementById('modalPaper');
const modalPaperRow = document.getElementById('modalPaperRow');
const modalPrice = document.getElementById('modalPrice');
const modalPaid = document.getElementById('modalPaid');
const modalChange = document.getElementById('modalChange');

// Confirmation Modal — Step 1 (Tray Check) Elements
const modalTrayOkBtn = document.getElementById(
  'modalTrayOkBtn',
) as HTMLButtonElement;
const modalTrayIssueBtn = document.getElementById(
  'modalTrayIssueBtn',
) as HTMLButtonElement;

// Tray Issue Overlay Elements
const trayIssueOverlay = document.getElementById('trayIssueOverlay');
const trayIssueDoneBtn = document.getElementById(
  'trayIssueDoneBtn',
) as HTMLButtonElement;

// Printing In Progress Elements
const printingOverlay = document.getElementById('printingOverlay');
const printingTitle = document.getElementById('printingTitle');
const printingSubtitle = document.getElementById('printingSubtitle');
const printingHint = document.getElementById('printingHint');
const confirmLoadingAnimation = document.getElementById(
  'confirmLoadingAnimation',
) as HTMLElement | null;
const confirmLoadingCanvas = document.getElementById(
  'confirmLoadingCanvas',
) as HTMLCanvasElement | null;
const printingProgressText = document.getElementById('printingProgressText');
const printingStage = document.getElementById('printingStage');
const printingProgressCurrent = document.getElementById(
  'printingProgressCurrent',
);
const printingProgressTotal = document.getElementById('printingProgressTotal');
const printingProgressBar = document.getElementById('printingProgressBar');
const printingProgressFill = document.getElementById(
  'printingProgressFill',
) as HTMLDivElement | null;

// Thank You Elements
const thankYouOverlay = document.getElementById('thankYouOverlay');
const thankYouModalSheet = document.getElementById('thankYouModalSheet');
const thankYouTitle = document.getElementById('thankYouTitle');
const thankYouSubtitle = document.getElementById('thankYouSubtitle');
const collectionCallout = document.getElementById('collectionCallout');
const thankYouDoneBtn = document.getElementById(
  'thankYouDoneBtn',
) as HTMLButtonElement;
const printAnotherBtn = document.getElementById(
  'printAnotherBtn',
) as HTMLButtonElement | null;
const transactionReference = document.getElementById(
  'transactionReference',
) as HTMLElement | null;

// Owed Change Alert Elements
const owedChangeAlert = document.getElementById('owedChangeAlert');
const owedChangeAmountBadge = document.getElementById('owedChangeAmountBadge');
const owedChangeAmountText = document.getElementById('owedChangeAmountText');
const owedChangeRefId = document.getElementById('owedChangeRefId');

interface OwedChangeNotice {
  amountOwed: number;
  transactionId: string | null;
  message?: string;
}

let pendingOwedChange: OwedChangeNotice | null = null;

// Scan Download CTA Elements
const scanDownloadCtaContainer = document.getElementById(
  'scanDownloadCtaContainer',
) as HTMLElement | null;
const scanDownloadQrCanvas = document.getElementById(
  'scanDownloadQrCanvas',
) as HTMLCanvasElement | null;
const scanDownloadQrExpiry = document.getElementById(
  'scanDownloadQrExpiry',
) as HTMLElement | null;
const scanDownloadTitle = document.getElementById(
  'scanDownloadTitle',
) as HTMLElement | null;
const scanDownloadFormatTag = document.getElementById(
  'scanDownloadFormatTag',
) as HTMLElement | null;
const scanDownloadHint = document.getElementById(
  'scanDownloadHint',
) as HTMLElement | null;

// Receipt CTA Elements
const receiptCtaContainer = document.getElementById(
  'receiptCtaContainer',
) as HTMLElement | null;
const receiptQrCanvas = document.getElementById(
  'receiptQrCanvas',
) as HTMLCanvasElement | null;
const receiptQrExpiry = document.getElementById(
  'receiptQrExpiry',
) as HTMLElement | null;

// Wi-Fi Troubleshooting Modal Elements
const confirmWifiHelpBtn = document.getElementById('confirmWifiHelpBtn');
const maintenanceWifiHelpBtn = document.getElementById('maintenanceWifiHelpBtn');
const confirmWifiModalOverlay = document.getElementById('confirmWifiModalOverlay');
const confirmWifiModalCloseBtn = document.getElementById('confirmWifiModalCloseBtn');
const confirmWifiQrCanvas = document.getElementById('confirmWifiQrCanvas') as HTMLCanvasElement | null;
const confirmWifiSsidVal = document.getElementById('confirmWifiSsidVal');
const confirmWifiPasswordVal = document.getElementById('confirmWifiPasswordVal');

let hotspotConfig: HotspotConfig | null = null;

async function loadHotspotConfig(): Promise<void> {
  try {
    const res = await fetch('/api/config/hotspot');
    if (res.ok) {
      hotspotConfig = (await res.json()) as HotspotConfig;
    }
  } catch {
    /* fallback to defaults */
  }
}

function renderConfirmWifiTroubleshoot(): void {
  const details = resolveWifiTroubleshootingDetails(hotspotConfig);
  if (confirmWifiSsidVal) confirmWifiSsidVal.textContent = details.ssid;
  if (confirmWifiPasswordVal) {
    confirmWifiPasswordVal.textContent = details.isPasswordRequired
      ? details.password
      : 'Open (No password required)';
  }
  if (confirmWifiQrCanvas) {
    void QRCode.toCanvas(confirmWifiQrCanvas, details.qrPayload, {
      width: 200,
      margin: 2,
      color: { dark: '#0e0d1f', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
  }
}

function openConfirmWifiModal(): void {
  renderConfirmWifiTroubleshoot();
  if (!confirmWifiModalOverlay) return;
  confirmWifiModalOverlay.classList.add('is-visible');
  confirmWifiModalOverlay.setAttribute('aria-hidden', 'false');
  confirmWifiModalCloseBtn?.focus();
}

function closeConfirmWifiModal(): void {
  if (!confirmWifiModalOverlay) return;
  confirmWifiModalOverlay.classList.remove('is-visible');
  confirmWifiModalOverlay.setAttribute('aria-hidden', 'true');
}

confirmWifiHelpBtn?.addEventListener('click', openConfirmWifiModal);
maintenanceWifiHelpBtn?.addEventListener('click', openConfirmWifiModal);
confirmWifiModalCloseBtn?.addEventListener('click', closeConfirmWifiModal);
confirmWifiModalOverlay?.addEventListener('click', (e) => {
  if (e.target === confirmWifiModalOverlay) closeConfirmWifiModal();
});
document.addEventListener('keydown', (e) => {
  if (
    e.key === 'Escape' &&
    confirmWifiModalOverlay?.classList.contains('is-visible')
  ) {
    closeConfirmWifiModal();
  }
});

let currentPrinterError: PrintError | null = null;
let lastKnownPagesPrinted = 0;
let lastKnownTotalPages = 0;
let displayedPrintPages = 0;
let confirmationOutcome = createConfirmationOutcomeState();

function hasActiveJob(): boolean {
  return (
    isProcessingPayment ||
    activeSpoolerCorrelationKey !== null ||
    paymentSpoolerCorrelationKey !== null
  );
}

function restoreConfirmationPending(
  identity: Partial<ConfirmationOutcomeIdentity>,
): void {
  confirmationOutcome = applyConfirmationEvidence(confirmationOutcome, {
    type: 'restore-pending',
    identity,
  });
}

function recordConfirmationTerminalFailure(
  identity: Partial<ConfirmationOutcomeIdentity>,
): void {
  confirmationOutcome = applyConfirmationEvidence(confirmationOutcome, {
    type: 'terminal-failure',
    identity,
  });
}

function recordConfirmationTerminalSuccess(
  identity: Partial<ConfirmationOutcomeIdentity>,
): boolean {
  confirmationOutcome = applyConfirmationEvidence(confirmationOutcome, {
    type: 'terminal-success',
    identity,
  });
  return confirmationOutcome.outcome === 'success';
}

// NOTE: powerSafetyOverlay is initialized AFTER socket is created (below, inside the
// ioFactory block) so that socket is non-null when the overlay first tries to attach
// its workerPowerStatusChanged listener. All usage sites (notifyPrintCompleted, etc.)
// are inside socket event handlers and therefore always execute after initialization.
// eslint-disable-next-line prefer-const
let powerSafetyOverlay!: PowerSafetyOverlayController;

const DEFAULT_COIN_INSERT_GUIDANCE_MESSAGE =
  'Tip: Insert one coin at a time. Rapid insertion may not be detected by the kiosk.';
const COIN_INSERT_GUIDANCE_MESSAGE =
  coinInsertNote?.textContent?.trim() ||
  footerNote?.textContent?.trim() ||
  DEFAULT_COIN_INSERT_GUIDANCE_MESSAGE;

function renderPrinterError(err: PrintError): void {
  currentPrinterError = err;
  if (!printerErrorBlock) return;

  const requiresMaintenance = isMaintenancePrintFailure(
    err.code,
    err.userMessage,
  );
  const maintenanceGuidance = getMaintenanceGuidance(
    err.code,
    err.userMessage,
  );
  if (requiresMaintenance) {
    recordConfirmationTerminalFailure({
      transactionId: currentTransactionId,
      spoolerCorrelationKey:
        err.spoolerCorrelationKey ?? paymentSpoolerCorrelationKey,
    });
  }

  if (errorTitle) {
    errorTitle.textContent = requiresMaintenance
      ? maintenanceGuidance.title
      : 'Printer Error';
  }
  if (errorSubtitle) {
    errorSubtitle.textContent = requiresMaintenance
      ? (maintenanceGuidance.subtitle ||
        'The printer encountered an issue and requires attention.')
      : 'Please check the printer to continue.';
  }
  if (errorMessage) {
    if (requiresMaintenance) {
      // Message is already shown inside the callout banner (maintenanceIssueDesc) — hide the top-level copy to save vertical space
      errorMessage.setAttribute('hidden', '');
    } else {
      errorMessage.textContent = err.userMessage;
      errorMessage.removeAttribute('hidden');
    }
  }
  if (maintenanceIssueDesc) {
    maintenanceIssueDesc.textContent = maintenanceGuidance.message;
  }
  if (errorStepsList && maintenanceGuidance.actionSteps) {
    errorStepsList.innerHTML = '';
    for (const step of maintenanceGuidance.actionSteps) {
      const li = document.createElement('li');
      li.textContent = step;
      errorStepsList.appendChild(li);
    }
  }
  if (errorHint) {
    const hint = requiresMaintenance
      ? maintenanceGuidance.hint
      : err.hint || '';
    errorHint.textContent = hint;
    if (hint && !requiresMaintenance) errorHint.removeAttribute('hidden');
    else errorHint.setAttribute('hidden', '');
  }

  // Severity-based styling or behavior
  printerErrorBlock.dataset.severity = err.severity;

  // Severity badge label
  if (errorSeverityText) {
    const severityLabels: Record<PrintErrorSeverity, string> = {
      warning: 'Warning',
      recoverable: 'Recoverable',
      fatal: 'Fatal Error',
    };
    errorSeverityText.textContent = requiresMaintenance
      ? (maintenanceGuidance.badge || 'Staff Assistance')
      : severityLabels[err.severity] ?? err.severity;
  }

  if (err.severity === 'warning' && !requiresMaintenance) {
    if (errorCloseBtn) errorCloseBtn.removeAttribute('hidden');
  } else {
    if (errorCloseBtn) errorCloseBtn.setAttribute('hidden', '');
  }

  if (lastKnownPagesPrinted > 0) {
    if (errorProgressEl) {
      errorProgressEl.textContent = `Printed: ${lastKnownPagesPrinted} of ${lastKnownTotalPages || 1} pages`;
      errorProgressEl.removeAttribute('hidden');
    }
  } else {
    if (errorProgressEl) {
      errorProgressEl.setAttribute('hidden', '');
    }
  }

  if (requiresMaintenance) {
    printerErrorBlock.classList.add('printer-error-modal--wide');
    printerErrorBlock.classList.add('printer-error-modal-overlay--wide');
    printerErrorModal?.classList.add('printer-error-modal--wide');
    renderMaintenanceResolution();
    presentMaintenanceError({
      thankYouOverlay,
      printerErrorBlock,
      maintenanceResolution,
      doneButton: maintenanceDoneBtn,
    });
  } else {
    printerErrorBlock.classList.remove('printer-error-modal--wide');
    printerErrorBlock.classList.remove('printer-error-modal-overlay--wide');
    printerErrorModal?.classList.remove('printer-error-modal--wide');
    maintenanceResolution?.setAttribute('hidden', '');
  }

  if (hasActiveJob() && !requiresMaintenance) {
    printerErrorBlock.classList.remove('is-leaving');
    printerErrorBlock.removeAttribute('hidden');
  }
  applyConfirmGate();
}

function renderAmbiguousWorkerFailure(input: {
  message?: string | null;
  spoolerCorrelationKey?: string | null;
}): void {
  hideOverlay(printingOverlay);
  hidePrintProgress();
  isProcessingPayment = false;
  powerSafetyOverlay.notifyPrintCompleted();
  renderPrinterError({
    code: 'WORKER_PRINT_FAILED',
    severity: 'recoverable',
    userMessage:
      input.message ??
      'The worker could not verify that every page completed. Your document may have printed.',
    hint:
      'Please ask kiosk staff to verify the output before retrying or requesting a refund.',
    timestamp: new Date().toISOString(),
    canRetry: false,
    canDismiss: false,
    spoolerCorrelationKey: input.spoolerCorrelationKey ?? null,
  });
}

function clearPrinterError(): void {
  currentPrinterError = null;
  if (printerErrorBlock) {
    printerErrorBlock.classList.remove('printer-error-modal--wide');
    printerErrorBlock.classList.remove('printer-error-modal-overlay--wide');
    printerErrorModal?.classList.remove('printer-error-modal--wide');
    if (!printerErrorBlock.hasAttribute('hidden')) {
      printerErrorBlock.classList.add('is-leaving');
      window.setTimeout(() => {
        printerErrorBlock?.setAttribute('hidden', '');
        printerErrorBlock?.classList.remove('is-leaving');
      }, 240);
    } else {
      printerErrorBlock.setAttribute('hidden', '');
    }
  }
  if (errorProgressEl) errorProgressEl.setAttribute('hidden', '');
  if (errorTechDetails) errorTechDetails.setAttribute('hidden', '');
  maintenanceResolution?.setAttribute('hidden', '');
  applyConfirmGate();
}

function syncCoinInsertGuidanceMessage(): void {
  if (coinInsertNote) coinInsertNote.textContent = COIN_INSERT_GUIDANCE_MESSAGE;
  if (footerNote) footerNote.textContent = COIN_INSERT_GUIDANCE_MESSAGE;
}

syncCoinInsertGuidanceMessage();

const rawConfig = sessionStorage.getItem('printbit.config');
const uploadedFile = sessionStorage.getItem('printbit.uploadedFile');
const uploadedDocumentId = sessionStorage.getItem(
  'printbit.uploadedDocumentId',
);
const DEFAULT_PRICING: PricingResponse = {
  scanDocument: 5,
};
const PENDING_PAYMENT_IDEMPOTENCY_STORAGE_KEY =
  'printbit.confirmPaymentIdempotencyKey';
const PENDING_PAYMENT_SPOOLER_STORAGE_KEY =
  'printbit.confirmPaymentSpoolerCorrelationKey';
const PENDING_PAYMENT_FINGERPRINT_STORAGE_KEY =
  'printbit.confirmPaymentFingerprint';
let totalPrice = 0;
let pricingLoaded = false;
let pricingError: string | null = null;
let currentBalance = 0;
let currentPrintQuote: PrintQuote | null = null;
let coinSlotIsLocked: boolean = false;
let printerReady = false;

if (!rawConfig) {
  const storedSessionId = sessionStorage.getItem('printbit.sessionId');
  const fallback = storedSessionId
    ? `/config?sessionId=${encodeURIComponent(storedSessionId)}`
    : '/config';
  window.location.href = fallback;
  throw new Error('Missing print configuration');
}

const config = JSON.parse(rawConfig ?? '{}') as ConfirmConfig;
const confirmLoadingController =
  confirmLoadingAnimation && confirmLoadingCanvas
    ? mountLoadingAnimation({
        root: confirmLoadingAnimation,
        canvas: confirmLoadingCanvas,
        mode: config.mode,
      })
    : null;

window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    confirmLoadingController?.destroy();
    coinLottiePlayer?.destroy();
  }
});

config.rotationDeg = normalizeRotationDeg(config.rotationDeg);
if (typeof config.documentId !== 'string') {
  config.documentId = uploadedDocumentId;
}
if (
  config.detectedColorMode !== 'colored' &&
  config.detectedColorMode !== 'grayscale'
) {
  config.detectedColorMode = null;
}
currentPrintQuote =
  config.mode === 'scan'
    ? null
    : ((config.quote as PrintQuote | undefined) ?? null);

const currentPaymentFingerprint = JSON.stringify({
  mode: config.mode,
  sessionId: config.sessionId ?? null,
  documentId: config.documentId ?? null,
  copies: config.copies,
  colorMode: config.colorMode,
  orientation: config.orientation,
  rotationDeg: config.rotationDeg,
  paperSize: config.paperSize,
  pageRange: pageRangeFingerprint(config.pageRange),
  quotedAmount: currentPrintQuote?.requiredAmount ?? null,
});

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

function pageRangeFingerprint(sel?: PageRangeSelection): string {
  if (!sel || sel.type === 'all') return 'all';
  if (sel.type === 'single') return `single:${sel.page}`;
  return `custom:${sel.range ?? ''}`;
}

const RELEASE_REQUEST_TIMEOUT_MS = 1_500;

async function releaseTransientScanFile(
  releaseToken: string,
  reason: string,
): Promise<void> {
  const safeReleaseToken = releaseToken.trim();
  if (!safeReleaseToken) return;

  try {
    const response = await fetchWithTimeout(
      '/api/scanner/release',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          releaseToken: safeReleaseToken,
          reason,
        }),
      },
      RELEASE_REQUEST_TIMEOUT_MS,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    if (isAbortError(error)) return;
  }
}

async function releaseTransientFilesForCurrentMode(
  reason: string,
): Promise<void> {
  if (config.mode === 'scan' && config.scanReleaseToken) {
    await releaseTransientScanFile(config.scanReleaseToken, reason);
    return;
  }
  if (config.mode === 'copy' && config.copyPreviewReleaseToken) {
    await releaseTransientScanFile(config.copyPreviewReleaseToken, reason);
  }
}

function getDisplayColorMode(): 'colored' | 'grayscale' {
  if (
    (config.mode === 'print' || config.mode === 'copy') &&
    currentPrintQuote
  ) {
    return currentPrintQuote.effectiveColorMode;
  }
  return config.colorMode;
}

function formatColorMode(mode: 'colored' | 'grayscale'): string {
  return mode === 'colored' ? 'Colored' : 'Black & White';
}

function formatPaperSizeForPricing(
  paperSize: 'A4' | 'Letter' | 'Legal',
): string {
  switch (paperSize) {
    case 'A4':
      return 'A4 Bond Paper';
    case 'Letter':
      return 'Short Bond Paper';
    case 'Legal':
      return 'Long Bond Paper';
    default:
      return paperSize;
  }
}

function getColorModeSummaryLabel(): string {
  if (
    config.mode === 'print' &&
    config.detectedColorMode &&
    config.detectedColorMode !== config.colorMode
  ) {
    return `Detected: ${formatColorMode(config.detectedColorMode)} | Selected: ${formatColorMode(config.colorMode)}`;
  }

  return formatColorMode(getDisplayColorMode());
}

const confirmBtnSpan = confirmBtn?.querySelector('span');
if (confirmBtnSpan) {
  confirmBtnSpan.textContent =
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
      ? 'Print now'
      : config.mode === 'copy'
        ? 'Copy now'
        : 'Download now';
}

let coinLottiePlayer: DotLottie | null = null;

function initCoinLottieAnimation(): void {
  if (!coinLottieCanvas) return;
  try {
    DotLottie.setWasmUrl('/vendor/dotlottie/dotlottie-player.wasm');
    coinLottiePlayer = new DotLottie({
      canvas: coinLottieCanvas,
      src: '/assets/lottie/coin-insertion.json',
      autoplay: true,
      loop: true,
      layout: { fit: 'contain', align: [0.5, 0.5] },
    });

    coinLottiePlayer.addEventListener('load', () => {
      coinLottieWrapper?.classList.remove('is-fallback');
    });
    coinLottiePlayer.addEventListener('loadError', () => {
      coinLottieWrapper?.classList.add('is-fallback');
    });
    coinLottiePlayer.addEventListener('renderError', () => {
      coinLottieWrapper?.classList.add('is-fallback');
    });
  } catch (err) {
    console.warn('[COIN-LOTTIE] Failed to initialize DotLottie player:', err);
    coinLottieWrapper?.classList.add('is-fallback');
  }
}

export function populateJobSummary(cfg: PrintConfig): void {
  if (modeValue) modeValue.textContent = cfg.mode.toUpperCase();

  // Populate Document filename for main summary table
  if (fileValue) {
    const rawFileName =
      cfg.mode === 'print'
        ? (uploadedFile ?? 'No uploaded file')
        : cfg.mode === 'copy'
          ? 'Physical document copy'
          : (cfg.scanFilename ?? 'Scanned document');
    fileValue.textContent = truncateFilename(rawFileName, 32);
    fileValue.setAttribute('title', rawFileName);
    fileValue.setAttribute('aria-label', `Document: ${rawFileName}`);
  }

  if (cfg.mode === 'scan') {
    // Hide print/copy table rows, show scan row
    pagesCard?.setAttribute('hidden', '');
    colorCard?.setAttribute('hidden', '');
    paperCard?.setAttribute('hidden', '');
    settingsGrid?.setAttribute('hidden', '');
    scanCard?.removeAttribute('hidden');

    // Hide scan-irrelevant rows in the confirmation modal
    modalPaperAlert?.setAttribute('hidden', '');
    modalColorRow?.setAttribute('hidden', '');
    modalQualityRow?.setAttribute('hidden', '');
    modalCopiesRow?.setAttribute('hidden', '');
    modalPagesRow?.setAttribute('hidden', '');
    modalOrientationRow?.setAttribute('hidden', '');
    modalRotationRow?.setAttribute('hidden', '');
    modalPaperRow?.setAttribute('hidden', '');
    return;
  }

  // Print / Copy mode:
  pagesCard?.removeAttribute('hidden');
  colorCard?.removeAttribute('hidden');
  paperCard?.removeAttribute('hidden');
  settingsGrid?.removeAttribute('hidden');
  scanCard?.setAttribute('hidden', '');

  // 1. Pages & Range Card
  if (pagesRangeValue) {
    pagesRangeValue.textContent = pageRangeLabel(cfg.pageRange);
  }

  const quote = currentPrintQuote;
  const totalSheets = quote
    ? quote.selectedPages
    : (cfg.totalPages ?? 1);
  const totalDisplay = quote
    ? `${quote.selectedPages} of ${quote.totalPages} ${quote.totalPages === 1 ? 'page' : 'pages'}`
    : `${totalSheets} ${totalSheets === 1 ? 'page' : 'pages'}`;

  if (pagesTotalCount) {
    pagesTotalCount.textContent = totalDisplay;
  }

  if (quote) {
    if (pagesBwCount) pagesBwCount.textContent = `${quote.billableBwPages}`;
    if (pagesColorCount) pagesColorCount.textContent = `${quote.billableColorPages}`;
    bwPagesChip?.removeAttribute('hidden');
    colorPagesChip?.removeAttribute('hidden');
  } else {
    const isColor = cfg.colorMode === 'colored';
    if (pagesBwCount) pagesBwCount.textContent = isColor ? '0' : `${totalSheets}`;
    if (pagesColorCount) pagesColorCount.textContent = isColor ? `${totalSheets}` : '0';
  }

  // 2. Color Mode Card
  const displayColor = getDisplayColorMode();
  if (colorModePrimary) {
    colorModePrimary.textContent = formatColorMode(displayColor);
  }

  if (
    cfg.mode === 'print' &&
    cfg.detectedColorMode &&
    cfg.detectedColorMode !== cfg.colorMode
  ) {
    if (colorDetectedBadge) {
      colorDetectedBadge.textContent = `Detected: ${formatColorMode(cfg.detectedColorMode)}`;
      colorDetectedBadge.removeAttribute('hidden');
    }
    if (colorSelectedBadge) {
      colorSelectedBadge.textContent = `Selected: ${formatColorMode(cfg.colorMode)}`;
      colorSelectedBadge.removeAttribute('hidden');
    }
  } else {
    colorDetectedBadge?.setAttribute('hidden', '');
    colorSelectedBadge?.setAttribute('hidden', '');
  }

  // 3. Paper & Layout Card
  if (paperSizePrimary) {
    paperSizePrimary.textContent = formatPaperSizeForPricing(cfg.paperSize);
  }
  if (copiesTag) {
    copiesTag.textContent = `${cfg.copies} ${cfg.copies === 1 ? 'Copy' : 'Copies'}`;
  }
  if (orientationTag) {
    orientationTag.textContent =
      cfg.orientation === 'landscape' ? 'Landscape' : 'Portrait';
  }
  if (qualityTag) {
    qualityTag.textContent =
      cfg.quality === 'high' ? 'High Quality' : 'Standard';
  }
  if (rotationTag) {
    if (cfg.rotationDeg && cfg.rotationDeg !== 0) {
      rotationTag.textContent = `${cfg.rotationDeg}°`;
      rotationTag.removeAttribute('hidden');
    } else {
      rotationTag.setAttribute('hidden', '');
    }
  }

  // Populate modal quality if present
  if (modalQuality) {
    modalQuality.textContent =
      cfg.quality === 'high' ? 'High Quality' : 'Standard';
  }
}

populateJobSummary(config);
if (priceValue) priceValue.textContent = 'Loading...';

function applyLockState(locked: boolean): void {
  coinSlotIsLocked = locked;

  const paymentColEl = document.querySelector<HTMLElement>('.payment-col');
  const coinIcon = document.getElementById('coinIcon');
  const padlockIcon = document.getElementById('padlockIcon');
  const ctaText = document.querySelector<HTMLElement>('.payment-col__cta');

  if (locked) {
    paymentColEl?.classList.add('payment-col--locked');
    if (padlockIcon) padlockIcon.removeAttribute('hidden');
    if (coinLottieWrapper) coinLottieWrapper.setAttribute('hidden', '');
    if (coinIcon) coinIcon.setAttribute('hidden', '');
    coinLottiePlayer?.pause();
    if (ctaText) ctaText.textContent = 'Coin slot locked — ready to confirm';
  } else {
    paymentColEl?.classList.remove('payment-col--locked');
    if (coinLottieWrapper) coinLottieWrapper.removeAttribute('hidden');
    if (padlockIcon) padlockIcon.setAttribute('hidden', '');
    coinLottiePlayer?.play();
    if (ctaText)
      ctaText.textContent = 'Insert coins into the kiosk slot to pay';
  }
}

function syncCoinSlotLockState(): void {
  const shouldLock =
    pricingLoaded && totalPrice > 0 && currentBalance >= totalPrice;
  if (shouldLock === coinSlotIsLocked) return;

  applyLockState(shouldLock);
}

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

function sanitizeStatusBadgeMessage(msg: string): string {
  if (!msg) return msg;
  if (
    msg.length > 50 ||
    msg.includes('|') ||
    msg.toLowerCase().includes('post-clear') ||
    msg.toLowerCase().includes('hardware error') ||
    msg.toLowerCase().includes('epson popup')
  ) {
    return 'Printer attention needed. See instructions.';
  }
  return msg;
}

function applyConfirmGate(statusOverride?: string): void {
  if (!confirmBtn || !statusMessage) return;
  if (isProcessingPayment) {
    confirmBtn.disabled = true;
    confirmBtn.setAttribute('aria-disabled', 'true');
    if (statusBadge) statusBadge.dataset.state = 'waiting';
    return;
  }

  if (
    currentPrinterError &&
    (currentPrinterError.severity === 'fatal' ||
      currentPrinterError.severity === 'recoverable')
  ) {
    confirmBtn.disabled = true;
    confirmBtn.setAttribute('aria-disabled', 'true');
    statusMessage.textContent = sanitizeStatusBadgeMessage(
      statusOverride ?? currentPrinterError.userMessage,
    );
    if (statusBadge) statusBadge.dataset.state = 'error';
    return;
  }

  if (!pricingLoaded) {
    confirmBtn.disabled = true;
    confirmBtn.setAttribute('aria-disabled', 'true');
    statusMessage.textContent =
      statusOverride ?? pricingError ?? 'Loading pricing...';
    if (statusBadge) statusBadge.dataset.state = 'waiting';
    return;
  }

  if (!printerReady) {
    confirmBtn.disabled = true;
    confirmBtn.setAttribute('aria-disabled', 'true');
    statusMessage.textContent =
      statusOverride ??
      `Printer not ready (${latestPrinterStatusLabel}). Please wait before inserting coins.`;
    if (statusBadge) {
      statusBadge.dataset.state = latestPrinterStatusLabel.startsWith(
        'Checking',
      )
        ? 'waiting'
        : 'error';
    }
    return;
  }

  if (currentBalance >= totalPrice) {
    confirmBtn.disabled = false;
    confirmBtn.setAttribute('aria-disabled', 'false');
    confirmBtn.classList.add('is-ready');
    actionCol?.classList.add('is-ready');
    statusMessage.textContent =
      statusOverride ?? 'Sufficient balance detected. You can confirm now.';
    if (statusBadge) statusBadge.dataset.state = 'ready';
  } else {
    confirmBtn.classList.remove('is-ready');
    actionCol?.classList.remove('is-ready');
    const needed = totalPrice - currentBalance;
    confirmBtn.disabled = true;
    confirmBtn.setAttribute('aria-disabled', 'true');
    statusMessage.textContent = sanitizeStatusBadgeMessage(
      statusOverride ?? `Insert more coins: ₱ ${needed} remaining.`,
    );
    if (statusBadge) statusBadge.dataset.state = statusOverride ? 'error' : 'waiting';
  }
}

let displayedBalance = 0;
let balanceAnimFrameId: number | null = null;

function animateBalanceCounter(targetBalance: number): void {
  if (balanceAnimFrameId !== null) {
    cancelAnimationFrame(balanceAnimFrameId);
    balanceAnimFrameId = null;
  }

  const startBalance = displayedBalance;
  const diff = targetBalance - startBalance;

  if (diff > 0) {
    // Trigger pop bounce & shimmer animation on coin insertion
    if (balanceRing) {
      balanceRing.classList.remove('balance-pop');
      void balanceRing.offsetWidth;
      balanceRing.classList.add('balance-pop');
    }
    if (balanceValue) {
      balanceValue.classList.remove('count-anim');
      void balanceValue.offsetWidth;
      balanceValue.classList.add('count-anim');
    }
  }

  if (diff === 0) {
    displayedBalance = targetBalance;
    if (balanceValue) balanceValue.textContent = `₱ ${targetBalance}`;
    return;
  }

  const startTime = performance.now();
  const durationMs = 380;

  function step(currentTime: number): void {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / durationMs, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(startBalance + diff * ease);
    displayedBalance = current;
    if (balanceValue) balanceValue.textContent = `₱ ${current}`;

    if (progress < 1) {
      balanceAnimFrameId = requestAnimationFrame(step);
    } else {
      displayedBalance = targetBalance;
      if (balanceValue) balanceValue.textContent = `₱ ${targetBalance}`;
      balanceAnimFrameId = null;
    }
  }

  balanceAnimFrameId = requestAnimationFrame(step);
}

function updateBalanceRingArc(balance: number): void {
  if (balanceRing) {
    balanceRing.setAttribute('aria-valuenow', String(balance));
    balanceRing.setAttribute('aria-valuemax', String(totalPrice));
  }
  if (!balanceArc) return;
  const circumference = 326.7;
  const ratio =
    totalPrice > 0 ? Math.min(1, Math.max(0, balance / totalPrice)) : 0;
  const offset = circumference * (1 - ratio);
  balanceArc.style.strokeDashoffset = String(offset);

  if (balanceRing) {
    if (pricingLoaded && totalPrice > 0 && balance >= totalPrice) {
      balanceRing.classList.add('is-ready');
    } else {
      balanceRing.classList.remove('is-ready');
    }
  }
}

function updateBalanceUI(balance: number): void {
  currentBalance = balance;
  animateBalanceCounter(balance);
  updateBalanceRingArc(balance);
  updateChangeDisplay(balance);
  syncCoinSlotLockState();
  applyConfirmGate();
}

const MODE_TITLE = {
  print: 'Print in Progress',
  copy: 'Copy in Progress',
  scan: 'Scan in Progress',
} satisfies Record<'print' | 'copy' | 'scan', string>;

const PHASE_COPY: Record<
  'print' | 'copy' | 'scan',
  Record<
    'printing' | 'dispensing' | 'failed' | 'done' | 'manual-review',
    { subtitle: string; hint: string }
  >
> = {
  print: {
    printing: {
      subtitle: 'Printing your document…',
      hint: 'Do not turn off the machine.',
    },
    dispensing: {
      subtitle: 'Print done. Dispensing your coin change…',
      hint: 'Please wait until the dispenser completes.',
    },
    failed: {
      subtitle: 'Print finalization failed and needs review.',
      hint: 'Please contact staff for manual change settlement.',
    },
    'manual-review': {
      subtitle: 'Print status requires manual review before release.',
      hint: 'Please contact staff. Keep this screen open while recovery is verified.',
    },
    done: {
      subtitle: 'Print and change handling completed.',
      hint: 'Thank you for using PrintBit.',
    },
  },
  copy: {
    printing: {
      subtitle: 'Copying your document…',
      hint: 'Do not turn off the machine.',
    },
    dispensing: {
      subtitle: 'Copy done. Dispensing your coin change…',
      hint: 'Please wait until the dispenser completes.',
    },
    failed: {
      subtitle: 'Copy finalization failed and needs review.',
      hint: 'Please contact staff for manual change settlement.',
    },
    'manual-review': {
      subtitle: 'Copy status requires manual review before release.',
      hint: 'Please contact staff. Keep this screen open while recovery is verified.',
    },
    done: {
      subtitle: 'Copy and change handling completed.',
      hint: 'Thank you for using PrintBit.',
    },
  },
  scan: {
    printing: {
      subtitle: 'Processing your scan…',
      hint: 'Do not turn off the machine.',
    },
    dispensing: {
      subtitle: 'Scan done. Preparing your download QR code…',
      hint: 'Please wait for the download QR to appear.',
    },
    failed: {
      subtitle: 'Scan finalization failed and needs review.',
      hint: 'Please contact staff for assistance.',
    },
    'manual-review': {
      subtitle: 'Scan status requires manual review before release.',
      hint: 'Please contact staff. Keep this screen open while staff recovers your scan.',
    },
    done: {
      subtitle: 'Scan and download QR ready.',
      hint: "Scan your phone's camera at the QR code to download.",
    },
  },
};

function setPrintingPhase(
  phase: 'printing' | 'dispensing' | 'failed' | 'done' | 'manual-review',
): void {
  const mode =
    config.mode === 'copy' || config.mode === 'scan' ? config.mode : 'print';
  const copy = PHASE_COPY[mode][phase];
  if (printingSubtitle) printingSubtitle.textContent = copy.subtitle;
  if (printingHint) printingHint.textContent = copy.hint;
  if (printingTitle) printingTitle.textContent = MODE_TITLE[mode];
  if (phase === 'printing' && printingStage) {
    printingStage.textContent = 'Preparing your print job…';
  }
}

/**
 * Updates the printing overlay's progress indicator from a
 * `printLifecycleState` payload. Called whenever a 'processing' transition
 * arrives with `pagesPrinted` set. The block stays hidden on the very first
 * call (the call must reveal text + bar), then updates are progressively
 * cheap text/bar mutations.
 */
function renderPrintProgress(input: {
  pagesPrinted?: number | null;
  totalPages?: number | null;
}): void {
  const pagesPrinted =
    typeof input.pagesPrinted === 'number' &&
    Number.isFinite(input.pagesPrinted)
      ? Math.max(0, Math.floor(input.pagesPrinted))
      : null;
  if (pagesPrinted === null) return;

  const totalPages =
    typeof input.totalPages === 'number' &&
    Number.isFinite(input.totalPages) &&
    input.totalPages > 0
      ? Math.floor(input.totalPages)
      : null;

  const currentPage = getMonotonicPrintedPages({
    displayedPages: displayedPrintPages,
    incomingPages: pagesPrinted,
    totalPages,
  });
  displayedPrintPages = currentPage;

  if (printingProgressCurrent) {
    printingProgressCurrent.textContent = String(currentPage);
  }
  if (printingProgressTotal) {
    printingProgressTotal.textContent =
      totalPages !== null ? String(totalPages) : '—';
  }

  const stage = getPrintingStage({ pagesPrinted: currentPage, totalPages });
  if (printingStage) printingStage.textContent = stage.label;
  if (printingProgressFill && stage.progress !== null) {
    printingProgressFill.style.setProperty(
      '--progress-scale',
      String(stage.progress / 100),
    );
  }
  if (printingProgressBar && stage.progress !== null) {
    printingProgressBar.setAttribute('aria-valuenow', String(stage.progress));
    printingProgressBar.setAttribute(
      'aria-valuetext',
      totalPages === null
        ? `${currentPage} pages printed`
        : `${currentPage} of ${totalPages} pages printed`,
    );
  }

  if (printingProgressText) printingProgressText.removeAttribute('hidden');
  if (printingProgressBar) printingProgressBar.removeAttribute('hidden');
}

/**
 * Hides and resets the progress indicator. Called on terminal states
 * (printed / failed / paused) so the next session starts clean.
 */
function hidePrintProgress(): void {
  displayedPrintPages = 0;
  if (printingProgressText) printingProgressText.setAttribute('hidden', '');
  if (printingProgressBar) printingProgressBar.setAttribute('hidden', '');
  if (printingProgressFill) {
    printingProgressFill.style.setProperty('--progress-scale', '0');
  }
  if (printingProgressBar) {
    printingProgressBar.setAttribute('aria-valuenow', '0');
    printingProgressBar.removeAttribute('aria-valuetext');
  }
  if (printingProgressCurrent) printingProgressCurrent.textContent = '0';
  if (printingProgressTotal) printingProgressTotal.textContent = '0';
}

function showInitialPrintProgress(): void {
  if (config.mode !== 'print') return;

  const selectedPages =
    currentPrintQuote?.selectedPages ?? config.totalPages ?? 1;
  renderPrintProgress({
    pagesPrinted: 0,
    totalPages: getExpectedPrintPages({
      selectedPages,
      copies: config.copies,
    }),
  });
}

async function fetchInitialBalance(): Promise<void> {
  const response = await fetch('/api/balance');
  const data = (await response.json()) as { balance: number };
  updateBalanceUI(data.balance ?? 0);
}

async function loadPricing(): Promise<void> {
  if (config.mode === 'print' || config.mode === 'copy') {
    try {
      if (config.mode === 'print' && !config.sessionId) {
        throw new Error('Print session is required.');
      }
      if (config.mode === 'copy' && !config.copyPreviewPath) {
        throw new Error('Copy preview is required.');
      }

      const endpoint =
        config.mode === 'print' ? '/api/print/quote' : '/api/copy/quote';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          copies: config.copies,
          colorMode: config.colorMode,
          quality: config.quality,
          orientation: config.orientation,
          rotationDeg: config.rotationDeg,
          paperSize: config.paperSize,
          pageRange: config.pageRange,
          ...(config.mode === 'print'
            ? {
                sessionId: config.sessionId,
                documentId:
                  config.documentId ?? uploadedDocumentId ?? undefined,
              }
            : {
                copyPreviewPath: config.copyPreviewPath,
              }),
        }),
      });

      const payload = (await response.json()) as {
        error?: string;
        quote?: PrintQuote;
      };
      if (!response.ok || !payload.quote) {
        throw new Error(
          payload.error ??
            `Failed to load ${config.mode === 'print' ? 'print' : 'copy'} quote.`,
        );
      }

      currentPrintQuote = payload.quote;
      totalPrice = payload.quote.requiredAmount;
      pricingLoaded = true;
      pricingError = null;
      if (priceValue) priceValue.textContent = `₱ ${totalPrice}`;
      if (actionPriceValue) actionPriceValue.textContent = `₱ ${totalPrice}`;
      populateJobSummary(config);
      updateBalanceRingArc(currentBalance);
      updateChangeDisplay(currentBalance);
      syncCoinSlotLockState();
      applyConfirmGate();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Failed to load ${config.mode === 'print' ? 'print' : 'copy'} quote.`;
      currentPrintQuote = null;
      totalPrice = 0;
      pricingLoaded = false;
      pricingError = message;
      if (priceValue) priceValue.textContent = 'Unavailable';
      if (actionPriceValue) actionPriceValue.textContent = '₱ 0';
      updateChangeDisplay(currentBalance);
      syncCoinSlotLockState();
      applyConfirmGate();
    }
    return;
  }

  const response = await fetch('/api/pricing');
  if (!response.ok) throw new Error('Pricing request failed.');

  const payload = (await response.json()) as Partial<PricingResponse>;
  const safePricing = {
    scanDocument: payload.scanDocument ?? DEFAULT_PRICING.scanDocument,
  };

  totalPrice = safePricing.scanDocument;
  pricingLoaded = true;
  pricingError = null;
  if (priceValue) priceValue.textContent = `₱ ${totalPrice}`;
  if (actionPriceValue) actionPriceValue.textContent = `₱ ${totalPrice}`;
  updateChangeDisplay(currentBalance);
  syncCoinSlotLockState();
  applyConfirmGate();
}

// Modal declarations removed (moved to top of file)

let isProcessingPayment = false;
let activeSpoolerCorrelationKey: string | null = null;
const persistedSpoolerCorrelationKeyRaw = sessionStorage.getItem(
  PENDING_PAYMENT_SPOOLER_STORAGE_KEY,
);
const persistedPaymentFingerprintRaw = sessionStorage.getItem(
  PENDING_PAYMENT_FINGERPRINT_STORAGE_KEY,
);
const persistedFingerprintMatchesCurrent =
  (config.mode === 'print' || config.mode === 'copy') &&
  persistedPaymentFingerprintRaw === currentPaymentFingerprint;
const persistedSpoolerCorrelationKey =
  persistedFingerprintMatchesCurrent &&
  persistedSpoolerCorrelationKeyRaw?.trim().length
    ? persistedSpoolerCorrelationKeyRaw.trim()
    : null;
const persistedPaymentIdempotencyKeyRaw = sessionStorage.getItem(
  PENDING_PAYMENT_IDEMPOTENCY_STORAGE_KEY,
);
const persistedPaymentIdempotencyKey =
  persistedFingerprintMatchesCurrent &&
  persistedPaymentIdempotencyKeyRaw?.trim().length
    ? persistedPaymentIdempotencyKeyRaw.trim()
    : null;
let paymentSpoolerCorrelationKey: string | null =
  persistedSpoolerCorrelationKey;
let paymentIdempotencyKey: string | null = persistedPaymentIdempotencyKey;
if (!persistedFingerprintMatchesCurrent) {
  sessionStorage.removeItem(PENDING_PAYMENT_SPOOLER_STORAGE_KEY);
  sessionStorage.removeItem(PENDING_PAYMENT_IDEMPOTENCY_STORAGE_KEY);
  sessionStorage.removeItem(PENDING_PAYMENT_FINGERPRINT_STORAGE_KEY);
}
let latestPrinterStatusLabel = 'Checking...';

const NETWORK_REQUEST_TIMEOUT_MS = 90_000;

let currentTransactionId: string | null = null;
let currentScanDownloadUrl: string | null = null;
let currentScanDownloadExpiry: string | null = null;

function setTransactionReference(id: string | null): void {
  currentTransactionId = id?.trim().length ? id.trim() : null;
  powerSafetyOverlay.setTransactionReference(currentTransactionId);
  if (!transactionReference) return;
  if (currentTransactionId) {
    transactionReference.textContent = `Reference ID: ${currentTransactionId}`;
    transactionReference.removeAttribute('hidden');
  } else {
    transactionReference.textContent = 'Reference ID: —';
    transactionReference.setAttribute('hidden', '');
  }
}

function extractReceiptUrl(
  payload: ReceiptLinkPayload,
): { url: string; expiresAt: string | null } | null {
  const url =
    payload.receipt?.viewUrl || payload.receiptViewUrl || payload.receipt?.url;
  if (!url) return null;
  return {
    url,
    expiresAt: payload.receipt?.expiresAt || payload.receiptExpiresAt || null,
  };
}

/** For copy mode: poll the copy job endpoint to get receipt data after async settlement. */
async function pollCopyJobReceipt(jobId: string): Promise<void> {
  const maxAttempts = 15;
  const intervalMs = 2000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(`/api/copy/jobs/${encodeURIComponent(jobId)}`);
      if (!res.ok) break;
      const job = (await res.json()) as {
        receipt?: { viewUrl?: string; expiresAt?: string };
        transactionId?: string;
        id?: string;
      };
      if (job.receipt?.viewUrl) {
        const txId = job.transactionId ?? job.id ?? null;
        if (txId) setTransactionReference(txId);
        captureReceiptCta(
          {
            receipt: {
              viewUrl: job.receipt.viewUrl,
              expiresAt: job.receipt.expiresAt ?? null,
            },
          },
          {
            transactionId: txId,
            spoolerCorrelationKey:
              activeSpoolerCorrelationKey ?? paymentSpoolerCorrelationKey,
          },
        );
        return;
      }
    } catch {
      // Ignore fetch errors, retry
    }
    await new Promise<void>((resolve) =>
      window.setTimeout(resolve, intervalMs),
    );
  }
}

function renderReceiptCta(): void {
  const receipt = confirmationOutcome.receipt;
  if (!receiptCtaContainer || !receiptQrCanvas || !receipt) return;
  receiptCtaContainer.removeAttribute('hidden');
  if (receiptQrExpiry) {
    if (receipt.expiresAt) {
      try {
        const expDate = new Date(receipt.expiresAt);
        receiptQrExpiry.textContent = `Valid until ${expDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      } catch {
        receiptQrExpiry.textContent = 'Valid for 15 minutes';
      }
    } else {
      receiptQrExpiry.textContent = 'Valid for 15 minutes';
    }
  }

  const isDual = thankYouModalSheet?.classList.contains('modal-sheet--dual-qr');
  const qrSize = isDual ? 200 : 220;

  QRCode.toCanvas(receiptQrCanvas, receipt.url, {
    width: qrSize,
    margin: 2,
    color: { dark: '#0e0d1f', light: '#ffffff' },
    errorCorrectionLevel: 'M',
  }).catch(console.error);
}

function renderMaintenanceResolution(): void {
  const view = buildMaintenanceReceiptView({
    transactionId: currentTransactionId,
    receiptUrl: confirmationOutcome.receipt?.url ?? null,
    receiptExpiresAt: confirmationOutcome.receipt?.expiresAt ?? null,
  });

  if (!view.receipt || !maintenanceReceiptQrCanvas) {
    maintenanceReceiptContainer?.setAttribute('hidden', '');
    maintenanceReceiptPending?.removeAttribute('hidden');
    return;
  }

  maintenanceReceiptPending?.setAttribute('hidden', '');
  maintenanceReceiptContainer?.removeAttribute('hidden');
  if (maintenanceReceiptQrExpiry) {
    if (view.receipt.expiresAt) {
      const expiry = new Date(view.receipt.expiresAt);
      maintenanceReceiptQrExpiry.textContent = Number.isNaN(expiry.getTime())
        ? 'Valid for 15 minutes'
        : `Valid until ${expiry.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      maintenanceReceiptQrExpiry.textContent = 'Valid for 15 minutes';
    }
  }

  QRCode.toCanvas(maintenanceReceiptQrCanvas, view.receipt.url, {
    width: 220,
    margin: 2,
    color: { dark: '#0e0d1f', light: '#ffffff' },
    errorCorrectionLevel: 'M',
  }).catch(console.error);
}

function captureReceiptCta(
  payload: ReceiptLinkPayload,
  identity: Partial<ConfirmationOutcomeIdentity> = {
    transactionId: currentTransactionId,
    spoolerCorrelationKey:
      activeSpoolerCorrelationKey ?? paymentSpoolerCorrelationKey,
  },
): void {
  const receipt = extractReceiptUrl(payload);
  if (!receipt) return;
  confirmationOutcome = applyConfirmationEvidence(confirmationOutcome, {
    type: 'receipt-available',
    identity,
    receipt,
  });
  renderReceiptCta();
  if (confirmationOutcome.outcome === 'maintenance') {
    renderMaintenanceResolution();
  }
}

function renderScanDownloadCta(): void {
  if (
    !scanDownloadCtaContainer ||
    !scanDownloadQrCanvas ||
    !currentScanDownloadUrl
  )
    return;
  scanDownloadCtaContainer.removeAttribute('hidden');

  let scanFormat = 'pdf';
  try {
    const raw = sessionStorage.getItem('printbit.config');
    if (raw) {
      const cfg = JSON.parse(raw) as { scanFormat?: string; scanFilename?: string };
      if (cfg.scanFormat) {
        scanFormat = cfg.scanFormat.toLowerCase();
      } else if (cfg.scanFilename) {
        const ext = cfg.scanFilename.split('.').pop()?.toLowerCase();
        if (ext === 'jpg' || ext === 'jpeg') scanFormat = 'jpg';
        else if (ext === 'png') scanFormat = 'png';
      }
    }
  } catch {
    // default to pdf
  }

  if (scanDownloadTitle && scanDownloadFormatTag && scanDownloadHint) {
    if (scanFormat === 'jpg') {
      scanDownloadFormatTag.textContent = 'JPG';
      scanDownloadFormatTag.className = 'qr-card__format-tag qr-card__format-tag--jpg';
      scanDownloadTitle.textContent = 'Download as Image (JPG)';
      scanDownloadHint.textContent = 'Direct scan to save photo to your phone camera roll';
    } else if (scanFormat === 'png') {
      scanDownloadFormatTag.textContent = 'PNG';
      scanDownloadFormatTag.className = 'qr-card__format-tag qr-card__format-tag--png';
      scanDownloadTitle.textContent = 'Download as Image (PNG)';
      scanDownloadHint.textContent = 'Direct scan to save lossless image to your phone';
    } else {
      scanDownloadFormatTag.textContent = 'PDF';
      scanDownloadFormatTag.className = 'qr-card__format-tag';
      scanDownloadTitle.textContent = 'Download as PDF';
      scanDownloadHint.textContent = 'Direct scan to download soft copy to your phone';
    }
  }

  if (scanDownloadQrExpiry) {
    if (currentScanDownloadExpiry) {
      try {
        const expDate = new Date(currentScanDownloadExpiry);
        scanDownloadQrExpiry.textContent = `Valid until ${expDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      } catch {
        scanDownloadQrExpiry.textContent = 'Valid for 15 minutes';
      }
    } else {
      scanDownloadQrExpiry.textContent = 'Valid for 15 minutes';
    }
  }

  QRCode.toCanvas(scanDownloadQrCanvas, currentScanDownloadUrl, {
    width: 200,
    margin: 2,
    color: { dark: '#0e0d1f', light: '#ffffff' },
    errorCorrectionLevel: 'M',
  }).catch(console.error);
}

function captureScanDownloadCta(
  link?: {
    downloadUrl?: string | null;
    expiresAt?: string | null;
  } | null,
): void {
  if (!link?.downloadUrl) return;
  currentScanDownloadUrl = link.downloadUrl;
  currentScanDownloadExpiry = link.expiresAt ?? null;
  renderScanDownloadCta();
}

function finalizePrintSuccess(
  transactionId: string | null,
  spoolerCorrelationKey: string | null =
    activeSpoolerCorrelationKey ?? paymentSpoolerCorrelationKey,
): void {
  const effectiveTxId = transactionId ?? currentTransactionId;
  if (!recordConfirmationTerminalSuccess({ transactionId: effectiveTxId, spoolerCorrelationKey })) {
    console.warn(
      '[PRINT] Ignoring success event because this job already failed',
      { transactionId: effectiveTxId, spoolerCorrelationKey },
    );
    return;
  }

  setTransactionReference(effectiveTxId);
  hideOverlay(printingOverlay);
  hidePrintProgress();

  if (pendingOwedChange && pendingOwedChange.amountOwed > 0) {
    const owedRef =
      effectiveTxId || pendingOwedChange.transactionId || 'Contact Staff';
    if (owedChangeAmountBadge) {
      owedChangeAmountBadge.textContent = `₱${pendingOwedChange.amountOwed} Owed`;
    }
    if (owedChangeAmountText) {
      owedChangeAmountText.textContent = String(pendingOwedChange.amountOwed);
    }
    if (owedChangeRefId) {
      owedChangeRefId.textContent = owedRef;
    }
    if (owedChangeAlert) {
      owedChangeAlert.removeAttribute('hidden');
    }
  } else {
    if (owedChangeAlert) {
      owedChangeAlert.setAttribute('hidden', '');
    }
  }

  if (thankYouTitle) {
    if (config.mode === 'copy') {
      thankYouTitle.textContent = 'Copy complete';
    } else if (config.mode === 'scan') {
      thankYouTitle.textContent = 'Scan complete';
    } else {
      thankYouTitle.textContent = 'Document printed';
    }
  }

  if (thankYouSubtitle) {
    if (config.mode === 'copy') {
      thankYouSubtitle.textContent =
        'Your document has been copied successfully.';
    } else if (config.mode === 'scan') {
      thankYouSubtitle.textContent =
        'Your document has been scanned successfully.';
    } else {
      thankYouSubtitle.textContent =
        'Your document has been printed successfully.';
    }
  }

  if (config.mode === 'scan') {
    collectionCallout?.setAttribute('hidden', '');
    if (thankYouModalSheet) {
      thankYouModalSheet.classList.add('modal-sheet--dual-qr');
    }
    renderScanDownloadCta();
    renderReceiptCta();
  } else {
    collectionCallout?.removeAttribute('hidden');
    if (thankYouModalSheet) {
      thankYouModalSheet.classList.remove('modal-sheet--dual-qr');
    }
    if (scanDownloadCtaContainer) {
      scanDownloadCtaContainer.setAttribute('hidden', '');
    }
    renderReceiptCta();
  }

  showOverlay(thankYouOverlay);
  clearPendingPaymentSessionState();
  activeSpoolerCorrelationKey = null;
  if (statusMessage) {
    statusMessage.textContent =
      config.mode === 'scan'
        ? 'Scan complete. Thank you!'
        : config.mode === 'copy'
          ? 'Copy complete. Thank you!'
          : 'Printing complete. Thank you!';
  }
  isProcessingPayment = false;
  powerSafetyOverlay.notifyPrintCompleted();

  if (printAnotherBtn) {
    printAnotherBtn.removeAttribute('hidden');
    const btnSpan = printAnotherBtn.querySelector('span');
    if (btnSpan) {
      if (config.mode === 'copy') {
        btnSpan.textContent = 'Copy Another Document';
      } else if (config.mode === 'scan') {
        btnSpan.textContent = 'Scan Another Document';
      } else {
        btnSpan.textContent = 'Print Another File';
      }
    }
  }

  applyConfirmGate();
  void checkRemainingFilesAndPrompt();
}

function enterWorkerPendingState(transactionId: string | null): void {
  setTransactionReference(transactionId);
  activeSpoolerCorrelationKey = paymentSpoolerCorrelationKey;
  restoreConfirmationPending({
    transactionId,
    spoolerCorrelationKey: activeSpoolerCorrelationKey,
  });
  if (confirmationOutcome.outcome === 'maintenance') {
    hideOverlay(printingOverlay);
    renderMaintenanceResolution();
    return;
  }
  if (statusMessage) {
    statusMessage.textContent =
      config.mode === 'copy'
        ? 'Payment confirmed. Waiting for the worker to start copying.'
        : 'Payment confirmed. Waiting for the worker to start printing.';
  }
  // Show the printing overlay in a worker-pending state
  showOverlay(printingOverlay);
  setPrintingPhase('printing');
  showInitialPrintProgress();
}

function matchesPendingWorkerEvent(payload: {
  transactionId?: string | null;
  spoolerCorrelationKey?: string | null;
}): boolean {
  const payloadTransactionId =
    typeof payload.transactionId === 'string' ? payload.transactionId : null;
  const payloadSpoolerKey =
    typeof payload.spoolerCorrelationKey === 'string'
      ? payload.spoolerCorrelationKey
      : null;

  if (currentTransactionId && payloadTransactionId === currentTransactionId) {
    return true;
  }

  return Boolean(
    paymentSpoolerCorrelationKey &&
    payloadSpoolerKey &&
    payloadSpoolerKey === paymentSpoolerCorrelationKey,
  );
}

function syncPendingPaymentSessionState(): void {
  if (config.mode !== 'print' && config.mode !== 'copy') return;
  if (paymentIdempotencyKey)
    sessionStorage.setItem(
      PENDING_PAYMENT_IDEMPOTENCY_STORAGE_KEY,
      paymentIdempotencyKey,
    );
  if (paymentSpoolerCorrelationKey) {
    sessionStorage.setItem(
      PENDING_PAYMENT_SPOOLER_STORAGE_KEY,
      paymentSpoolerCorrelationKey,
    );
    sessionStorage.setItem(
      PENDING_PAYMENT_FINGERPRINT_STORAGE_KEY,
      currentPaymentFingerprint,
    );
  }
}

function clearPendingPaymentSessionState(): void {
  paymentIdempotencyKey = null;
  paymentSpoolerCorrelationKey = null;
  sessionStorage.removeItem(PENDING_PAYMENT_IDEMPOTENCY_STORAGE_KEY);
  sessionStorage.removeItem(PENDING_PAYMENT_SPOOLER_STORAGE_KEY);
  sessionStorage.removeItem(PENDING_PAYMENT_FINGERPRINT_STORAGE_KEY);
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = NETWORK_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutHandle = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutHandle);
  }
}

function showModal(): void {
  if (!confirmModal) return;

  if (modalTitle) {
    modalTitle.textContent =
      config.mode === 'print'
        ? 'Ready to Print?'
        : config.mode === 'copy'
          ? 'Ready to Copy?'
          : 'Ready to Download?';
  }

  if (modalSubtitle) {
    modalSubtitle.textContent =
      config.mode === 'scan'
        ? 'Please review your scan details before continuing.'
        : 'Review your settings and total before printing.';
  }

  if (modalPaperAlert) {
    if (config.mode === 'scan') {
      modalPaperAlert.setAttribute('hidden', '');
    } else {
      modalPaperAlert.removeAttribute('hidden');
      if (modalPaperAlertSize) {
        modalPaperAlertSize.textContent = formatPaperSizeForPricing(
          config.paperSize,
        );
      }
    }
  }

  // Scan jobs have no physical paper tray to check — start directly on the
  // review/pay step. Print and copy jobs start on the tray-check step.
  if (confirmModal) {
    confirmModal.dataset.step = config.mode === 'scan' ? 'review' : 'tray';
  }

  if (modalFile) {
    const rawFileName =
      config.mode === 'print'
        ? (uploadedFile ?? 'No file')
        : config.mode === 'copy'
          ? 'Physical document copy'
          : (config.scanFilename ?? 'Scanned document');
    modalFile.textContent = truncateFilename(rawFileName, 32);
    modalFile.setAttribute('title', rawFileName);
    modalFile.setAttribute('aria-label', `Document: ${rawFileName}`);
  }
  if (modalMode) modalMode.textContent = config.mode.toUpperCase();

  if (config.mode !== 'scan') {
    if (modalColor) modalColor.textContent = getColorModeSummaryLabel();
    if (modalCopies) modalCopies.textContent = String(config.copies);
    if (modalPages) {
      if (currentPrintQuote) {
        modalPages.textContent = `${pageRangeLabel(config.pageRange)} (${currentPrintQuote.selectedPages} of ${currentPrintQuote.totalPages} pages)`;
      } else {
        modalPages.textContent = pageRangeLabel(config.pageRange);
      }
    }
    if (modalOrientation) {
      modalOrientation.textContent =
        config.orientation === 'landscape' ? 'Landscape' : 'Portrait';
    }
    if (modalRotation) modalRotation.textContent = `${config.rotationDeg}°`;
    if (modalRotationRow) {
      if (config.rotationDeg && config.rotationDeg !== 0) {
        modalRotationRow.removeAttribute('hidden');
      } else {
        modalRotationRow.setAttribute('hidden', '');
      }
    }
    if (modalPaper)
      modalPaper.textContent = formatPaperSizeForPricing(config.paperSize);
  }

  if (modalPrice) modalPrice.textContent = `₱ ${totalPrice}`;
  if (modalPaid) modalPaid.textContent = `₱ ${currentBalance}`;

  // Show coin change in modal
  const modalChangeAmount = Math.max(0, currentBalance - totalPrice);
  if (modalChange) {
    modalChange.textContent = `₱ ${modalChangeAmount}`;
  }

  confirmModal.classList.add('is-visible');
  confirmModal.setAttribute('aria-hidden', 'false');
  modalCancelBtn?.focus();
}

function hideModal(): void {
  confirmModal?.classList.remove('is-visible');
  confirmModal?.setAttribute('aria-hidden', 'true');
  confirmBtn?.focus();
}

function showOverlay(el: HTMLElement | null): void {
  if (!el) return;
  if (el === printingOverlay) confirmLoadingController?.setActive(true);
  el.classList.add('is-visible');
  el.setAttribute('aria-hidden', 'false');
}

function hideOverlay(el: HTMLElement | null): void {
  if (!el) return;
  if (el === printingOverlay) confirmLoadingController?.setActive(false);
  el.classList.remove('is-visible');
  el.setAttribute('aria-hidden', 'true');
}

function clearConfirmSessionStorage(): void {
  confirmationOutcome = createConfirmationOutcomeState();
  setTransactionReference(null);
  pendingOwedChange = null;
  if (owedChangeAlert) {
    owedChangeAlert.setAttribute('hidden', '');
  }
  clearPendingPaymentSessionState();
  sessionStorage.removeItem('printbit.config');
  sessionStorage.removeItem('printbit.copyPreviewPath');
  sessionStorage.removeItem('printbit.copyPreviewReleaseToken');
  sessionStorage.removeItem('printbit.uploadedFile');
  sessionStorage.removeItem('printbit.uploadedDocumentId');
  sessionStorage.removeItem('printbit.sessionId');
  sessionStorage.removeItem('printbit.sessionToken');
}

async function checkRemainingFilesAndPrompt(): Promise<void> {
  if (config.mode !== 'print' || !config.sessionId) {
    // No auto-redirect: user taps Done when ready
    return;
  }
  // Simplified for brevity — no auto-redirect
}

confirmBtn?.addEventListener('click', () => showModal());
modalCancelBtn?.addEventListener('click', () => {
  // On the review step, "Back to Paper Check" steps back rather than closing —
  // hideModal() stays a full close for everywhere else that calls it
  // (including modalConfirmBtn's handler below, which depends on that).
  if (!confirmModal) return;
  if (confirmModal.dataset.step === 'review') {
    confirmModal.dataset.step = 'tray';
    modalTrayOkBtn?.focus();
  } else {
    hideModal();
  }
});

modalTrayOkBtn?.addEventListener('click', () => {
  if (!confirmModal) return;
  confirmModal.dataset.step = 'review';
  modalCancelBtn?.focus();
});

modalTrayIssueBtn?.addEventListener('click', () => {
  hideModal();
});

trayIssueDoneBtn?.addEventListener('click', () => {
  hideOverlay(trayIssueOverlay);
  showModal();
});

modalConfirmBtn?.addEventListener('click', async () => {
  modalConfirmBtn.disabled = true;
  hideModal();
  confirmBtn.disabled = true;
  isProcessingPayment = true;
  showOverlay(printingOverlay);
  setPrintingPhase('printing');
  showInitialPrintProgress();

  try {
    if (config.mode === 'scan') {
      // Scan Soft Copy fee payment
      const response = await fetchWithTimeout('/api/scanner/soft-copy/charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: config.scanFilename,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Scan payment failed');
      }

      const payload = (await response.json()) as ReceiptLinkPayload & {
        transactionId?: string | null;
      };
      captureReceiptCta(payload, {
        transactionId: payload.transactionId ?? null,
      });
      captureScanDownloadCta(payload.downloadLink);

      // Fallback: create wireless link if charge response did not include it
      if (!currentScanDownloadUrl && config.scanFilename) {
        try {
          const linkRes = await fetchWithTimeout('/api/scanner/wireless-link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filename: config.scanFilename,
              orientation: config.orientation,
              rotationDeg: config.rotationDeg,
            }),
          });
          if (linkRes.ok) {
            const linkData = (await linkRes.json()) as {
              downloadUrl?: string;
              expiresAt?: string;
            };
            captureScanDownloadCta(linkData);
          }
        } catch {
          // Ignore fallback error if failed
        }
      }

      finalizePrintSuccess(payload.transactionId ?? null);
    } else if (config.mode === 'copy') {
      // Copy (Scan to Print) job creation
      const spoolerCorrelationKey =
        paymentSpoolerCorrelationKey ?? createSpoolerCorrelationKey();
      paymentSpoolerCorrelationKey = spoolerCorrelationKey;
      paymentIdempotencyKey =
        paymentIdempotencyKey ?? createPaymentIdempotencyKey();
      syncPendingPaymentSessionState();

      const response = await fetchWithTimeout('/api/copy/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Idempotency-Key': paymentIdempotencyKey,
        },
        body: JSON.stringify({
          amount: totalPrice,
          ...buildPhysicalPrintSettings(config, getDisplayColorMode()),
          previewPath: config.copyPreviewPath,
          spoolerCorrelationKey,
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        let errData: Record<string, unknown> = {};
        try {
          if (errText) errData = JSON.parse(errText);
        } catch {
          // Response is non-JSON (e.g. HTML or raw string)
        }
        if (errData.printError) {
          renderPrinterError(errData.printError as PrintError);
          throw new Error(
            (errData.printError as PrintError).userMessage || 'Copy job failed',
          );
        }
        const errorMsg =
          (typeof errData.error === 'string' && errData.error.trim()) ||
          (errText && !errText.startsWith('<')
            ? errText.slice(0, 150)
            : null) ||
          `Copy job failed (${response.status} ${response.statusText || 'Error'})`;
        throw new Error(errorMsg);
      }

      const payload = (await response.json()) as ReceiptLinkPayload & {
        id?: string;
        transactionId?: string | null;
      };
      // For copy jobs, the ID is often in 'id' field of the job object
      const transactionId = payload.transactionId ?? payload.id ?? null;
      captureReceiptCta(payload, {
        transactionId,
        spoolerCorrelationKey,
      });
      if (!payload.receipt?.viewUrl && payload.id) {
        void pollCopyJobReceipt(payload.id);
      }
      enterWorkerPendingState(transactionId);
    } else {
      // Print implementation...
      const spoolerCorrelationKey =
        paymentSpoolerCorrelationKey ?? createSpoolerCorrelationKey();
      paymentSpoolerCorrelationKey = spoolerCorrelationKey;
      paymentIdempotencyKey =
        paymentIdempotencyKey ?? createPaymentIdempotencyKey();
      syncPendingPaymentSessionState();

      const response = await fetchWithTimeout('/api/confirm-payment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Idempotency-Key': paymentIdempotencyKey,
        },
        body: JSON.stringify({
          amount: totalPrice,
          mode: config.mode,
          sessionId: config.sessionId,
          documentId: config.documentId,
          ...buildPhysicalPrintSettings(config, getDisplayColorMode()),
          spoolerCorrelationKey,
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        let errData: Record<string, unknown> = {};
        try {
          if (errText) errData = JSON.parse(errText);
        } catch {
          // Response is non-JSON (e.g. HTML or raw string)
        }
        if (errData.printError) {
          renderPrinterError(errData.printError as PrintError);
          throw new Error(
            (errData.printError as PrintError).userMessage || 'Payment failed',
          );
        }
        const errorMsg =
          (typeof errData.error === 'string' && errData.error.trim()) ||
          (errText && !errText.startsWith('<')
            ? errText.slice(0, 150)
            : null) ||
          `Payment failed (${response.status} ${response.statusText || 'Error'})`;
        throw new Error(errorMsg);
      }

      const payload = (await response.json()) as ReceiptLinkPayload & {
        transactionId?: string | null;
      };
      captureReceiptCta(payload, {
        transactionId: payload.transactionId ?? null,
        spoolerCorrelationKey,
      });
      enterWorkerPendingState(payload.transactionId ?? null);
    }
  } catch (error) {
    hideOverlay(printingOverlay);
    isProcessingPayment = false;
    powerSafetyOverlay.notifyPrintCompleted();
    const message =
      error instanceof Error ? error.message : 'Error processing payment.';
    applyConfirmGate(message);
  }
});

thankYouDoneBtn?.addEventListener('click', () => {
  clearConfirmSessionStorage();
  navigateWithKioskMotion('/');
});

maintenanceDoneBtn?.addEventListener('click', () => {
  clearConfirmSessionStorage();
  navigateWithKioskMotion('/');
});

printAnotherBtn?.addEventListener('click', () => {
  setTransactionReference(null);
  pendingOwedChange = null;
  if (owedChangeAlert) {
    owedChangeAlert.setAttribute('hidden', '');
  }
  clearPendingPaymentSessionState();
  sessionStorage.removeItem('printbit.config');
  sessionStorage.removeItem('printbit.copyPreviewPath');
  sessionStorage.removeItem('printbit.copyPreviewReleaseToken');

  if (config.mode === 'print') {
    // Keep sessionId, sessionToken, uploadedFile, etc. for remaining files
    navigateWithKioskMotion('/print');
  } else if (config.mode === 'copy') {
    sessionStorage.removeItem('printbit.uploadedFile');
    sessionStorage.removeItem('printbit.uploadedDocumentId');
    sessionStorage.removeItem('printbit.sessionId');
    sessionStorage.removeItem('printbit.sessionToken');
    navigateWithKioskMotion('/copy');
  } else if (config.mode === 'scan') {
    sessionStorage.removeItem('printbit.uploadedFile');
    sessionStorage.removeItem('printbit.uploadedDocumentId');
    sessionStorage.removeItem('printbit.sessionId');
    sessionStorage.removeItem('printbit.sessionToken');
    navigateWithKioskMotion('/scan');
  }
});

const ioFactory = (window as unknown as { io?: SocketIoFactory }).io;
if (typeof ioFactory === 'function') {
  const connectedSocket = ioFactory() as SocketLike;
  socket = connectedSocket;

  // Attach the power safety overlay now that socket is initialized.
  // Passing the live socket instance (not a getter) avoids the fallback
  // ioFactory() path inside the overlay that would otherwise create a
  // redundant, unmanaged Socket.IO connection.
  powerSafetyOverlay = attachPowerSafetyOverlay({
    socket: connectedSocket,
    isPrintInFlight: () => hasActiveJob(),
  });

  connectedSocket.on('balance', (amount: unknown) => {
    if (typeof amount === 'number') updateBalanceUI(amount);
  });

  connectedSocket.on('changeDispenseStatus', (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as {
      state?: 'dispensing' | 'dispensed' | 'failed';
      amount?: number;
      dispensed?: number;
      owedChangeId?: string | null;
      message?: string;
      transactionId?: string | null;
    };
    if (data.transactionId) {
      setTransactionReference(data.transactionId);
    }
    if (data.state === 'dispensing') {
      setPrintingPhase('dispensing');
    } else if (data.state === 'failed') {
      const requested =
        typeof data.amount === 'number' && Number.isFinite(data.amount)
          ? data.amount
          : 0;
      const dispensed =
        typeof data.dispensed === 'number' && Number.isFinite(data.dispensed)
          ? data.dispensed
          : 0;
      const owed = Math.max(0, requested - dispensed);
      pendingOwedChange = {
        amountOwed: owed > 0 ? owed : requested,
        transactionId: data.transactionId ?? currentTransactionId,
        message: data.message,
      };
      if (data.owedChangeId) {
        setPrintingPhase('failed');
      }
    } else if (data.state === 'dispensed') {
      pendingOwedChange = null;
    }
  });

  connectedSocket.on('printErrorRaised', (payload: unknown) => {
    if (!hasActiveJob()) return;
    const err = payload as PrintError;
    if (!err) return;

    // Filter by correlation key if present, except for warnings
    if (err.severity !== 'warning') {
      const payloadKey = (payload as PrintError).spoolerCorrelationKey;
      if (payloadKey) {
        if (
          !paymentSpoolerCorrelationKey ||
          payloadKey !== paymentSpoolerCorrelationKey
        ) {
          return;
        }
      }
    }

    renderPrinterError(err);
  });

  connectedSocket.on('printLifecycleState', (payload: unknown) => {
    const lifecycle = payload as PrintLifecycleStatePayload;
    if (typeof lifecycle.pagesPrinted === 'number') {
      lastKnownPagesPrinted = Math.max(
        lastKnownPagesPrinted,
        lifecycle.pagesPrinted,
      );
    }
    if (typeof lifecycle.totalPages === 'number') {
      lastKnownTotalPages = Math.max(lastKnownTotalPages, lifecycle.totalPages);
    }
    const isHardwareError = Boolean(
      (lifecycle.printError &&
        isMaintenancePrintFailure(
          lifecycle.printError.code,
          lifecycle.printError.userMessage,
        )) ||
        (currentPrinterError &&
          isMaintenancePrintFailure(
            currentPrinterError.code,
            currentPrinterError.userMessage,
          )) ||
        isMaintenancePrintFailure(undefined, lifecycle.reason) ||
        lifecycle.failureStage === 'HardwareError' ||
        lifecycle.failureStage === 'IncompleteOutput' ||
        lifecycle.errorType === 'HardwareError',
    );

    // Live progress updates — only 'processing' transitions carry
    // pagesPrinted. PrintStarted emits the same state without pagesPrinted,
    // which is a no-op here and lets the spinner-only copy stand.
    if (lifecycle.state === 'processing') {
      if (
        typeof lifecycle.pagesPrinted === 'number' &&
        lifecycle.pagesPrinted > 0
      ) {
        renderPrintProgress({
          pagesPrinted: lifecycle.pagesPrinted,
          totalPages: lifecycle.totalPages ?? null,
        });
      }
    }

    if (
      lifecycle.state === 'failed' &&
      matchesPendingWorkerEvent({
        transactionId: lifecycle.transactionId ?? null,
        spoolerCorrelationKey: lifecycle.spoolerCorrelationKey ?? null,
      })
    ) {
      if (lifecycle.transactionId) {
        setTransactionReference(lifecycle.transactionId);
      }
      recordConfirmationTerminalFailure({
        transactionId: lifecycle.transactionId ?? currentTransactionId,
        spoolerCorrelationKey:
          lifecycle.spoolerCorrelationKey ?? paymentSpoolerCorrelationKey,
      });

      if (isHardwareError) {
        hideOverlay(printingOverlay);
        isProcessingPayment = false;
        powerSafetyOverlay.notifyPrintCompleted();
        // Keep activeSpoolerCorrelationKey and session state intact!
        if (lifecycle.printError) {
          renderPrinterError(lifecycle.printError);
        } else if (currentPrinterError) {
          renderPrinterError(currentPrinterError);
        } else {
          renderPrinterError({
            code: 'WORKER_HARDWARE_ERROR',
            severity: 'recoverable',
            userMessage:
              lifecycle.reason ||
              'The printer encountered an issue and could not complete printing.',
            hint: 'Please call maintenance staff and provide the transaction ID below.',
            canRetry: false,
            canDismiss: false,
            spoolerCorrelationKey:
              lifecycle.spoolerCorrelationKey ?? paymentSpoolerCorrelationKey,
          });
        }
        return;
      }

      renderAmbiguousWorkerFailure({
        message: lifecycle.reason,
        spoolerCorrelationKey:
          lifecycle.spoolerCorrelationKey ?? paymentSpoolerCorrelationKey,
      });
      return;
    }
    if (lifecycle.printError) {
      if (hasActiveJob()) renderPrinterError(lifecycle.printError);
    } else if (lifecycle.state === 'printed' || lifecycle.state === 'failed') {
      if (
        lifecycle.state === 'printed' &&
        typeof lifecycle.totalPages === 'number'
      ) {
        renderPrintProgress({
          pagesPrinted: lifecycle.pagesPrinted ?? lifecycle.totalPages,
          totalPages: lifecycle.totalPages,
        });
      }
      if (!isHardwareError) {
        clearPrinterError();
      }
    }
  });

  connectedSocket.on('connect', () => {
    void loadPrinterStatus();
  });

  connectedSocket.on('printerStatusChanged', (payload: unknown) => {
    const status = payload as PrinterStatusPayload | null;
    if (status && typeof status.connected === 'boolean') {
      const blockedByStatus =
        typeof status.status === 'string'
          ? BLOCKED_PRINTER_STATUSES.has(status.status)
          : false;
      const isBlocked = !status.connected || blockedByStatus;
      printerReady = !isBlocked;
      latestPrinterStatusLabel =
        status.status || (status.connected ? 'Ready' : 'Not Found');
      applyConfirmGate();
      if (!printerReady) {
        void loadPrinterStatus();
      }
    } else {
      void loadPrinterStatus();
    }
  });

  connectedSocket.on('printerRecovered', (payload: unknown) => {
    const status = payload as PrinterStatusPayload | null;
    printerReady = true;
    latestPrinterStatusLabel = status?.status || 'Idle';
    if (
      !currentPrinterError ||
      !isMaintenancePrintFailure(currentPrinterError.code)
    ) {
      clearPrinterError();
    }
    applyConfirmGate();
  });

  connectedSocket.on('printerStatusRestored', () => {
    printerReady = true;
    latestPrinterStatusLabel = 'Ready';
    if (
      !currentPrinterError ||
      !isMaintenancePrintFailure(currentPrinterError.code)
    ) {
      clearPrinterError();
    }
    applyConfirmGate();
  });

  // Re-sync on printer malfunction or spooler failure
  connectedSocket.on('printerMalfunction', (payload: unknown) => {
    const status = payload as PrinterStatusPayload | null;
    printerReady = false;
    latestPrinterStatusLabel = status?.status || 'Error';
    if (hasActiveJob() && status?.printError) {
      renderPrinterError(status.printError);
    }
    applyConfirmGate();
  });
  connectedSocket.on('printerSpoolerFailure', (payload: unknown) => {
    const status = payload as PrinterStatusPayload | null;
    if (hasActiveJob() && status?.printError)
      renderPrinterError(status.printError);
  });

  connectedSocket.on('workerPrintStarted', (payload: unknown) => {
    const job = payload as WorkerJobPayload | null;
    if (!matchesPendingWorkerEvent(job ?? {})) return;
    if (confirmationOutcome.outcome === 'maintenance') return;
    setPrintingPhase('printing');
    if (statusMessage) {
      statusMessage.textContent =
        config.mode === 'copy'
          ? 'Copy job started by the worker.'
          : 'Print job started by the worker.';
    }
  });

  // Raw worker telemetry is emitted by the pipe bridge immediately. Render it
  // here so the customer is not waiting for lifecycle persistence to finish.
  connectedSocket.on('workerPrintProgress', (payload: unknown) => {
    const job = payload as WorkerJobPayload | null;
    if (!matchesPendingWorkerEvent(job ?? {})) return;
    if (confirmationOutcome.outcome === 'maintenance') return;
    if (typeof job?.pagesPrinted !== 'number') return;

    lastKnownPagesPrinted = Math.max(
      lastKnownPagesPrinted,
      job.pagesPrinted,
    );
    if (typeof job.totalPages === 'number') {
      lastKnownTotalPages = Math.max(lastKnownTotalPages, job.totalPages);
    }

    renderPrintProgress({
      pagesPrinted: job.pagesPrinted,
      totalPages: job.totalPages ?? null,
    });
  });

  connectedSocket.on('workerJobPaused', (payload: unknown) => {
    const job = payload as WorkerJobPayload | null;
    if (!matchesPendingWorkerEvent(job ?? {})) return;
    if (job?.transactionId) setTransactionReference(job.transactionId);
    recordConfirmationTerminalFailure({
      transactionId: job?.transactionId ?? currentTransactionId,
      spoolerCorrelationKey:
        job?.spoolerCorrelationKey ?? paymentSpoolerCorrelationKey,
    });
    hideOverlay(printingOverlay);
    isProcessingPayment = false;
    renderPrinterError({
      code: 'WORKER_HARDWARE_ERROR',
      severity: 'recoverable',
      userMessage:
        job?.errorMessage ??
        job?.message ??
        'The printer could not complete this print job.',
      hint:
        'Please call maintenance staff and provide the transaction ID below.',
      timestamp: new Date().toISOString(),
      canRetry: false,
      canDismiss: false,
      spoolerCorrelationKey: job?.spoolerCorrelationKey,
    });
  });

  connectedSocket.on('workerPrintSucceeded', (payload: unknown) => {
    const job = payload as WorkerJobPayload | null;
    if (!matchesPendingWorkerEvent(job ?? {})) return;
    if (
      config.mode === 'print' &&
      typeof job?.totalPages === 'number' &&
      job.totalPages > 0
    ) {
      renderPrintProgress({
        pagesPrinted: job.pagesPrinted ?? job.totalPages,
        totalPages: job.totalPages,
      });
      window.setTimeout(() => {
        finalizePrintSuccess(
          job.transactionId ?? null,
          job.spoolerCorrelationKey ?? null,
        );
      }, 450);
      return;
    }
    finalizePrintSuccess(
      job?.transactionId ?? null,
      job?.spoolerCorrelationKey ?? null,
    );
  });

  connectedSocket.on('workerPrintFailed', (payload: unknown) => {
    const job = payload as WorkerJobPayload | null;
    if (!matchesPendingWorkerEvent(job ?? {})) return;

    if (job?.transactionId) setTransactionReference(job.transactionId);
    recordConfirmationTerminalFailure({
      transactionId: job?.transactionId ?? currentTransactionId,
      spoolerCorrelationKey:
        job?.spoolerCorrelationKey ?? paymentSpoolerCorrelationKey,
    });

    // Hardware failures require staff verification and remain terminal for
    // this kiosk session. A later success event cannot replace this result.
    const isHardwareError =
      job?.failureStage === 'HardwareError' ||
      job?.failureStage === 'IncompleteOutput' ||
      job?.errorType === 'HardwareError' ||
      job?.reason === 'HardwareError' ||
      (job?.printError &&
        isMaintenancePrintFailure(
          job.printError.code,
          job.printError.userMessage,
        )) ||
      isMaintenancePrintFailure(undefined, job?.message) ||
      isMaintenancePrintFailure(undefined, job?.errorMessage) ||
      isMaintenancePrintFailure(undefined, job?.reason);

    if (isHardwareError) {
      hideOverlay(printingOverlay);
      isProcessingPayment = false;
      powerSafetyOverlay.notifyPrintCompleted();
      const hardwareError: PrintError = {
        ...(job?.printError ?? {
          code: 'WORKER_HARDWARE_ERROR',
          severity: 'recoverable' as PrintErrorSeverity,
          userMessage:
            job?.errorMessage ??
            job?.message ??
            'The printer could not complete this print job.',
        }),
        hint:
          'Please call maintenance staff and provide the transaction ID below.',
        canRetry: false,
        canDismiss: false,
        spoolerCorrelationKey:
          job?.spoolerCorrelationKey ??
          job?.printError?.spoolerCorrelationKey ??
          null,
      };
      // Ensure severity is at least recoverable for hardware errors
      if (hardwareError.severity === 'warning') {
        hardwareError.severity = 'recoverable';
      }
      renderPrinterError(hardwareError);
      return;
    }

    // A terminal verification failure is ambiguous: some or all pages may
    // already be in the output tray. Keep the transaction available for staff
    // verification instead of silently returning to the confirmation screen.
    renderAmbiguousWorkerFailure({
      message: job?.errorMessage ?? job?.message ?? job?.reason,
      spoolerCorrelationKey:
        job?.spoolerCorrelationKey ?? paymentSpoolerCorrelationKey,
    });
  });
}

// Warning-only dismissal. Maintenance failures use the Done action instead.
errorCloseBtn?.addEventListener('click', () => {
  clearPrinterError();
});

const BLOCKED_PRINTER_STATUSES = new Set([
  'Offline',
  'Error',
  'Paper Jam',
  'Paper Out',
  'Door Open',
  'User Intervention Required',
  'Paused',
]);

let printerStatusRetryTimer: number | null = null;

async function loadPrinterStatus(): Promise<void> {
  if (printerStatusRetryTimer !== null) {
    window.clearTimeout(printerStatusRetryTimer);
    printerStatusRetryTimer = null;
  }

  try {
    const res = await fetch('/api/printer/status');
    const data = await res.json();
    printerReady = Boolean(data.ready);
    latestPrinterStatusLabel =
      data.status || (printerReady ? 'Ready' : 'Not Found');
    applyConfirmGate();

    // If printer is not ready or still in checking phase, schedule a retry
    if (
      !printerReady ||
      latestPrinterStatusLabel === 'Checking…' ||
      latestPrinterStatusLabel === 'Checking...'
    ) {
      printerStatusRetryTimer = window.setTimeout(() => {
        void loadPrinterStatus();
      }, 2500);
    }
  } catch {
    printerReady = false;
    applyConfirmGate();
    printerStatusRetryTimer = window.setTimeout(() => {
      void loadPrinterStatus();
    }, 3000);
  }
}

async function boot(): Promise<void> {
  initCoinLottieAnimation();
  await Promise.all([
    loadPrinterStatus(),
    loadPricing(),
    fetchInitialBalance(),
  ]);
}

void boot();

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function generateClientUuid(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  ) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // Set version to 0100 (v4)
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    // Set variant to 10xx (RFC4122)
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
      '',
    );
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function createSpoolerCorrelationKey(): string {
  return generateClientUuid();
}

function createPaymentIdempotencyKey(): string {
  return generateClientUuid();
}
