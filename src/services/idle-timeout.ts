/**
 * Shared idle timeout module for all kiosk pages
 * Provides configurable idle detection with optional warning modal
 */

export interface PageIdleState {
  enabled: boolean;
  timeoutSeconds: number;
  elapsedSeconds: number;
  warningShownAt: number | null;
  timerHandle: number | null;
}

export interface IdleTimeoutConfig {
  showWarningModal?: boolean; // If true, shows modal in last 20 seconds
  modalId?: string;
  countdownId?: string;
  buttonId?: string;
  onTimeout?: () => Promise<void> | void;
  onWarningShown?: () => void;
  onWarningHidden?: () => void;
}

let pageIdleState: PageIdleState = {
  enabled: false,
  timeoutSeconds: 120,
  elapsedSeconds: 0,
  warningShownAt: null,
  timerHandle: null,
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

export async function initializePageIdleTimeout(
  config: IdleTimeoutConfig = {},
): Promise<void> {
  idleConfig = { ...idleConfig, ...config };

  try {
    const res = await fetch('/api/settings/idle-timeout');
    if (!res.ok) return;
    const data = (await res.json()) as { idleTimeoutSeconds?: number };
    if (data.idleTimeoutSeconds && data.idleTimeoutSeconds > 0) {
      pageIdleState.enabled = true;
      pageIdleState.timeoutSeconds = data.idleTimeoutSeconds;
      cachePageIdleDOMElements();
      startPageIdleTimer();
      setupPageIdleWarningButton();
    }
  } catch (err) {
    console.error('Failed to fetch idle timeout settings:', err);
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
  }

  pageIdleState.elapsedSeconds = 0;
  pageIdleState.warningShownAt = null;

  if (idleConfig.showWarningModal && cachedModalElement) {
    cachedModalElement.style.display = 'none';
  }

  let lastCountdownValue = -1; // Track lastCountdownValue to avoid unnecessary DOM updates
  const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart'];
  
  // Attach activity listeners before timer starts 
  if (!areListenersAttached) {
    ACTIVITY_EVENTS.forEach((event) => {
      document.addEventListener(event, resetPageIdleTimer, true);
    });
    areListenersAttached = true;
  }

  pageIdleState.timerHandle = window.setInterval(() => {
    if (!pageIdleState.enabled) return;

    pageIdleState.elapsedSeconds += 0.1;
    
    // Warning shows in last 20 seconds (min 20s, max timeout-20s)
    const warningThreshold = Math.max(
      pageIdleState.timeoutSeconds - 20,
      20,
    );

    // Show warning at last 20 seconds threshold (if configured)
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
      clearInterval(pageIdleState.timerHandle!);
      pageIdleState.timerHandle = null;
      void handlePageIdleTimeout();
    }
  }, 100);
}

export function resetPageIdleTimer(): void {
  if (!pageIdleState.enabled) return;

  // Restart the timer (listeners remain attached from startPageIdleTimer)
  startPageIdleTimer();
}

export function showPageIdleWarning(): void {
  if (cachedModalElement) {
    cachedModalElement.style.display = 'flex';
  }
}

export function hidePageIdleWarning(): void {
  if (cachedModalElement) {
    cachedModalElement.style.display = 'none';
  }
  if (idleConfig.onWarningHidden) {
    idleConfig.onWarningHidden();
  }
}

export function setupPageIdleWarningButton(): void {
  if (!cachedButtonElement) return;
  
  // Prevent duplicate listeners by removing any existing listener first
  cachedButtonElement.removeEventListener('click', handleKeepActiveClick);
  cachedButtonElement.addEventListener('click', handleKeepActiveClick);
}

function handleKeepActiveClick(): void {
  console.log('[PAGE IDLE] User dismissed timeout warning');
  hidePageIdleWarning();
  resetPageIdleTimer();
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
