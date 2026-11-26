/**
 * Shared idle timeout module for all kiosk pages
 * Provides configurable idle detection with optional warning modal
 */

import { isMobileViewport } from '@/public/shared/device-mode';

export interface PageIdleState {
  enabled: boolean;
  timeoutSeconds: number;
  elapsedSeconds: number;
  warningShownAt: number | null;
  timerHandle: number | null;
  startedAtMs: number | null;
}

export interface IdleTimeoutConfig {
  showWarningModal?: boolean; // If true, shows modal in last 20 seconds
  modalId?: string;
  countdownId?: string;
  buttonId?: string;
  /**
   * Defers the idle countdown while customer work is in progress. Once it
   * returns false, the customer receives a fresh full idle period.
   */
  deferWhile?: () => boolean;
  onTimeout?: () => Promise<void> | void;
  onWarningShown?: () => void;
  onWarningHidden?: () => void;
}

const DEFAULT_TIMEOUT_SECONDS = 120;

const pageIdleState: PageIdleState = {
  enabled: false,
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  elapsedSeconds: 0,
  warningShownAt: null,
  timerHandle: null,
  startedAtMs: null,
};

let idleConfig: IdleTimeoutConfig = {
  showWarningModal: false,
  modalId: 'idleWarningModal',
  countdownId: 'idleCountdown',
  buttonId: 'keepActiveBtn',
};

// Cached DOM elements for performance
let cachedModalElement: HTMLElement | null = null;
let cachedCountdownElement: HTMLElement | null = null;
let cachedButtonElement: HTMLButtonElement | null = null;
let areListenersAttached = false;
let timeoutCapSeconds: number | null = null;

/**
 * Shortens (never lengthens) the page idle period and restarts the countdown,
 * so a finished screen closes sooner than the admin's page timeout.
 */
export function capPageIdleTimeout(seconds: number): void {
  timeoutCapSeconds = seconds;
  pageIdleState.timeoutSeconds = Math.min(pageIdleState.timeoutSeconds, seconds);
  resetPageIdleTimer();
}

export async function initializePageIdleTimeout(
  config: IdleTimeoutConfig = {},
): Promise<void> {
  idleConfig = {
    ...idleConfig,
    ...config,
    // Keep the session timeout/cleanup active on mobile, but never mount its
    // fullscreen warning there. The warning is a kiosk-only interaction.
    showWarningModal: isMobileViewport()
      ? false
      : (config.showWarningModal ?? idleConfig.showWarningModal),
  };
  pageIdleState.timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;

  try {
    const res = await fetch('/api/settings/idle-timeout');
    if (res.ok) {
      const data = (await res.json()) as { idleTimeoutSeconds?: number };
      if (data.idleTimeoutSeconds && data.idleTimeoutSeconds > 0) {
        pageIdleState.timeoutSeconds = data.idleTimeoutSeconds;
      }
    }
  } catch (err) {
    console.error('Failed to fetch idle timeout settings, using default:', err);
  } finally {
    // A cap set while settings were loading must survive the fetched value.
    if (timeoutCapSeconds !== null) {
      pageIdleState.timeoutSeconds = Math.min(
        pageIdleState.timeoutSeconds,
        timeoutCapSeconds,
      );
    }
    // Always enable and start the idle timer even if settings fetch fails
    pageIdleState.enabled = true;
    cachePageIdleDOMElements();
    startPageIdleTimer();
    setupPageIdleWarningButton();
  }
}

function cachePageIdleDOMElements(): void {
  if (idleConfig.modalId) {
    cachedModalElement = document.getElementById(idleConfig.modalId);
  }
  if (idleConfig.countdownId) {
    cachedCountdownElement = document.getElementById(idleConfig.countdownId);
  }
  if (idleConfig.buttonId) {
    cachedButtonElement = document.getElementById(
      idleConfig.buttonId,
    ) as HTMLButtonElement | null;
  }
}

export function startPageIdleTimer(): void {
  if (pageIdleState.timerHandle !== null) {
    clearInterval(pageIdleState.timerHandle);
    pageIdleState.timerHandle = null;
  }

  const now = Date.now();
  pageIdleState.startedAtMs = now;
  pageIdleState.elapsedSeconds = 0;
  pageIdleState.warningShownAt = null;

  if (idleConfig.showWarningModal && cachedModalElement) {
    cachedModalElement.style.display = 'none';
    cachedModalElement.classList.remove('is-leaving');
  }

  let lastCountdownValue = -1; // Track lastCountdownValue to avoid unnecessary DOM updates
  const ACTIVITY_EVENTS = [
    'mousedown',
    'keydown',
    'touchstart',
    'pointerdown',
    'click',
  ];

  // Attach activity listeners before timer starts
  if (!areListenersAttached) {
    ACTIVITY_EVENTS.forEach((event) => {
      document.addEventListener(event, handleUserActivity, true);
    });
    areListenersAttached = true;
  }

  pageIdleState.timerHandle = window.setInterval(() => {
    if (!pageIdleState.enabled || pageIdleState.startedAtMs === null) return;

    const currentNow = Date.now();
    if (idleConfig.deferWhile?.()) {
      pageIdleState.startedAtMs = currentNow;
      pageIdleState.elapsedSeconds = 0;
      if (pageIdleState.warningShownAt !== null) {
        pageIdleState.warningShownAt = null;
        hidePageIdleWarning();
      }
      return;
    }
    const elapsed = Math.max(
      0,
      (currentNow - pageIdleState.startedAtMs) / 1000,
    );
    pageIdleState.elapsedSeconds = elapsed;

    // Warning shows in last 20 seconds (or half of timeout if timeout <= 20s)
    const warningThreshold = Math.max(
      0,
      pageIdleState.timeoutSeconds <= 20
        ? pageIdleState.timeoutSeconds / 2
        : pageIdleState.timeoutSeconds - 20,
    );

    // Show warning at threshold (if configured)
    if (
      idleConfig.showWarningModal &&
      pageIdleState.warningShownAt === null &&
      pageIdleState.elapsedSeconds >= warningThreshold
    ) {
      pageIdleState.warningShownAt = pageIdleState.elapsedSeconds;
      showPageIdleWarning();
      if (idleConfig.onWarningShown) {
        idleConfig.onWarningShown();
      }
    }

    // Update countdown display only when value changes (every ~second)
    if (!cachedCountdownElement && idleConfig.countdownId) {
      cachedCountdownElement = document.getElementById(idleConfig.countdownId);
    }
    if (cachedCountdownElement) {
      const timeRemaining = Math.max(
        0,
        Math.ceil(pageIdleState.timeoutSeconds - pageIdleState.elapsedSeconds),
      );
      if (timeRemaining !== lastCountdownValue) {
        lastCountdownValue = timeRemaining;
        cachedCountdownElement.textContent = String(timeRemaining);
      }
    }

    // Handle final timeout
    if (pageIdleState.elapsedSeconds >= pageIdleState.timeoutSeconds) {
      if (pageIdleState.timerHandle !== null) {
        clearInterval(pageIdleState.timerHandle);
        pageIdleState.timerHandle = null;
      }
      void handlePageIdleTimeout();
    }
  }, 100);
}

let isLeavingTimeout: number | null = null;

function handleUserActivity(event?: Event): void {
  if (!pageIdleState.enabled) return;

  // When warning is actively displayed, tapping screen triggers exit transition
  if (pageIdleState.warningShownAt !== null) {
    event?.preventDefault();
    event?.stopPropagation();
    dismissPageIdleWarning();
    return;
  }

  resetPageIdleTimer();
}

export function resetPageIdleTimer(): void {
  if (!pageIdleState.enabled) return;

  // Restart the timer (listeners remain attached from startPageIdleTimer)
  startPageIdleTimer();
}

export function showPageIdleWarning(): void {
  if (!cachedModalElement && idleConfig.modalId) {
    cachedModalElement = document.getElementById(idleConfig.modalId);
  }
  if (cachedModalElement) {
    if (isLeavingTimeout !== null) {
      window.clearTimeout(isLeavingTimeout);
      isLeavingTimeout = null;
    }
    // Remove any lingering exit class and make visible with fade-in
    cachedModalElement.classList.remove('is-leaving');
    cachedModalElement.style.display = 'flex';

    document.body?.setAttribute('data-idle-active', 'true');
    if (typeof document.querySelectorAll === 'function') {
      document.querySelectorAll<HTMLElement>('.kiosk-fab, .printbit-language-fab').forEach((el) => {
        el.classList.add('is-hidden');
        el.setAttribute('aria-hidden', 'true');
      });
    }

    // Tap anywhere on the overlay backdrop to dismiss
    cachedModalElement.removeEventListener('click', handleOverlayClick);
    cachedModalElement.addEventListener('click', handleOverlayClick);
  }
}

/** Animate the overlay out, then hide it once the animation completes */
export function hidePageIdleWarning(onComplete?: () => void): void {
  if (!cachedModalElement) {
    if (idleConfig.onWarningHidden) idleConfig.onWarningHidden();
    if (onComplete) onComplete();
    return;
  }

  // Prevent duplicate trigger if already exiting
  if (cachedModalElement.classList?.contains?.('is-leaving')) {
    return;
  }

  document.body?.removeAttribute('data-idle-active');
  if (typeof document.querySelectorAll === 'function') {
    document.querySelectorAll<HTMLElement>('.kiosk-fab, .printbit-language-fab').forEach((el) => {
      el.classList.remove('is-hidden');
      el.setAttribute('aria-hidden', 'false');
    });
  }

  // Remove overlay tap listener
  cachedModalElement.removeEventListener('click', handleOverlayClick);

  // Trigger CSS exit animation
  cachedModalElement.classList.add('is-leaving');

  if (isLeavingTimeout !== null) {
    window.clearTimeout(isLeavingTimeout);
  }

  // After the animation completes (300ms), hide and clean up
  const el = cachedModalElement;
  isLeavingTimeout = window.setTimeout(() => {
    el.style.display = 'none';
    el.classList.remove('is-leaving');
    isLeavingTimeout = null;
    if (idleConfig.onWarningHidden) {
      idleConfig.onWarningHidden();
    }
    if (onComplete) {
      onComplete();
    }
  }, 300);
}

/**
 * Dismiss the warning with smooth exit transition when the user taps anywhere on screen.
 */
function dismissPageIdleWarning(): void {
  console.log('[PAGE IDLE] User tapped screen to dismiss timeout warning');
  hidePageIdleWarning(() => {
    resetPageIdleTimer();
  });
}

function handleOverlayClick(event?: Event): void {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  dismissPageIdleWarning();
}

export function setupPageIdleWarningButton(): void {
  if (!cachedButtonElement && idleConfig.buttonId) {
    cachedButtonElement = document.getElementById(
      idleConfig.buttonId,
    ) as HTMLButtonElement | null;
  }
  if (!cachedButtonElement) return;

  // Prevent duplicate listeners by removing any existing listener first
  cachedButtonElement.removeEventListener('click', handleKeepActiveClick);
  cachedButtonElement.addEventListener('click', handleKeepActiveClick);
}

function handleKeepActiveClick(event?: Event): void {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  console.log('[PAGE IDLE] User dismissed timeout warning via button');
  dismissPageIdleWarning();
}

async function handlePageIdleTimeout(): Promise<void> {
  console.log('[PAGE IDLE] Timeout reached');
  hidePageIdleWarning();
  if (idleConfig.onTimeout) {
    await idleConfig.onTimeout();
  }
}

export function getPageIdleState(): PageIdleState {
  return pageIdleState;
}
