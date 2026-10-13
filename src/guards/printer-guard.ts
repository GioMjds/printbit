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
 *                 → GET /api/printer/active-error → renders customer error guide modal
 *                   if active blocking hardware fault exists.
 *   2. Runtime    → listens to `printerMalfunction` socket event → blocks UI.
 *                 → listens to `printer:error-guide-update` socket event → mounts or
 *                   clears customer error guide modal without buttons.
 *   3. Recovery   → listens to `printerRecovered` socket event   → restores UI.
 *   4. Always     → dispatches `printer:block` CustomEvent on window so the coin
 *                   acceptor controller can gate coin input without coupling to
 *                   this module.
 *
 * SOCKET EVENTS consumed (emitted by printer-monitor.ts on the server):
 *   printerMalfunction         → { status, statusFlags, printerName, timestamp }
 *   printerRecovered           → { status, printerName, timestamp }
 *   printer:error-guide-update → { activeError: ActivePrinterErrorState | null }
 */

import { PrinterErrorGuideModalController } from '../public/shared/printer-error-guide-modal';
import type { ActivePrinterErrorState } from '@/services/printer-error-state';

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

interface ActiveErrorResponse {
  activeError: ActivePrinterErrorState | null;
  outOfService?: boolean;
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

export interface PrinterGuardOptions {
  /**
   * Filter mode for active error display:
   * - 'all' (default): displays all errors (e.g. Confirm page)
   * - 'kiosk_wide_only': displays only fatal kiosk-wide errors ('E_INK_OUT', 'E_OFFLINE', 'E_SERVICE')
   */
  mode?: 'all' | 'kiosk_wide_only';
}

const KIOSK_WIDE_ERROR_CODES = new Set(['E_INK_OUT', 'E_OFFLINE', 'E_SERVICE']);

// ── Module-level state ────────────────────────────────────────────────────────

let _guardOptions: PrinterGuardOptions = { mode: 'all' };
let _socket: SocketLike | null = null;
let _malfunctionHandler: ((p: unknown) => void) | null = null;
let _recoveredHandler: ((p: unknown) => void) | null = null;
let _errorGuideUpdateHandler: ((p: unknown) => void) | null = null;
let _paperJamClearedHandler: (() => void) | null = null;
let _errorGuideModal: PrinterErrorGuideModalController | null = null;

// ── DOM helpers ───────────────────────────────────────────────────────────────

function getOverlay(): HTMLElement | null {
  return document.getElementById('printer-unavailable');
}

function getIdleScreen(): HTMLElement | null {
  // Matches the existing #kiosk-idle wrapper used on the home/idle page.
  // Adjust this selector if your idle container has a different id.
  return document.getElementById('kiosk-idle');
}

function getCurrentLanguage(): 'en' | 'fil' {
  try {
    return window.localStorage.getItem('printbit.kiosk.language') === 'fil'
      ? 'fil'
      : 'en';
  } catch {
    return 'en';
  }
}

// ── Core state application ────────────────────────────────────────────────────

function applyState(
  blocked: boolean,
  status: string,
  printerName?: string | null,
): void {
  const overlay = getOverlay();
  const idle = getIdleScreen();
  const modalVisible = _errorGuideModal ? _errorGuideModal.isVisible() : false;
  const effectiveBlocked = blocked || modalVisible;

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
    idle.style.display = effectiveBlocked ? 'none' : '';
  }

  // Signal the coin acceptor controller — it listens for this event
  // and enables/disables coin acceptance independently of this module.
  window.dispatchEvent(
    new CustomEvent('printer:block', {
      detail: {
        blocked: effectiveBlocked,
        status,
        printerName: printerName ?? null,
      },
    }),
  );

  console.log(`[printer-guard] blocked=${effectiveBlocked} status="${status}"`);
}

// ── Initial REST checks ───────────────────────────────────────────────────────

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

function shouldDisplayError(code: string): boolean {
  if (_guardOptions.mode === 'kiosk_wide_only') {
    return KIOSK_WIDE_ERROR_CODES.has(code);
  }
  return true;
}

async function checkActiveErrorOnLoad(): Promise<void> {
  try {
    const res = await fetch('/api/printer/active-error');

    if (!res.ok) {
      console.warn(
        `[printer-guard] /api/printer/active-error returned ${res.status}`,
      );
      return;
    }

    const data = (await res.json()) as ActiveErrorResponse;
    if (data.activeError && shouldDisplayError(data.activeError.code)) {
      _errorGuideModal?.render(data.activeError);
      applyState(true, data.activeError.code);
    } else {
      _errorGuideModal?.clear();
    }
  } catch (err) {
    console.error(
      '[printer-guard] Failed to reach /api/printer/active-error:',
      err,
    );
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

function onErrorGuideUpdate(raw: unknown): void {
  const payload = raw as { activeError: ActivePrinterErrorState | null } | null;
  const activeError = payload?.activeError;
  if (activeError && shouldDisplayError(activeError.code)) {
    _errorGuideModal?.render(activeError);
    applyState(true, activeError.code);
  } else {
    _errorGuideModal?.clear();
    const overlay = getOverlay();
    const stillBlocked = overlay ? overlay.style.display === 'flex' : false;
    applyState(stillBlocked, stillBlocked ? 'Blocked' : 'Ready');
  }
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
export async function initPrinterGuard(
  socket?: SocketLike | null,
  options?: PrinterGuardOptions,
): Promise<void> {
  // Tear down any previous bindings (guards against double-init / hot reload)
  destroyPrinterGuard();

  _guardOptions = options ?? { mode: 'all' };

  const ioFactory = (window as unknown as { io?: () => SocketLike }).io;
  _socket = socket ?? (typeof ioFactory === 'function' ? ioFactory() : null);

  if (typeof document !== 'undefined' && document.body) {
    _errorGuideModal = new PrinterErrorGuideModalController({
      container: document.body,
      getLanguage: getCurrentLanguage,
      onCancelJob: () => {
        _errorGuideModal?.clear();
        if (typeof window !== 'undefined' && window.location.pathname !== '/') {
          window.location.href = '/';
        }
      },
    });
  }

  if (_socket) {
    // Store bound handlers so they can be removed later
    _malfunctionHandler = (raw: unknown) => onMalfunction(raw);
    _recoveredHandler = (raw: unknown) => onRecovered(raw);
    _errorGuideUpdateHandler = (raw: unknown) => onErrorGuideUpdate(raw);
    _paperJamClearedHandler = () => {
      _errorGuideModal?.clear();
      if (typeof window !== 'undefined' && window.location.pathname !== '/') {
        window.location.href = '/';
      }
    };

    _socket.on('printerMalfunction', _malfunctionHandler);
    _socket.on('printerRecovered', _recoveredHandler);
    _socket.on('printer:error-guide-update', _errorGuideUpdateHandler);
    _socket.on('printer:paper-jam-cleared', _paperJamClearedHandler);
  }

  // Block the UI immediately while the fetch is in-flight — the overlay
  // starts hidden by default so we briefly show "checking..." state by
  // calling applyState(true) before the fetch resolves. Comment this out
  // if you prefer the UI to remain visible while checking.
  applyState(true, 'Checking…');

  await Promise.all([checkStatusOnLoad(), checkActiveErrorOnLoad()]);

  console.log('[printer-guard] initialized, mode=' + _guardOptions.mode);
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
    if (_errorGuideUpdateHandler)
      _socket.off('printer:error-guide-update', _errorGuideUpdateHandler);
    if (_paperJamClearedHandler)
      _socket.off('printer:paper-jam-cleared', _paperJamClearedHandler);
  }
  _socket = null;
  _malfunctionHandler = null;
  _recoveredHandler = null;
  _errorGuideUpdateHandler = null;
  _paperJamClearedHandler = null;

  if (_errorGuideModal) {
    _errorGuideModal.clear();
    const overlay = document.querySelector('.printer-error-guide-overlay');
    overlay?.remove();
    _errorGuideModal = null;
  }
}

/**
 * Returns true if the printer is currently blocking the kiosk UI.
 * Useful for guards elsewhere (e.g. preventing navigation to print flow).
 */
export function isPrinterBlocked(): boolean {
  const overlay = getOverlay();
  const modalVisible = _errorGuideModal ? _errorGuideModal.isVisible() : false;
  return (overlay ? overlay.style.display === 'flex' : false) || modalVisible;
}

/**
 * Returns the current modal controller instance if initialized.
 */
export function getPrinterErrorGuideModal(): PrinterErrorGuideModalController | null {
  return _errorGuideModal;
}
