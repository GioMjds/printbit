import QRCode from 'qrcode';
import {
  initKioskLocalization,
  KIOSK_LANGUAGE_CHANGED_EVENT,
  translation,
} from './shared/kiosk-i18n';
import { navigateWithKioskMotion } from './shared/kiosk-navigation';
import { mountLoadingAnimation } from './shared/loading-animation';
import { initIdleScreen } from './shared/idle-screen';
import { isMobileViewport } from './shared/device-mode';
import { attachPowerSafetyOverlay } from './shared/power-safety-overlay';
import { fetchPublicPricing, formatPricingGuide } from './shared/pricing-guide';

type SocketLike = {
  on: (event: string, cb: (...args: unknown[]) => void) => void;
};

void initKioskLocalization();

// ── Idle / Attractor Screen ──────────────────────────────────────────────────
// When the loading screen navigates to /?idle=boot the overlay shows immediately
// (boot → idle flow). On normal homepage loads the overlay shows after the
// server-configured idle timeout expires.
const mobileViewport = isMobileViewport();
const idleBootFlag =
  !mobileViewport &&
  (new URLSearchParams(window.location.search).get('idle') === 'boot' ||
    document.documentElement.classList.contains('kiosk-boot-idle'));

if (mobileViewport) {
  document.documentElement.classList.remove('kiosk-boot-idle');
}

if (idleBootFlag) {
  // Clean the URL so the flag is never shown to the user.
  window.history.replaceState(null, '', window.location.pathname);
}

function syncFabVisibility(): void {
  const isPricingOpen = Boolean(document.getElementById('pricingOverlay')?.classList.contains('is-open'));
  const isGuideOpen = Boolean(document.getElementById('guideOverlay')?.classList.contains('is-visible'));
  const isReportOpen = Boolean(document.getElementById('reportOverlay')?.classList.contains('is-visible'));
  const isFeedbackOpen = Boolean(document.getElementById('feedbackOverlay')?.classList.contains('is-visible'));
  const isWifiOpen = Boolean(document.getElementById('wifiOverlay')?.classList.contains('is-visible'));
  const isAdminOpen = Boolean(document.getElementById('adminOverlay')?.classList.contains('is-visible'));
  const isIdleAttractorOpen = Boolean(
    document.getElementById('idleOverlay')?.classList.contains('is-visible') ||
    document.documentElement.classList.contains('kiosk-boot-idle')
  );
  const idleWarning = document.querySelector<HTMLElement>('.idle-warning-overlay');
  const isIdleWarningOpen = Boolean(
    idleWarning &&
    (idleWarning.classList.contains('is-visible') ||
      (idleWarning.style.display && idleWarning.style.display !== 'none'))
  );

  const shouldHide =
    isPricingOpen ||
    isGuideOpen ||
    isReportOpen ||
    isFeedbackOpen ||
    isWifiOpen ||
    isAdminOpen ||
    isIdleAttractorOpen ||
    isIdleWarningOpen;

  document.body?.setAttribute('data-modal-open', String(shouldHide));
  if (typeof document.querySelectorAll === 'function') {
    document.querySelectorAll<HTMLElement>('.kiosk-fab, .printbit-language-fab').forEach((fab) => {
      fab.classList.toggle('is-hidden', shouldHide);
      fab.setAttribute('aria-hidden', String(shouldHide));
    });
  }
}

initIdleScreen({
  overlayId: 'idleOverlay',
  activateImmediately: idleBootFlag,
  onShow: () => syncFabVisibility(),
  onHide: () => syncFabVisibility(),
});

const ioFactory = (
  window as unknown as { io?: (...args: unknown[]) => SocketLike }
).io;

const homeSocket = typeof ioFactory === 'function' ? ioFactory() : null;
attachPowerSafetyOverlay({ socket: homeSocket });

if (homeSocket) {
  homeSocket.on('balance', (amount: unknown) => {
    const el = document.getElementById('balance');
    if (el && typeof amount === 'number') el.textContent = String(amount);
  });
}

function navigateTo(path: string) {
  navigateWithKioskMotion(path);
}

const PRINT_ONBOARDING_TRIGGER_KEY = 'printbit.showPrintOnboardingModal';

const openPrint = document.getElementById('openPrintBtn');
const openCopy = document.getElementById('openCopyBtn');
const openScan = document.getElementById('openScanBtn');
const powerOff = document.getElementById('powerOffBtn');
const openPricingBtn = document.getElementById('openPricingBtn');
const closePricingBtn = document.getElementById('closePricingBtn');
const pricingOverlay = document.getElementById('pricingOverlay');
const pricingGuideContent = document.getElementById('pricingGuideContent');

function setPricingModalOpen(open: boolean): void {
  if (!pricingOverlay) return;
  pricingOverlay.classList.toggle('is-open', open);
  pricingOverlay.setAttribute('aria-hidden', String(!open));
  syncFabVisibility();
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

const homePrintAnimation = document.getElementById('homePrintAnimation');
const homePrintCanvas = document.getElementById(
  'homePrintCanvas',
) as HTMLCanvasElement | null;

const homeCopyAnimation = document.getElementById('homeCopyAnimation');
const homeCopyCanvas = document.getElementById(
  'homeCopyCanvas',
) as HTMLCanvasElement | null;

const homeScanAnimation = document.getElementById('homeScanAnimation');
const homeScanCanvas = document.getElementById(
  'homeScanCanvas',
) as HTMLCanvasElement | null;

const homePrintController =
  homePrintAnimation && homePrintCanvas
    ? mountLoadingAnimation({
        root: homePrintAnimation,
        canvas: homePrintCanvas,
        mode: 'upload',
        active: true,
      })
    : null;

const homeCopyController =
  homeCopyAnimation && homeCopyCanvas
    ? mountLoadingAnimation({
        root: homeCopyAnimation,
        canvas: homeCopyCanvas,
        mode: 'copy',
        active: true,
      })
    : null;

const homeScanController =
  homeScanAnimation && homeScanCanvas
    ? mountLoadingAnimation({
        root: homeScanAnimation,
        canvas: homeScanCanvas,
        mode: 'scan',
        active: true,
      })
    : null;

window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    homePrintController?.destroy();
    homeCopyController?.destroy();
    homeScanController?.destroy();
  }
});

openPrint?.addEventListener('click', () => {
  navigateTo('/print');
});
openCopy?.addEventListener('click', () => navigateTo('/copy'));
openScan?.addEventListener('click', () => navigateTo('/scan'));

// ── Hotspot Wi-Fi connection modal (Public ESP32 Hotspot) ─────────────────────

type HotspotConfig = {
  provider?: string;
  ssid?: string;
  password?: string;
  authType?: string;
  captivePortalPath?: string;
  startsManagedHotspot?: boolean;
};

let hotspotConfig: HotspotConfig | null = null;

const wifiOverlay = document.getElementById('wifiOverlay');
const homeWifiQrCanvas = document.getElementById(
  'homeWifiQrCanvas',
) as HTMLCanvasElement | null;
const openWifiBtn = document.getElementById('openWifiBtn');
const openWifiHelpBtn = document.getElementById('openWifiHelpBtn');
const closeWifiBtn = document.getElementById('closeWifiBtn');
const wifiSsidVal = document.getElementById('wifiSsidVal');
const wifiPasswordVal = document.getElementById('wifiPasswordVal');

function escapeWifiQrValue(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1');
}

function buildWifiQrPayload(
  ssid: string,
  password: string,
  authType?: string,
): string {
  const safeSsid = escapeWifiQrValue(ssid);
  const safePassword = escapeWifiQrValue(password);
  const normalizedAuth = authType?.trim().toLowerCase() ?? '';
  const isOpenNetwork =
    normalizedAuth === 'nopass' ||
    normalizedAuth === 'open' ||
    normalizedAuth === 'none' ||
    safePassword.length === 0;

  if (isOpenNetwork) {
    return `WIFI:T:nopass;S:${safeSsid};;`;
  }
  return `WIFI:T:WPA;S:${safeSsid};P:${safePassword};;`;
}

function renderHomeWifiQr(): void {
  const configuredSsid = hotspotConfig?.ssid?.trim() ?? '';
  const ssid = configuredSsid.length > 0 ? configuredSsid : 'PrintBit';
  const configuredPassword = hotspotConfig?.password?.trim() ?? '';
  const authType = hotspotConfig?.authType ?? '';

  if (wifiSsidVal) wifiSsidVal.textContent = ssid;
  if (wifiPasswordVal) {
    wifiPasswordVal.textContent =
      configuredPassword.length > 0
        ? configuredPassword
        : 'Open (No password required)';
  }

  if (homeWifiQrCanvas) {
    const wifiPayload = buildWifiQrPayload(ssid, configuredPassword, authType);
    void QRCode.toCanvas(homeWifiQrCanvas, wifiPayload, {
      width: 220,
      margin: 1,
      color: { dark: '#1a1a2e', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
  }
}

async function loadHotspotConfig(): Promise<void> {
  try {
    const res = await fetch('/api/config/hotspot');
    if (res.ok) {
      hotspotConfig = (await res.json()) as HotspotConfig;
    }
  } catch {
    // fallback to default
  }
  renderHomeWifiQr();
}

function openWifiModal(): void {
  renderHomeWifiQr();
  wifiOverlay?.classList.add('is-visible');
  wifiOverlay?.setAttribute('aria-hidden', 'false');
  syncFabVisibility();
  closeWifiBtn?.focus();
}

function closeWifiModal(): void {
  wifiOverlay?.classList.remove('is-visible');
  wifiOverlay?.setAttribute('aria-hidden', 'true');
  syncFabVisibility();
}

openWifiBtn?.addEventListener('click', openWifiModal);
openWifiHelpBtn?.addEventListener('click', openWifiModal);
closeWifiBtn?.addEventListener('click', closeWifiModal);
wifiOverlay?.addEventListener('click', (e) => {
  if (e.target === wifiOverlay) closeWifiModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && wifiOverlay?.classList.contains('is-visible')) {
    closeWifiModal();
  }
});

void loadHotspotConfig();
void resolveFeedbackQrUrl();
void resolveReportQrUrl();

powerOff?.addEventListener('click', () => {
  const ok = confirm('Power off device?');
  if (!ok) return;
  alert('Powering off…');
});

// ── Homepage clock ─────────────────────────────────────────────────────────────

const clockTimeEl = document.getElementById('clockTime');
const clockDateEl = document.getElementById('clockDate');

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function updateClock(): void {
  if (!clockTimeEl || !clockDateEl) return;

  const now = new Date();
  const hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const h12 = hours % 12 || 12;

  clockTimeEl.textContent = `${h12}:${minutes} ${ampm}`;
  clockDateEl.textContent = `${DAY_NAMES[now.getDay()]}, ${MONTH_NAMES[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
}

updateClock();
window.setInterval(updateClock, 1000);

// ── Guide overlay modal ────────────────────────────────────────────────────────

interface GuideStep {
  imageUrl: string;
  captionKey: string;
  captionFallback: string;
}

// Guides for print, copy, and scan steps with images and captions. Each guide consists of multiple steps that users can navigate through.
const guides = {
  print: [
    {
      imageUrl: '/assets/print-steps/step-1.png',
      captionKey: 'print.guide.step1',
      captionFallback:
        'Scan the QR code shown in the kiosk to open the upload page on your device.',
    },
    {
      imageUrl: '/assets/print-steps/step-2.jpg',
      captionKey: 'print.guide.step2',
      captionFallback: 'Upload your document file(s) from your device.',
    },
    {
      imageUrl: '/assets/print-steps/step-3.jpg',
      captionKey: 'print.guide.step3',
      captionFallback:
        'Press "Send to Kiosk" to transfer your file(s) to the kiosk.',
    },
    {
      imageUrl: '/assets/print-steps/step-4.jpg',
      captionKey: 'print.guide.step4',
      captionFallback:
        'Wait for the upload to complete. If it is successful, please check in the kiosk to review your file(s).',
    },
    {
      imageUrl: '/assets/print-steps/step-5.png',
      captionKey: 'print.guide.step5',
      captionFallback:
        'Your uploaded file(s) will appear on the kiosk screen. Review your file(s) and press "Proceed to Config" for the next step.',
    },
    {
      imageUrl: '/assets/print-steps/step-6.png',
      captionKey: 'print.guide.step6',
      captionFallback:
        'Configure your print settings (e.g. number of copies, color or black & white) and then press "Continue" for confirmation step and to insert coins.',
    },
    {
      imageUrl: '/assets/print-steps/step-7.png',
      captionKey: 'print.guide.step7',
      captionFallback:
        'You may now proceed to insert coins. Press "Confirm & Print" and wait for the printing to start.',
    },
  ],
  copy: [
    {
      imageUrl: '/assets/copy-steps/copy-1.png',
      captionKey: 'copy.guide.step1',
      captionFallback:
        'Place your document face-down first on the scanner glass. If it is ready, press "Check Document" on the kiosk screen to preview the scan.',
    },
    {
      imageUrl: '/assets/copy-steps/copy-2.png',
      captionKey: 'copy.guide.step2',
      captionFallback: 'Please wait for your document to finish scanning.',
    },
    {
      imageUrl: '/assets/copy-steps/copy-3.png',
      captionKey: 'copy.guide.step3',
      captionFallback:
        'Review the scanned preview on the screen. If it is correct, press "Continue to Config" for the next step.',
    },
    {
      imageUrl: '/assets/copy-steps/copy-4.png',
      captionKey: 'copy.guide.step4',
      captionFallback:
        'Select your preferred copy settings (size, color, copies) and proceed.',
    },
    {
      imageUrl: '/assets/copy-steps/copy-5.png',
      captionKey: 'copy.guide.step5',
      captionFallback:
        'Insert the required coins for your copy job and confirm payment.',
    },
    {
      imageUrl: '/assets/copy-steps/copy-6.png',
      captionKey: 'copy.guide.step6',
      captionFallback:
        'Wait for the copying to finish and collect your documents.',
    },
  ],
  scan: [
    {
      imageUrl: '/assets/scan-steps/scan-1.png',
      captionKey: 'scan.guide.step1',
      captionFallback:
        'Place your document in the printer document feeder. If it is ready, press "Scan Document".',
    },
    {
      imageUrl: '/assets/scan-steps/scan-2.png',
      captionKey: 'scan.guide.step2',
      captionFallback:
        'Your physical document is feeding into the printer. Please wait for it to finish scanning.',
    },
    {
      imageUrl: '/assets/scan-steps/scan-3.png',
      captionKey: 'scan.guide.step3',
      captionFallback:
        'Your scanned document will appear on the kiosk screen. Review the preview.',
    },
    {
      imageUrl: '/assets/scan-steps/scan-4.png',
      captionKey: 'scan.guide.step4',
      captionFallback:
        'Insert the required coins for your scan job and confirm payment.',
    },
    {
      imageUrl: '/assets/scan-steps/scan-5.png',
      captionKey: 'scan.guide.step5',
      captionFallback:
        'After confirmation, the kiosk generates the image QR code link to download as soft copy.',
    },
  ],
} as const satisfies Record<string, GuideStep[]>;

type GuideName = keyof typeof guides;

function isGuideName(name: string): name is GuideName {
  return Object.hasOwn(guides, name);
}

const guideOverlay = document.getElementById('guideOverlay');
const guideCards = guideOverlay?.querySelectorAll<HTMLElement>('.guide-card');

let activeGuide: GuideName | null = null;
const guideIndices: Record<GuideName, number> = { print: 0, copy: 0, scan: 0 };

const GUIDE_NEXT_KEY = 'guide.next';
const GUIDE_GOT_IT_KEY = 'guide.got_it';
const GUIDE_NEXT_ARIA_KEY = 'guide.next_aria';
const GUIDE_CLOSE_ARIA_KEY = 'guide.close_aria';

function isGuideOverlayVisible(): boolean {
  return guideOverlay?.classList.contains('is-visible') ?? false;
}

function getGuideElements(name: GuideName) {
  return {
    image: document.getElementById(
      `${name}GuideImage`,
    ) as HTMLImageElement | null,
    counter: document.getElementById(`${name}GuideCounter`),
    caption: document.getElementById(`${name}GuideCaption`),
    prevBtn: document.getElementById(
      `${name}GuidePrevBtn`,
    ) as HTMLButtonElement | null,
    nextBtn: document.getElementById(
      `${name}GuideNextBtn`,
    ) as HTMLButtonElement | null,
  };
}

function renderGuideStep(name: GuideName): void {
  const steps = guides[name];
  const elements = getGuideElements(name);
  if (
    !steps ||
    !steps.length ||
    !elements.image ||
    !elements.counter ||
    !elements.caption ||
    !elements.prevBtn ||
    !elements.nextBtn
  ) {
    return;
  }

  const index = guideIndices[name];
  const step = steps[index];
  const isLastStep = index === steps.length - 1;
  const nextActionLabel = translation(GUIDE_NEXT_KEY, 'Next');
  const nextVisualLabel = isLastStep ? translation(GUIDE_GOT_IT_KEY, '✖') : '❯';
  const isCloseIconState =
    isLastStep && nextVisualLabel.trim().replace(/\uFE0F/g, '').length <= 1;
  const nextAriaLabel = isLastStep
    ? translation(GUIDE_CLOSE_ARIA_KEY, `Close ${name} guide modal`)
    : translation(GUIDE_NEXT_ARIA_KEY, `Next ${name} guide step`);

  elements.counter.textContent = `Step ${index + 1} of ${steps.length}`;
  elements.caption.textContent = translation(
    step.captionKey,
    step.captionFallback,
  );
  elements.image.alt = `${name} guide step ${index + 1}`;
  elements.image.style.visibility = 'visible';
  elements.image.src = step.imageUrl;
  elements.prevBtn.disabled = index === 0;
  elements.nextBtn.disabled = false;
  elements.nextBtn.textContent = nextVisualLabel;
  elements.nextBtn.classList.toggle(
    'is-label',
    isLastStep && !isCloseIconState,
  );
  elements.nextBtn.classList.toggle('is-close-icon', isCloseIconState);
  elements.nextBtn.title = isLastStep ? nextAriaLabel : nextActionLabel;
  elements.nextBtn.setAttribute('aria-label', nextAriaLabel);
}

function setGuideStep(name: GuideName, nextIndex: number): void {
  const steps = guides[name];
  if (!steps || !steps.length) return;
  if (nextIndex < 0) nextIndex = 0;
  if (nextIndex > steps.length - 1) {
    nextIndex = steps.length - 1;
  }
  guideIndices[name] = nextIndex;
  renderGuideStep(name);
}

function openGuide(name: GuideName): void {
  if (!guideOverlay || !guideCards) return;

  guideCards.forEach((card) => {
    card.style.display = 'none';
  });

  activeGuide = name;
  const target = document.getElementById(`guide-${name}`) as HTMLElement | null;
  if (target) target.style.display = 'flex';
  if (guides[name]) setGuideStep(name, 0);

  guideOverlay.classList.add('is-visible');
  guideOverlay.setAttribute('aria-hidden', 'false');
  syncFabVisibility();
}

function closeGuide(): void {
  if (!guideOverlay) return;
  guideOverlay.classList.remove('is-visible');
  guideOverlay.setAttribute('aria-hidden', 'true');
  activeGuide = null;
  syncFabVisibility();
}

window.addEventListener(KIOSK_LANGUAGE_CHANGED_EVENT, () => {
  if (activeGuide && isGuideOverlayVisible() && guides[activeGuide]) {
    renderGuideStep(activeGuide);
  }
});

(['print', 'copy', 'scan'] as const).forEach((name) => {
  const elements = getGuideElements(name);
  if (elements.image) {
    elements.image.addEventListener('load', () => {
      elements.image!.style.visibility = 'visible';
    });
    elements.image.addEventListener('error', () => {
      elements.image!.style.visibility = 'hidden';
      if (elements.caption) {
        elements.caption.textContent = 'Step image unavailable for this step.';
      }
    });
  }

  elements.prevBtn?.addEventListener('click', () => {
    setGuideStep(name, guideIndices[name] - 1);
  });

  elements.nextBtn?.addEventListener('click', () => {
    const steps = guides[name];
    if (guideIndices[name] === steps.length - 1) {
      closeGuide();
      return;
    }
    setGuideStep(name, guideIndices[name] + 1);
  });
});

document.querySelectorAll<HTMLElement>('.action-card__help').forEach((btn) => {
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();

    const guideName = btn.dataset.guide;
    if (!guideName || !isGuideName(guideName)) return;
    openGuide(guideName);
  });
});

guideOverlay
  ?.querySelectorAll<HTMLElement>('.guide-card__close')
  .forEach((btn) => {
    btn.addEventListener('click', closeGuide);
  });

guideOverlay?.addEventListener('click', (event) => {
  if (event.target === guideOverlay) closeGuide();
});

document.addEventListener('keydown', (event) => {
  if (!activeGuide || !isGuideOverlayVisible()) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    closeGuide();
    return;
  }

  const steps = guides[activeGuide];
  if (!steps) return;

  if (event.key === 'ArrowLeft') {
    if (guideIndices[activeGuide] === 0) return;
    event.preventDefault();
    setGuideStep(activeGuide, guideIndices[activeGuide] - 1);
    return;
  }

  if (event.key === 'ArrowRight') {
    event.preventDefault();
    if (guideIndices[activeGuide] === steps.length - 1) {
      closeGuide();
      return;
    }
    setGuideStep(activeGuide, guideIndices[activeGuide] + 1);
  }
});

// ── Feedback QR modal ─────────────────────────────────────────────────────────

const openFeedbackBtn = document.getElementById('openFeedbackBtn');
const feedbackOverlay = document.getElementById('feedbackOverlay');
const closeFeedbackBtn = document.getElementById('closeFeedbackBtn');
const feedbackQrCanvas = document.getElementById(
  'feedbackQrCanvas',
) as HTMLCanvasElement | null;
const feedbackModalStatus = document.getElementById('feedbackModalStatus');

let cachedFeedbackQrUrl: string | null = null;
let cachedReportQrUrl: string | null = null;

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === '' ||
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}

function isLoopbackUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    return isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

async function resolveFeedbackQrUrl(): Promise<string> {
  if (cachedFeedbackQrUrl && !isLoopbackUrl(cachedFeedbackQrUrl)) {
    return cachedFeedbackQrUrl;
  }
  try {
    const res = await fetch('/api/feedback/qr-url');
    if (res.ok) {
      const data = (await res.json()) as { url?: string };
      if (typeof data.url === 'string' && data.url.trim().length > 0) {
        const resolved = data.url.trim();
        if (!isLoopbackUrl(resolved)) {
          cachedFeedbackQrUrl = resolved;
        }
        return resolved;
      }
    }
  } catch {
    /* fallback below */
  }

  if (cachedFeedbackQrUrl) return cachedFeedbackQrUrl;

  // Fallback: If current page origin is not loopback, use origin; otherwise keep origin/feedback
  return `${window.location.origin}/feedback`;
}

async function resolveReportQrUrl(): Promise<string> {
  if (cachedReportQrUrl && !isLoopbackUrl(cachedReportQrUrl)) {
    return cachedReportQrUrl;
  }
  try {
    const res = await fetch('/api/report-issues/qr-url');
    if (res.ok) {
      const data = (await res.json()) as { url?: string };
      if (typeof data.url === 'string' && data.url.trim().length > 0) {
        const resolved = data.url.trim();
        if (!isLoopbackUrl(resolved)) {
          cachedReportQrUrl = resolved;
        }
        return resolved;
      }
    }
  } catch {
    /* fallback below */
  }

  if (cachedReportQrUrl) return cachedReportQrUrl;

  return `${window.location.origin}/report`;
}

function setFeedbackStatus(msg: string): void {
  if (feedbackModalStatus) feedbackModalStatus.textContent = msg;
}

async function renderFeedbackQr(): Promise<void> {
  if (!feedbackQrCanvas) return;
  setFeedbackStatus('Generating QR code\u2026');
  try {
    const feedbackUrl = await resolveFeedbackQrUrl();
    await QRCode.toCanvas(feedbackQrCanvas, feedbackUrl, {
      width: 220,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });
    setFeedbackStatus('Use your phone camera to scan.');
  } catch {
    setFeedbackStatus('Could not generate QR code. Please try again.');
  }
}

function openFeedbackModal(): void {
  feedbackOverlay?.classList.add('is-visible');
  feedbackOverlay?.setAttribute('aria-hidden', 'false');
  syncFabVisibility();
  void renderFeedbackQr();
}

function closeFeedbackModal(): void {
  feedbackOverlay?.classList.remove('is-visible');
  feedbackOverlay?.setAttribute('aria-hidden', 'true');
  syncFabVisibility();
}

openFeedbackBtn?.addEventListener('click', openFeedbackModal);
closeFeedbackBtn?.addEventListener('click', closeFeedbackModal);
feedbackOverlay?.addEventListener('click', (e) => {
  if (e.target === feedbackOverlay) closeFeedbackModal();
});

// ── Report QR modal ───────────────────────────────────────────────────────────

const openReportBtn = document.getElementById('openReportBtn');
const reportOverlay = document.getElementById('reportOverlay');
const closeReportBtn = document.getElementById('closeReportBtn');
const reportQrCanvas = document.getElementById(
  'reportQrCanvas',
) as HTMLCanvasElement | null;
const reportModalStatus = document.getElementById('reportModalStatus');

function setReportStatus(msg: string): void {
  if (reportModalStatus) reportModalStatus.textContent = msg;
}

async function renderReportQr(): Promise<void> {
  if (!reportQrCanvas) return;
  setReportStatus('Generating QR code\u2026');
  try {
    const reportUrl = await resolveReportQrUrl();
    await QRCode.toCanvas(reportQrCanvas, reportUrl, {
      width: 220,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });
    setReportStatus('Use your phone camera to scan.');
  } catch {
    setReportStatus('Could not generate QR code. Please try again.');
  }
}

function openReportModal(): void {
  reportOverlay?.classList.add('is-visible');
  reportOverlay?.setAttribute('aria-hidden', 'false');
  syncFabVisibility();
  void renderReportQr();
}

function closeReportModal(): void {
  reportOverlay?.classList.remove('is-visible');
  reportOverlay?.setAttribute('aria-hidden', 'true');
  syncFabVisibility();
}

openReportBtn?.addEventListener('click', openReportModal);
closeReportBtn?.addEventListener('click', closeReportModal);
reportOverlay?.addEventListener('click', (e) => {
  if (e.target === reportOverlay) closeReportModal();
});

export { navigateTo };

const brandArea = document.querySelector('.brand') as HTMLElement | null;
const adminOverlay = document.getElementById('adminOverlay');
const adminPinInput = document.getElementById(
  'adminPinInput',
) as HTMLInputElement | null;
const adminPinError = document.getElementById('adminPinError');
const adminCancelBtn = document.getElementById('adminCancelBtn');
const adminSubmitBtn = document.getElementById('adminSubmitBtn');

const REQUIRED_TAPS = 5;
const TAP_WINDOW_MS = 3000;

let tapCount = 0;
let tapTimer: number | null = null;

function openAdminModal(): void {
  adminOverlay?.classList.add('is-visible');
  adminOverlay?.setAttribute('aria-hidden', 'false');
  syncFabVisibility();
  adminPinInput?.focus();
  if (adminPinError) adminPinError.textContent = '';
  if (adminPinInput) adminPinInput.value = '';
}

function closeAdminModal(): void {
  adminOverlay?.classList.remove('is-visible');
  adminOverlay?.setAttribute('aria-hidden', 'true');
  syncFabVisibility();
  if (adminPinInput) adminPinInput.value = '';
  if (adminPinError) adminPinError.textContent = '';
}

function setAdminError(msg: string): void {
  if (adminPinError) adminPinError.textContent = msg;
}

async function submitAdminPin(): Promise<void> {
  const pin = adminPinInput?.value.trim() ?? '';
  if (!pin) {
    setAdminError('Please enter a PIN.');
    return;
  }

  if (adminSubmitBtn) adminSubmitBtn.textContent = 'Checking…';

  try {
    const res = await fetch('/api/admin/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });

    const data = (await res.json()) as {
      ok: boolean;
      sessionToken?: string;
      error?: string;
    };

    if (data.ok && data.sessionToken) {
      // Store session token for the admin panel to pick up
      sessionStorage.setItem('adminSessionToken', data.sessionToken);
      closeAdminModal();
      navigateTo('/admin/dashboard');
    } else {
      setAdminError(data.error ?? 'Incorrect PIN.');
      if (adminPinInput) adminPinInput.value = '';
      adminPinInput?.focus();
    }
  } catch {
    setAdminError('Connection error. Please try again.');
  } finally {
    if (adminSubmitBtn) adminSubmitBtn.textContent = 'Enter';
  }
}

brandArea?.addEventListener('click', () => {
  tapCount += 1;

  if (tapTimer !== null) clearTimeout(tapTimer);

  if (tapCount >= REQUIRED_TAPS) {
    tapCount = 0;
    openAdminModal();
    return;
  }

  tapTimer = window.setTimeout(() => {
    tapCount = 0;
  }, TAP_WINDOW_MS);
});

adminCancelBtn?.addEventListener('click', closeAdminModal);

adminSubmitBtn?.addEventListener('click', () => void submitAdminPin());

adminPinInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void submitAdminPin();
});

adminOverlay?.addEventListener('click', (e) => {
  if (e.target === adminOverlay) closeAdminModal();
});

syncFabVisibility();
