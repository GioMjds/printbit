import { initKioskLocalization } from '../shared/kiosk-i18n';
import { navigateWithKioskMotion } from '../shared/kiosk-navigation';

const DEFAULT_RETRY_AFTER_MS = 1_500;
const REQUEST_TIMEOUT_MS = 5_000;

interface StartupReadinessPayload {
  ready?: boolean;
  phase?: 'booting' | 'ready' | 'failed' | string;
  message?: string | null;
  retryAfterMs?: number;
  startedAt?: string;
  readyAt?: string | null;
  failedAt?: string | null;
}

type StartupUiState = 'booting' | 'failed' | 'offline' | 'ready';

const getRequiredElement = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Loading page element #${id} is missing.`);
  }
  return element as T;
};

const statusText = getRequiredElement<HTMLParagraphElement>('statusText');
const metaText = getRequiredElement<HTMLParagraphElement>('metaText');
const phaseChipText = getRequiredElement<HTMLSpanElement>('phaseChipText');
const phaseText = getRequiredElement<HTMLElement>('phaseText');
const connectionText = getRequiredElement<HTMLElement>('connectionText');
const retryText = getRequiredElement<HTMLElement>('retryText');

let pollTimer: number | null = null;
let pollInFlight = false;

const setState = (state: StartupUiState): void => {
  document.documentElement.dataset.startupState = state;
};

const formatRetry = (retryAfterMs: number): string => {
  if (retryAfterMs < 1_000) return '< 1 sec';
  const seconds = Math.ceil(retryAfterMs / 1_000);
  return `${seconds} sec`;
};

const setBooting = (retryAfterMs: number): void => {
  setState('booting');
  document.title = 'Starting PrintBit…';
  phaseChipText.textContent = 'Starting kiosk';
  phaseText.textContent = 'Initializing';
  connectionText.textContent = 'Connected';
  retryText.textContent = formatRetry(retryAfterMs);
  statusText.textContent =
    'Preparing kiosk services. PrintBit will open automatically when everything is ready.';
  metaText.textContent = 'Startup checks are still running.';
};

const setFailed = (
  message: string | null | undefined,
  retryAfterMs: number,
): void => {
  setState('failed');
  document.title = 'PrintBit startup recovery';
  phaseChipText.textContent = 'Recovering';
  phaseText.textContent = 'Needs recovery';
  connectionText.textContent = 'Connected';
  retryText.textContent = formatRetry(retryAfterMs);
  statusText.textContent =
    message ||
    'A startup check did not complete. Automatic recovery is still running.';
  metaText.textContent =
    'PrintBit will keep checking automatically. No kiosk action is required.';
};

const setOffline = (retryAfterMs: number): void => {
  setState('offline');
  document.title = 'Reconnecting to PrintBit…';
  phaseChipText.textContent = 'Reconnecting';
  phaseText.textContent = 'Waiting';
  connectionText.textContent = 'Retrying';
  retryText.textContent = formatRetry(retryAfterMs);
  statusText.textContent =
    'The loading screen cannot reach the PrintBit server yet. Reconnection is automatic.';
  metaText.textContent = 'Waiting for the local kiosk server to respond.';
};

const setReady = (): void => {
  setState('ready');
  document.title = 'PrintBit is ready';
  phaseChipText.textContent = 'Ready';
  phaseText.textContent = 'Ready';
  connectionText.textContent = 'Connected';
  retryText.textContent = 'Complete';
  statusText.textContent = 'PrintBit is ready. Opening the kiosk now.';
  metaText.textContent = 'Startup checks completed successfully.';
};

const schedulePoll = (retryAfterMs: number): void => {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
  }

  pollTimer = window.setTimeout(() => {
    void poll();
  }, retryAfterMs);
};

const fetchReadiness = async (): Promise<StartupReadinessPayload> => {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch('/api/startup/ready', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error(
        'Startup readiness endpoint returned a non-JSON response.',
      );
    }

    return (await response.json()) as StartupReadinessPayload;
  } finally {
    window.clearTimeout(timeout);
  }
};

const poll = async (): Promise<void> => {
  if (pollInFlight) return;
  pollInFlight = true;

  let retryAfterMs = DEFAULT_RETRY_AFTER_MS;

  try {
    const payload = await fetchReadiness();

    if (typeof payload.retryAfterMs === 'number' && payload.retryAfterMs > 0) {
      retryAfterMs = payload.retryAfterMs;
    }

    if (payload.ready === true || payload.phase === 'ready') {
      setReady();
      // Allow the green 'Ready' status and full progress bar to settle before departing
      window.setTimeout(() => {
        navigateWithKioskMotion(
          // ?idle=boot tells the homepage to shield with the idle overlay immediately,
          // so the loading screen morphs directly into the idle attractor screen.
          new URL('/?idle=boot', window.location.origin).toString(),
          'replace',
        );
      }, 400);
      return;
    }

    if (payload.phase === 'failed') {
      setFailed(payload.message, retryAfterMs);
    } else {
      setBooting(retryAfterMs);
    }
  } catch {
    retryAfterMs = Math.max(retryAfterMs, 3_000);
    setOffline(retryAfterMs);
  } finally {
    pollInFlight = false;
  }

  schedulePoll(retryAfterMs);
};

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || pollInFlight) return;
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  void poll();
});

void initKioskLocalization();
void poll();
