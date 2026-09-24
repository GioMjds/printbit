/**
 * Reusable Power Safety Maintenance Overlay & In-Flight Banner Module.
 *
 * Responsibilities:
 *  - Subscribes to Socket.IO event `workerPowerStatusChanged`.
 *  - Fetches initial power status from `/api/power-safety/status`.
 *  - Maintains live power status (`operationalState`, `acceptingTransactions`).
 *  - Renders an inert full-screen maintenance overlay when power is unavailable
 *    (`PowerEmergency`, `Recovering`, or `Unknown` where `!acceptingTransactions`).
 *  - For in-flight print jobs (e.g. on confirm screen), displays a non-blocking
 *    warning banner allowing terminal print events to conclude before displaying
 *    the full blocking overlay.
 *  - Removes overlay & banner when power returns to `Operational`
 *    (`acceptingTransactions === true`).
 */

import { Socket } from "socket.io";

export type PowerOperationalState =
  | 'Operational'
  | 'PowerEmergency'
  | 'Recovering'
  | 'Unknown';

export interface WorkerPowerEventPayload {
  type?: string;
  operationalState?: PowerOperationalState;
  acceptingTransactions?: boolean;
  powerStatus?: {
    acLineStatus?: 'Online' | 'Offline' | 'Unknown';
    isCharging?: boolean | null;
    batteryPercentage?: number | null;
    isBatteryLow?: boolean | null;
    isBatteryCritical?: boolean | null;
  } | null;
  message?: string;
  transactionId?: string;
  timestampUtc?: string;
}

export interface PowerSafetyOverlayOptions {
  /**
   * Existing Socket.IO instance or getter function returning socket.
   * If omitted, falls back to `(window as any).io?.()`.
   */
  socket?: Socket;

  /**
   * Predicate indicating whether a paid print job is currently in-flight.
   * When true during a power emergency, displays a non-blocking banner instead
   * of the full blocking overlay until the print completes.
   */
  isPrintInFlight?: () => boolean;

  /**
   * Callback invoked whenever the power safety state changes.
   */
  onStateChange?: (state: {
    operationalState: PowerOperationalState;
    acceptingTransactions: boolean;
  }) => void;
}

export interface PowerSafetyOverlayController {
  /** Current operational state ('Operational' | 'PowerEmergency' | 'Recovering' | 'Unknown') */
  getOperationalState(): PowerOperationalState;
  /** True if the kiosk is currently accepting customer transactions */
  isAcceptingTransactions(): boolean;
  /** Set or update a transaction reference ID displayed on the overlay */
  setTransactionReference(id: string | null): void;
  /** Notify that an in-flight print job has concluded (terminal outcome reached) */
  notifyPrintCompleted(): void;
  /** Manually apply a power status event (e.g. from tests or custom dispatcher) */
  updateState(event: WorkerPowerEventPayload): void;
  /** Detach socket listeners and remove injected DOM elements */
  destroy(): void;
}

const STYLE_ELEMENT_ID = 'printbit-power-safety-styles';
const OVERLAY_ELEMENT_ID = 'printbitPowerSafetyOverlay';
const BANNER_ELEMENT_ID = 'printbitPowerSafetyBanner';

const INJECTED_CSS = `
/* ── PrintBit Power Safety Maintenance Presentation ──────────────────────── */
.power-safety-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483640;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(14, 13, 31, 0.95);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  color: #ffffff;
  font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  opacity: 0;
  pointer-events: none;
  transition: opacity 300ms ease;
}

.power-safety-overlay.is-visible {
  opacity: 1;
  pointer-events: auto;
}

.power-safety-overlay__content {
  max-width: 580px;
  width: 90%;
  margin: 0 auto;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 40px 32px;
  background: rgba(26, 24, 54, 0.9);
  border: 1.5px solid rgba(245, 158, 11, 0.4);
  border-radius: 28px;
  box-shadow:
    0 28px 72px rgba(0, 0, 0, 0.65),
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 0 40px rgba(245, 158, 11, 0.15);
  animation: power-safety-arrive 400ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.power-safety-overlay__icon-wrapper {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fbbf24;
  margin-bottom: 4px;
}

.power-safety-overlay__icon {
  width: 44px;
  height: 44px;
  stroke: #fbbf24;
}

.power-safety-overlay__badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 14px;
  border-radius: 999px;
  background: rgba(245, 158, 11, 0.2);
  border: 1px solid rgba(245, 158, 11, 0.45);
  color: #fbbf24;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.power-safety-overlay__title {
  margin: 0;
  font-size: clamp(24px, 4vw, 32px);
  font-weight: 800;
  letter-spacing: -0.03em;
  color: #ffffff;
  line-height: 1.2;
}

.power-safety-overlay__message {
  margin: 0;
  font-size: clamp(16px, 2.5vw, 19px);
  font-weight: 600;
  color: #f1f5f9;
  line-height: 1.45;
}

.power-safety-overlay__status-pill {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 18px;
  background: rgba(14, 13, 31, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 999px;
  margin-top: 4px;
}

.power-safety-overlay__pulse {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fbbf24;
  box-shadow: 0 0 0 0 rgba(251, 191, 36, 0.7);
  animation: power-safety-pulse 2s infinite;
}

.power-safety-overlay__status-text {
  font-size: 14px;
  font-weight: 500;
  color: #cbd5e1;
}

.power-safety-overlay__subtext {
  margin: 0;
  font-size: 14px;
  color: #94a3b8;
  line-height: 1.5;
  max-width: 480px;
}

.power-safety-overlay__ref {
  margin-top: 6px;
  padding: 6px 16px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  font-family: monospace;
  font-size: 13px;
  color: #a7aae1;
}

/* ── Non-Blocking In-Flight Banner ─────────────────────────────────────────── */
.power-safety-banner {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%) translateY(-120px);
  z-index: 2147483630;
  max-width: 660px;
  width: calc(100% - 32px);
  background: rgba(24, 20, 36, 0.96);
  border: 1.5px solid #f59e0b;
  border-radius: 16px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5), 0 0 24px rgba(245, 158, 11, 0.25);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  padding: 14px 20px;
  display: flex;
  align-items: center;
  gap: 14px;
  color: #ffffff;
  font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  pointer-events: none;
  transition: transform 350ms cubic-bezier(0.16, 1, 0.3, 1), opacity 300ms ease;
  opacity: 0;
}

.power-safety-banner.is-visible {
  transform: translateX(-50%) translateY(0);
  opacity: 1;
}

.power-safety-banner__icon {
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: rgba(245, 158, 11, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fbbf24;
}

.power-safety-banner__icon svg {
  width: 22px;
  height: 22px;
  stroke: #fbbf24;
}

.power-safety-banner__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.power-safety-banner__title {
  font-size: 15px;
  font-weight: 700;
  color: #ffffff;
}

.power-safety-banner__detail {
  font-size: 13px;
  font-weight: 500;
  color: #e2e8f0;
  opacity: 0.9;
}

.power-safety-banner__spinner {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border: 2.5px solid rgba(251, 191, 36, 0.25);
  border-top-color: #fbbf24;
  border-radius: 50%;
  animation: power-safety-spin 1s linear infinite;
}

@keyframes power-safety-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(251, 191, 36, 0.7);
  }
  70% {
    box-shadow: 0 0 0 10px rgba(251, 191, 36, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(251, 191, 36, 0);
  }
}

@keyframes power-safety-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes power-safety-arrive {
  0% {
    transform: scale(0.95);
    opacity: 0;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}
`;

function ensureStylesInjected(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ELEMENT_ID)) return;

  const styleEl = document.createElement('style');
  styleEl.id = STYLE_ELEMENT_ID;
  styleEl.textContent = INJECTED_CSS;
  document.head?.appendChild(styleEl);
}

export function attachPowerSafetyOverlay(
  options: PowerSafetyOverlayOptions = {},
): PowerSafetyOverlayController {
  let operationalState: PowerOperationalState = 'Unknown';
  let acceptingTransactions = false;
  let transactionReferenceId: string | null = null;
  let destroyed = false;
  /**
   * Set to true when the host calls notifyPrintCompleted() — i.e. any terminal
   * outcome (success, failure, hardware error, catch block). Once set, the
   * overlay no longer defers to `options.isPrintInFlight()` so it can show the
   * full blocking overlay even if the caller intentionally keeps its spooler
   * correlation keys alive for maintenance-reference purposes.
   */
  let printCompleted = false;

  ensureStylesInjected();

  // Create DOM elements if running in browser
  let overlayEl: HTMLElement | null = null;
  let bannerEl: HTMLElement | null = null;
  let statusTextEl: HTMLElement | null = null;
  let refEl: HTMLElement | null = null;

  if (typeof document !== 'undefined') {
    // 1. Full Blocking Overlay
    overlayEl = document.getElementById(OVERLAY_ELEMENT_ID);
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.id = OVERLAY_ELEMENT_ID;
      overlayEl.className = 'power-safety-overlay';
      overlayEl.setAttribute('role', 'alertdialog');
      overlayEl.setAttribute('aria-modal', 'true');
      overlayEl.setAttribute('aria-live', 'assertive');
      overlayEl.setAttribute('hidden', '');

      overlayEl.innerHTML = `
        <div class="power-safety-overlay__content">
          <div class="power-safety-overlay__icon-wrapper">
            <svg class="power-safety-overlay__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m13 2-2 7h5l-4 13 2-7H9l4-13z"></path>
            </svg>
          </div>
          <div class="power-safety-overlay__badge">Maintenance Mode</div>
          <h1 class="power-safety-overlay__title">Kiosk Temporarily Unavailable</h1>
          <p class="power-safety-overlay__message">Power event detected. Please wait while power stabilizes.</p>
          <div class="power-safety-overlay__status-pill">
            <span class="power-safety-overlay__pulse"></span>
            <span class="power-safety-overlay__status-text" id="powerSafetyStatusText">Monitoring power supply...</span>
          </div>
          <p class="power-safety-overlay__subtext">
            The kiosk is operating on backup power. Paid operations and coin acceptance will resume automatically once power is restored.
          </p>
          <div class="power-safety-overlay__ref" id="powerSafetyRef" hidden></div>
        </div>
      `;
      document.body?.appendChild(overlayEl);
    }

    statusTextEl = overlayEl.querySelector('#powerSafetyStatusText');
    refEl = overlayEl.querySelector('#powerSafetyRef');

    // 2. Non-blocking In-Flight Banner
    bannerEl = document.getElementById(BANNER_ELEMENT_ID);
    if (!bannerEl) {
      bannerEl = document.createElement('div');
      bannerEl.id = BANNER_ELEMENT_ID;
      bannerEl.className = 'power-safety-banner';
      bannerEl.setAttribute('role', 'status');
      bannerEl.setAttribute('aria-live', 'polite');
      bannerEl.setAttribute('hidden', '');

      bannerEl.innerHTML = `
        <div class="power-safety-banner__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m13 2-2 7h5l-4 13 2-7H9l4-13z"></path>
          </svg>
        </div>
        <div class="power-safety-banner__body">
          <span class="power-safety-banner__title">Power event detected. Finishing current print job...</span>
          <span class="power-safety-banner__detail">Please wait for your document to finish printing before leaving.</span>
        </div>
        <div class="power-safety-banner__spinner"></div>
      `;
      document.body?.appendChild(bannerEl);
    }
  }

  function updatePresentation(): void {
    if (destroyed) return;

    if (acceptingTransactions && operationalState === 'Operational') {
      // Power is operational -> hide all overlays and banners
      if (overlayEl) {
        overlayEl.classList.remove('is-visible');
        overlayEl.setAttribute('hidden', '');
      }
      if (bannerEl) {
        bannerEl.classList.remove('is-visible');
        bannerEl.setAttribute('hidden', '');
      }
      return;
    }

    // Power is in an emergency / recovering / unknown.
    // If notifyPrintCompleted() has already been called, treat the job as
    // finished even if the caller still holds correlation keys for maintenance.
    const inFlight =
      !printCompleted &&
      (options.isPrintInFlight ? options.isPrintInFlight() : false);

    if (inFlight) {
      // Show non-blocking banner, hide full overlay
      if (overlayEl) {
        overlayEl.classList.remove('is-visible');
        overlayEl.setAttribute('hidden', '');
      }
      if (bannerEl) {
        bannerEl.removeAttribute('hidden');
        // Trigger reflow for smooth transition
        void bannerEl.offsetWidth;
        bannerEl.classList.add('is-visible');
      }
    } else {
      // Show full blocking overlay, hide banner
      if (bannerEl) {
        bannerEl.classList.remove('is-visible');
        bannerEl.setAttribute('hidden', '');
      }
      if (overlayEl) {
        if (statusTextEl) {
          if (operationalState === 'Recovering') {
            statusTextEl.textContent = 'Power restored. Stabilizing hardware...';
          } else if (operationalState === 'PowerEmergency') {
            statusTextEl.textContent = 'Operating on emergency battery power';
          } else {
            statusTextEl.textContent = 'Monitoring power supply...';
          }
        }

        if (refEl) {
          if (transactionReferenceId) {
            refEl.textContent = `Reference ID: ${transactionReferenceId}`;
            refEl.removeAttribute('hidden');
          } else {
            refEl.setAttribute('hidden', '');
          }
        }

        overlayEl.removeAttribute('hidden');
        void overlayEl.offsetWidth;
        overlayEl.classList.add('is-visible');
      }
    }
  }

  function handlePowerEvent(evt: WorkerPowerEventPayload): void {
    if (!evt) return;

    if (typeof evt.acceptingTransactions === 'boolean') {
      acceptingTransactions = evt.acceptingTransactions;
    } else {
      acceptingTransactions = evt.operationalState === 'Operational';
    }

    if (evt.operationalState) {
      operationalState = evt.operationalState;
    }

    if (evt.transactionId) {
      transactionReferenceId = evt.transactionId;
    }

    options.onStateChange?.({ operationalState, acceptingTransactions });
    updatePresentation();
  }

  // Socket subscription helper
  let attachedSocket: Socket | null = null;
  const attachToSocket = (sock: Socket) => {
    if (!sock || attachedSocket === sock || typeof sock.on !== 'function') return;
    attachedSocket = sock;
    sock.on('workerPowerStatusChanged', handlePowerEvent);
  };

  // 1. Resolve passed socket or fallback to window.io
  if (options.socket) {
    if (typeof options.socket === 'function') {
      try {
        attachToSocket(options.socket());
      } catch {
        // Fallback below
      }
    } else {
      attachToSocket(options.socket);
    }
  }

  if (!attachedSocket && typeof window !== 'undefined') {
    const ioFactory = (window as unknown as { io?: () => Socket }).io;
    if (typeof ioFactory === 'function') {
      try {
        attachToSocket(ioFactory());
      } catch {
        // Wait or retry on DOMContentLoaded
      }
    }
  }

  // 2. Fetch initial status from /api/power-safety/status
  if (typeof fetch === 'function') {
    void fetch('/api/power-safety/status')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<WorkerPowerEventPayload>;
      })
      .then((data) => {
        if (!destroyed) {
          handlePowerEvent(data);
        }
      })
      .catch(() => {
        // Fail-closed: on any network error or non-OK response, run
        // updatePresentation() so the overlay is shown if power state is
        // unknown (rather than leaving it hidden and fail-open).
        if (!destroyed) {
          updatePresentation();
        }
      });
  } else {
    // Non-browser or environments without fetch: run initial presentation
    updatePresentation();
  }

  return {
    getOperationalState() {
      return operationalState;
    },
    isAcceptingTransactions() {
      return acceptingTransactions;
    },
    setTransactionReference(id: string | null) {
      transactionReferenceId = id?.trim() || null;
      if (refEl) {
        if (transactionReferenceId) {
          refEl.textContent = `Reference ID: ${transactionReferenceId}`;
          refEl.removeAttribute('hidden');
        } else {
          refEl.setAttribute('hidden', '');
        }
      }
    },
    notifyPrintCompleted() {
      printCompleted = true;
      updatePresentation();
    },
    updateState(event: WorkerPowerEventPayload) {
      handlePowerEvent(event);
    },
    destroy() {
      destroyed = true;
      if (attachedSocket && typeof attachedSocket.off === 'function') {
        attachedSocket.off('workerPowerStatusChanged', handlePowerEvent);
      }
      overlayEl?.remove();
      bannerEl?.remove();
      const styleEl = typeof document !== 'undefined'
        ? document.getElementById(STYLE_ELEMENT_ID)
        : null;
      styleEl?.remove();
    },
  };
}
