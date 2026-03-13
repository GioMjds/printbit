/**
 * printer-guard.ts
 *
 * Client-side printer readiness gate for kiosk pages.
 *
 * USAGE — add to any kiosk page that accepts coins (same pattern as idle-timeout.ts):
 *
 *   import { initPrinterGuard } from './printer-guard';
 *
 *   const socket = io();
 *   initPrinterGuard(socket);
 *
 * REQUIRED HTML — paste the overlay block once inside <body> on each guarded page:
 *   See printer-unavailable-overlay.html
 *
 * WHAT IT DOES:
 *   1. On init    → GET /api/printer/status → applies current state before any user
 *                   interaction is possible (fail-safe: blocks on network error).
 *   2. Runtime    → listens to `printerMalfunction` socket event → blocks UI.
 *   3. Recovery   → listens to `printerRecovered` socket event   → restores UI.
 *   4. Always     → dispatches `printer:block` CustomEvent on window so the coin
 *                   acceptor controller can gate coin input without coupling to
 *                   this module.
 *
 * SOCKET EVENTS consumed (emitted by printer-monitor.ts on the server):
 *   printerMalfunction   → { status, statusFlags, printerName, timestamp }
 *   printerRecovered     → { status, printerName, timestamp }
 */

// ── Types ─────────────────────────────────────────────────────────────────────

interface SocketLike {
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
}

interface PrinterStatusResponse {
  ready: boolean;
  blocked: boolean;
  status: string;
  printerName: string | null;
  lastCheckedAt: string;
}

interface MalfunctionPayload {
  status: string;
  statusFlags?: string[];
  printerName?: string | null;
  timestamp?: string;
}

interface RecoveredPayload {
  status: string;
  printerName?: string | null;
  timestamp?: string;
}

// ── Module-level state ────────────────────────────────────────────────────────

let _socket: SocketLike | null = null;
let _malfunctionHandler: ((p: unknown) => void) | null = null;
let _recoveredHandler: ((p: unknown) => void) | null = null;

// ── DOM helpers ───────────────────────────────────────────────────────────────

function getOverlay(): HTMLElement | null {
  return document.getElementById('printer-unavailable');
}

function getIdleScreen(): HTMLElement | null {
  // Matches the existing #kiosk-idle wrapper used on the home/idle page.
  // Adjust this selector if your idle container has a different id.
  return document.getElementById('kiosk-idle');
}

// ── Core state application ────────────────────────────────────────────────────

function applyState(
  blocked: boolean,
  status: string,
  printerName?: string | null,
): void {
  const overlay = getOverlay();
  const idle = getIdleScreen();

  // Toggle overlay visibility
  if (overlay) {
    overlay.style.display = blocked ? 'flex' : 'none';
    overlay.setAttribute('aria-hidden', String(!blocked));

    // Update the status text inside the overlay if the element exists
    const statusEl = overlay.querySelector<HTMLElement>(
      '[data-printer-status]',
    );
    if (statusEl) statusEl.textContent = status;

    const nameEl = overlay.querySelector<HTMLElement>('[data-printer-name]');
    if (nameEl && printerName) nameEl.textContent = printerName;
  }

  // Hide/show the normal kiosk idle content
  if (idle) {
    idle.style.display = blocked ? 'none' : '';
  }

  // Signal the coin acceptor controller — it listens for this event
  // and enables/disables coin acceptance independently of this module.
  window.dispatchEvent(
    new CustomEvent('printer:block', {
      detail: { blocked, status, printerName: printerName ?? null },
    }),
  );

  console.log(`[printer-guard] blocked=${blocked} status="${status}"`);
}

// ── Initial REST check ────────────────────────────────────────────────────────

async function checkStatusOnLoad(): Promise<void> {
  try {
    const res = await fetch('/api/printer/status');

    if (!res.ok) {
      console.warn(
        `[printer-guard] /api/printer/status returned ${res.status} — blocking UI`,
      );
      applyState(true, 'Unavailable');
      return;
    }

    const data = (await res.json()) as PrinterStatusResponse;
    applyState(data.blocked, data.status, data.printerName);
  } catch (err) {
    // Network failure at startup — fail safe: block the UI so no coins can be inserted
    console.error('[printer-guard] Failed to reach /api/printer/status:', err);
    applyState(true, 'Unavailable');
  }
}

// ── Socket event handlers ─────────────────────────────────────────────────────

function onMalfunction(raw: unknown): void {
  const payload = raw as MalfunctionPayload;
  console.warn(
    `[printer-guard] printerMalfunction received: "${payload.status}"`,
  );
  applyState(true, payload.status, payload.printerName);
}

function onRecovered(raw: unknown): void {
  const payload = raw as RecoveredPayload;
  console.log(`[printer-guard] printerRecovered received: "${payload.status}"`);
  applyState(false, payload.status, payload.printerName);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize the PrinterGuard on a kiosk page.
 *
 * Call once per page, after the DOM is ready, with the active Socket.IO client.
 * Safe to call multiple times — previous listeners are removed before re-attaching.
 *
 * @example
 *   import { initPrinterGuard } from './printer-guard';
 *   const socket = io();
 *   initPrinterGuard(socket);
 */
export async function initPrinterGuard(socket: SocketLike): Promise<void> {
  // Tear down any previous bindings (guards against double-init / hot reload)
  destroyPrinterGuard();

  _socket = socket;

  // Store bound handlers so they can be removed later
  _malfunctionHandler = (raw: unknown) => onMalfunction(raw);
  _recoveredHandler = (raw: unknown) => onRecovered(raw);

  socket.on('printerMalfunction', _malfunctionHandler);
  socket.on('printerRecovered', _recoveredHandler);

  // Block the UI immediately while the fetch is in-flight — the overlay
  // starts hidden by default so we briefly show "checking..." state by
  // calling applyState(true) before the fetch resolves. Comment this out
  // if you prefer the UI to remain visible while checking.
  applyState(true, 'Checking…');

  await checkStatusOnLoad();

  console.log('[printer-guard] initialized');
}

/**
 * Remove all socket listeners added by initPrinterGuard.
 * Called automatically on re-init; call manually on page teardown if needed.
 */
export function destroyPrinterGuard(): void {
  if (_socket) {
    if (_malfunctionHandler)
      _socket.off('printerMalfunction', _malfunctionHandler);
    if (_recoveredHandler) _socket.off('printerRecovered', _recoveredHandler);
  }
  _socket = null;
  _malfunctionHandler = null;
  _recoveredHandler = null;
}

/**
 * Returns true if the printer is currently blocking the kiosk UI.
 * Useful for guards elsewhere (e.g. preventing navigation to print flow).
 */
export function isPrinterBlocked(): boolean {
  const overlay = getOverlay();
  return overlay ? overlay.style.display === 'flex' : false;
}
