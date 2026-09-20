/**
 * PrintBit UI Blocking Overlay & On-Screen Staff Unlock Module
 *
 * Provides a full-screen blocking overlay when the kiosk is in:
 *  - 'maintenance': Under Scheduled Maintenance
 *  - 'needs_admin': Attendant Assistance Required
 *  - 'out_of_service': Temporarily Out of Service
 *
 * Includes an on-screen discreet Staff Access button with PIN keypad modal
 * allowing attendants to disable UI blocking or access the admin console.
 */

export type UiBlockingMode = 'maintenance' | 'needs_admin' | 'out_of_service';

export interface UiBlockingSettings {
  enabled: boolean;
  mode: UiBlockingMode;
  customMessage: string;
}

export interface UiBlockingOverlayOptions {
  /**
   * Existing Socket.IO instance or getter function returning socket.
   * If omitted, falls back to `(window as any).io?.()`.
   */
  socket?: any;

  /**
   * Callback invoked whenever UI blocking state changes.
   */
  onStateChange?: (state: UiBlockingSettings) => void;
}

export interface UiBlockingOverlayController {
  getState(): UiBlockingSettings;
  isEnabled(): boolean;
  updateState(state: Partial<UiBlockingSettings>): void;
  show(): void;
  hide(): void;
  destroy(): void;
}

const STYLE_ELEMENT_ID = 'printbit-ui-blocking-styles';
const OVERLAY_ELEMENT_ID = 'printbitUiBlockingOverlay';
const STAFF_BTN_ID = 'uiBlockingStaffBtn';
const MODAL_ELEMENT_ID = 'uiBlockingPinModal';

const MODE_CONFIGS: Record<
  UiBlockingMode,
  {
    badge: string;
    title: string;
    description: string;
    accentColor: string;
    badgeBg: string;
    badgeBorder: string;
    iconSvg: string;
  }
> = {
  maintenance: {
    badge: 'Scheduled Maintenance',
    title: 'Under Scheduled Maintenance',
    description:
      'The kiosk is undergoing routine maintenance or hardware updates.',
    accentColor: '#fbbf24',
    badgeBg: 'rgba(245, 158, 11, 0.18)',
    badgeBorder: 'rgba(245, 158, 11, 0.45)',
    iconSvg: `
      <svg class="ui-blocking-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
      </svg>
    `,
  },
  needs_admin: {
    badge: 'Assistance Required',
    title: 'Attendant Assistance Required',
    description: 'Please notify staff or an administrator.',
    accentColor: '#60a5fa',
    badgeBg: 'rgba(59, 130, 246, 0.18)',
    badgeBorder: 'rgba(59, 130, 246, 0.45)',
    iconSvg: `
      <svg class="ui-blocking-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <circle cx="12" cy="10" r="3"/>
        <path d="M6.16 17.5A6 6 0 0 1 12 14a6 6 0 0 1 5.84 3.5"/>
      </svg>
    `,
  },
  out_of_service: {
    badge: 'Out of Service',
    title: 'Temporarily Out of Service',
    description: 'This kiosk is currently unavailable.',
    accentColor: '#f87171',
    badgeBg: 'rgba(239, 68, 68, 0.18)',
    badgeBorder: 'rgba(239, 68, 68, 0.45)',
    iconSvg: `
      <svg class="ui-blocking-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m21 16-9 5-9-5V8l9-5 9 5v8z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
    `,
  },
};

const INJECTED_CSS = `
/* ── PrintBit UI Blocking Overlay Presentation ───────────────────────────── */
#${OVERLAY_ELEMENT_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483645;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(10, 10, 22, 0.96);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  color: #ffffff;
  font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  opacity: 0;
  pointer-events: none;
  transition: opacity 300ms cubic-bezier(0.16, 1, 0.3, 1);
}

#${OVERLAY_ELEMENT_ID}.is-visible {
  opacity: 1;
  pointer-events: auto;
}

.ui-blocking-content {
  max-width: 580px;
  width: 90%;
  margin: 0 auto;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  padding: 44px 32px;
  background: rgba(24, 22, 48, 0.92);
  border: 1.5px solid rgba(255, 255, 255, 0.12);
  border-radius: 32px;
  box-shadow:
    0 32px 80px rgba(0, 0, 0, 0.75),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  animation: ui-blocking-arrive 400ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.ui-blocking-icon-wrapper {
  width: 88px;
  height: 88px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 2px;
  transition: background 300ms ease, border-color 300ms ease;
}

.ui-blocking-icon {
  width: 46px;
  height: 46px;
}

.ui-blocking-badge {
  display: inline-flex;
  align-items: center;
  padding: 5px 16px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  transition: color 300ms ease, background 300ms ease, border-color 300ms ease;
}

.ui-blocking-title {
  margin: 0;
  font-size: clamp(24px, 4vw, 32px);
  font-weight: 800;
  letter-spacing: -0.03em;
  color: #ffffff;
  line-height: 1.22;
}

.ui-blocking-desc {
  margin: 0;
  font-size: clamp(15px, 2.5vw, 17px);
  font-weight: 500;
  color: #cbd5e1;
  line-height: 1.5;
  max-width: 480px;
}

.ui-blocking-note {
  width: 100%;
  max-width: 480px;
  text-align: left;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 16px;
  padding: 14px 18px;
  box-sizing: border-box;
}

.ui-blocking-note__label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #94a3b8;
  margin-bottom: 4px;
}

.ui-blocking-note__text {
  font-size: 14px;
  color: #f1f5f9;
  line-height: 1.45;
  word-break: break-word;
}

/* ── Discreet Staff Access Lock Button ───────────────────────────────────── */
#${STAFF_BTN_ID} {
  position: absolute;
  bottom: 24px;
  right: 24px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  padding: 10px 18px;
  color: #94a3b8;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  outline: none;
  transition: all 200ms ease;
  z-index: 10;
}

#${STAFF_BTN_ID}:hover,
#${STAFF_BTN_ID}:focus-visible {
  background: rgba(255, 255, 255, 0.15);
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.35);
  transform: translateY(-1px);
}

#${STAFF_BTN_ID} svg {
  width: 15px;
  height: 15px;
  stroke: currentColor;
}

/* ── Staff PIN Modal Presentation ────────────────────────────────────────── */
#${MODAL_ELEMENT_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 7, 18, 0.88);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: #ffffff;
  opacity: 0;
  pointer-events: none;
  transition: opacity 250ms ease;
}

#${MODAL_ELEMENT_ID}.is-visible {
  opacity: 1;
  pointer-events: auto;
}

.ui-blocking-modal-card {
  max-width: 400px;
  width: 90%;
  margin: 0 auto;
  background: rgba(26, 24, 52, 0.98);
  border: 1.5px solid rgba(255, 255, 255, 0.18);
  border-radius: 28px;
  padding: 32px 26px;
  text-align: center;
  box-shadow: 0 28px 70px rgba(0, 0, 0, 0.7);
  animation: ui-blocking-arrive 300ms cubic-bezier(0.16, 1, 0.3, 1) both;
  box-sizing: border-box;
}

.ui-blocking-modal__title {
  margin: 0 0 6px;
  font-size: 22px;
  font-weight: 800;
  color: #ffffff;
}

.ui-blocking-modal__desc {
  margin: 0 0 16px;
  font-size: 14px;
  color: #94a3b8;
  line-height: 1.4;
}

.ui-blocking-pin__input {
  width: 100%;
  height: 52px;
  background: rgba(14, 12, 28, 0.85);
  border: 1.5px solid rgba(255, 255, 255, 0.2);
  border-radius: 14px;
  font-size: 26px;
  font-family: inherit;
  font-weight: 700;
  color: #ffffff;
  text-align: center;
  letter-spacing: 0.35em;
  outline: none;
  box-sizing: border-box;
  transition: border-color 200ms ease;
}

.ui-blocking-pin__input:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25);
}

.ui-blocking-pin__error {
  min-height: 22px;
  font-size: 13px;
  font-weight: 600;
  color: #f87171;
  margin: 8px 0 12px;
}

.ui-blocking-keypad {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 20px;
}

.ui-blocking-keypad__btn {
  height: 48px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  color: #ffffff;
  font-size: 19px;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  outline: none;
  transition: all 150ms ease;
}

.ui-blocking-keypad__btn:hover,
.ui-blocking-keypad__btn:focus-visible {
  background: rgba(255, 255, 255, 0.16);
  border-color: rgba(255, 255, 255, 0.25);
  transform: translateY(-1px);
}

.ui-blocking-keypad__btn:active {
  transform: translateY(1px);
  background: rgba(255, 255, 255, 0.22);
}

.ui-blocking-keypad__btn--fn {
  font-size: 13px;
  font-weight: 600;
  color: #cbd5e1;
}

.ui-blocking-actions-row {
  display: flex;
  gap: 10px;
}

.ui-blocking-actions-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 18px;
}

.ui-blocking-btn {
  flex: 1;
  height: 46px;
  border-radius: 14px;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  outline: none;
  transition: all 200ms ease;
  border: none;
  box-sizing: border-box;
}

.ui-blocking-btn--primary {
  background: #2563eb;
  color: #ffffff;
  box-shadow: 0 4px 14px rgba(37, 99, 235, 0.35);
}

.ui-blocking-btn--primary:hover,
.ui-blocking-btn--primary:focus-visible {
  background: #1d4ed8;
  transform: translateY(-1px);
}

.ui-blocking-btn--secondary {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.ui-blocking-btn--secondary:hover,
.ui-blocking-btn--secondary:focus-visible {
  background: rgba(255, 255, 255, 0.18);
  transform: translateY(-1px);
}

.ui-blocking-btn--ghost {
  background: transparent;
  color: #94a3b8;
  border: 1px solid rgba(255, 255, 255, 0.15);
}

.ui-blocking-btn--ghost:hover,
.ui-blocking-btn--ghost:focus-visible {
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
}

.ui-blocking-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none !important;
}

@keyframes ui-blocking-arrive {
  0% {
    transform: scale(0.96);
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

function cancelActiveCustomerSessions(state: UiBlockingSettings): void {
  if (typeof window === 'undefined') return;

  // 1. Dispatch custom event for page controllers
  try {
    window.dispatchEvent(
      new CustomEvent('printbit:ui-blocking:enabled', { detail: state }),
    );
  } catch {}

  // 2. Cancel active wireless session if present
  try {
    const sessionId = sessionStorage.getItem('printbit.sessionId');
    const sessionToken = sessionStorage.getItem('printbit.sessionToken');
    if (sessionId && sessionToken) {
      void fetch(
        `/api/wireless/sessions/${encodeURIComponent(sessionId)}/cancel?token=${encodeURIComponent(sessionToken)}`,
        { method: 'DELETE' },
      ).catch(() => {});
    }
  } catch {}

  // 3. Cancel active payment session if present
  try {
    void fetch('/api/payment-session/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
  } catch {}

  // 4. Release copy preview or scan tokens
  try {
    const copyToken = sessionStorage.getItem('printbit.copyPreviewReleaseToken');
    if (copyToken) {
      void fetch('/api/copy/preview/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          releaseToken: copyToken,
          reason: 'ui_blocking',
        }),
      }).catch(() => {});
    }
    const scanToken = sessionStorage.getItem('printbit.scanReleaseToken');
    if (scanToken) {
      void fetch('/api/scan/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          releaseToken: scanToken,
          reason: 'ui_blocking',
        }),
      }).catch(() => {});
    }
  } catch {}

  // 5. Clean customer session storage
  try {
    sessionStorage.removeItem('printbit.config');
    sessionStorage.removeItem('printbit.sessionId');
    sessionStorage.removeItem('printbit.sessionToken');
    sessionStorage.removeItem('printbit.copyPreviewPath');
    sessionStorage.removeItem('printbit.copyPreviewReleaseToken');
    sessionStorage.removeItem('printbit.scanReleaseToken');
  } catch {}

  // 6. Dismiss any open idle modals
  try {
    const idleWarning =
      document.getElementById('idleWarningModal') ||
      document.querySelector('.idle-warning-overlay');
    if (idleWarning && idleWarning instanceof HTMLElement) {
      idleWarning.style.display = 'none';
    }
  } catch {}
}

const DEV_MODE_BANNER_ID = 'devModeBanner';

export function attachDevModeBanner(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(DEV_MODE_BANNER_ID)) return;
  const banner = document.createElement('div');
  banner.id = DEV_MODE_BANNER_ID;
  banner.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'right:0',
    'z-index:99998',
    'background:#b45309',
    'color:#fff',
    'font-size:13px',
    'font-weight:600',
    'text-align:center',
    'padding:6px 12px',
    'letter-spacing:0.02em',
    'pointer-events:none',
  ].join(';');
  banner.textContent = '\uD83D\uDEE0 DEVELOPER TESTING MODE \u2014 Transactions tagged as TEST. No real earnings recorded.';
  document.body.prepend(banner);
}

export function removeDevModeBanner(): void {
  if (typeof document === 'undefined') return;
  const banner = document.getElementById(DEV_MODE_BANNER_ID);
  banner?.remove();
}

export function attachUiBlockingOverlay(
  options: UiBlockingOverlayOptions = {},
): UiBlockingOverlayController {
  let currentSettings: UiBlockingSettings = {
    enabled: false,
    mode: 'maintenance',
    customMessage: '',
  };
  let destroyed = false;
  let isStaffModalSuccess = false;
  let verifiedPin = '';

  ensureStylesInjected();

  let overlayEl: HTMLElement | null = null;
  let modalEl: HTMLElement | null = null;

  let iconWrapperEl: HTMLElement | null = null;
  let badgeEl: HTMLElement | null = null;
  let titleEl: HTMLElement | null = null;
  let descEl: HTMLElement | null = null;
  let noteEl: HTMLElement | null = null;
  let noteTextEl: HTMLElement | null = null;
  let staffBtnEl: HTMLButtonElement | null = null;

  let pinFormViewEl: HTMLElement | null = null;
  let pinSuccessViewEl: HTMLElement | null = null;
  let pinInputEl: HTMLInputElement | null = null;
  let pinErrorEl: HTMLElement | null = null;
  let pinSubmitEl: HTMLButtonElement | null = null;
  let pinCancelEl: HTMLButtonElement | null = null;
  let disableBtnEl: HTMLButtonElement | null = null;
  let adminBtnEl: HTMLButtonElement | null = null;

  if (typeof document !== 'undefined') {
    // 1. Overlay Element
    overlayEl = document.getElementById(OVERLAY_ELEMENT_ID);
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.id = OVERLAY_ELEMENT_ID;
      overlayEl.setAttribute('role', 'alertdialog');
      overlayEl.setAttribute('aria-modal', 'true');
      overlayEl.setAttribute('aria-live', 'assertive');
      overlayEl.setAttribute('hidden', '');

      overlayEl.innerHTML = `
        <div class="ui-blocking-content">
          <div class="ui-blocking-icon-wrapper" id="uiBlockingIconWrapper"></div>
          <div class="ui-blocking-badge" id="uiBlockingBadge"></div>
          <h1 class="ui-blocking-title" id="uiBlockingTitle"></h1>
          <p class="ui-blocking-desc" id="uiBlockingDesc"></p>
          <div class="ui-blocking-note" id="uiBlockingNote" hidden>
            <div class="ui-blocking-note__label">Notice</div>
            <div class="ui-blocking-note__text" id="uiBlockingNoteText"></div>
          </div>
        </div>
        <button type="button" id="${STAFF_BTN_ID}" aria-label="Staff Access">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          <span>Staff Access</span>
        </button>
      `;
      document.body?.appendChild(overlayEl);
    }

    iconWrapperEl = overlayEl.querySelector('#uiBlockingIconWrapper');
    badgeEl = overlayEl.querySelector('#uiBlockingBadge');
    titleEl = overlayEl.querySelector('#uiBlockingTitle');
    descEl = overlayEl.querySelector('#uiBlockingDesc');
    noteEl = overlayEl.querySelector('#uiBlockingNote');
    noteTextEl = overlayEl.querySelector('#uiBlockingNoteText');
    staffBtnEl = overlayEl.querySelector(`#${STAFF_BTN_ID}`);

    // 2. Staff PIN Modal Element
    modalEl = document.getElementById(MODAL_ELEMENT_ID);
    if (!modalEl) {
      modalEl = document.createElement('div');
      modalEl.id = MODAL_ELEMENT_ID;
      modalEl.setAttribute('role', 'dialog');
      modalEl.setAttribute('aria-modal', 'true');
      modalEl.setAttribute('aria-label', 'Staff Access Unlock');
      modalEl.setAttribute('hidden', '');

      modalEl.innerHTML = `
        <div class="ui-blocking-modal-card">
          <div id="uiBlockingPinFormView">
            <h2 class="ui-blocking-modal__title">Staff Access</h2>
            <p class="ui-blocking-modal__desc">Enter administrator PIN to manage kiosk blocking.</p>
            <input
              type="password"
              id="uiBlockingPinInput"
              class="ui-blocking-pin__input"
              maxlength="10"
              placeholder="••••"
              inputmode="numeric"
              autocomplete="off"
            />
            <div id="uiBlockingPinError" class="ui-blocking-pin__error" aria-live="polite"></div>
            <div class="ui-blocking-keypad">
              <button type="button" class="ui-blocking-keypad__btn" data-key="1">1</button>
              <button type="button" class="ui-blocking-keypad__btn" data-key="2">2</button>
              <button type="button" class="ui-blocking-keypad__btn" data-key="3">3</button>
              <button type="button" class="ui-blocking-keypad__btn" data-key="4">4</button>
              <button type="button" class="ui-blocking-keypad__btn" data-key="5">5</button>
              <button type="button" class="ui-blocking-keypad__btn" data-key="6">6</button>
              <button type="button" class="ui-blocking-keypad__btn" data-key="7">7</button>
              <button type="button" class="ui-blocking-keypad__btn" data-key="8">8</button>
              <button type="button" class="ui-blocking-keypad__btn" data-key="9">9</button>
              <button type="button" class="ui-blocking-keypad__btn ui-blocking-keypad__btn--fn" data-key="clear">Clear</button>
              <button type="button" class="ui-blocking-keypad__btn" data-key="0">0</button>
              <button type="button" class="ui-blocking-keypad__btn ui-blocking-keypad__btn--fn" data-key="backspace">⌫</button>
            </div>
            <div class="ui-blocking-actions-row">
              <button type="button" id="uiBlockingPinCancel" class="ui-blocking-btn ui-blocking-btn--ghost">Cancel</button>
              <button type="button" id="uiBlockingPinSubmit" class="ui-blocking-btn ui-blocking-btn--primary">Submit</button>
            </div>
          </div>
          <div id="uiBlockingPinSuccessView" hidden>
            <h2 class="ui-blocking-modal__title">Staff Authenticated</h2>
            <p class="ui-blocking-modal__desc">Select an action to proceed:</p>
            <div class="ui-blocking-actions-stack">
              <button type="button" id="uiBlockingDisableBtn" class="ui-blocking-btn ui-blocking-btn--primary">
                Disable Blocking Mode
              </button>
              <button type="button" id="uiBlockingAdminBtn" class="ui-blocking-btn ui-blocking-btn--secondary">
                Open Admin Console
              </button>
            </div>
          </div>
        </div>
      `;
      document.body?.appendChild(modalEl);
    }

    pinFormViewEl = modalEl.querySelector('#uiBlockingPinFormView');
    pinSuccessViewEl = modalEl.querySelector('#uiBlockingPinSuccessView');
    pinInputEl = modalEl.querySelector('#uiBlockingPinInput');
    pinErrorEl = modalEl.querySelector('#uiBlockingPinError');
    pinSubmitEl = modalEl.querySelector('#uiBlockingPinSubmit');
    pinCancelEl = modalEl.querySelector('#uiBlockingPinCancel');
    disableBtnEl = modalEl.querySelector('#uiBlockingDisableBtn');
    adminBtnEl = modalEl.querySelector('#uiBlockingAdminBtn');
  }

  function renderPresentation(): void {
    if (!overlayEl) return;

    const mode = currentSettings.mode || 'maintenance';
    const config = MODE_CONFIGS[mode] || MODE_CONFIGS.maintenance;

    if (iconWrapperEl) {
      iconWrapperEl.innerHTML = config.iconSvg;
      iconWrapperEl.style.background = config.badgeBg;
      iconWrapperEl.style.border = `1.5px solid ${config.badgeBorder}`;
      iconWrapperEl.style.color = config.accentColor;
    }

    if (badgeEl) {
      badgeEl.textContent = config.badge;
      badgeEl.style.background = config.badgeBg;
      badgeEl.style.border = `1px solid ${config.badgeBorder}`;
      badgeEl.style.color = config.accentColor;
    }

    if (titleEl) {
      titleEl.textContent = config.title;
    }

    if (descEl) {
      descEl.textContent = config.description;
    }

    if (noteEl && noteTextEl) {
      const customMsg = currentSettings.customMessage?.trim();
      if (customMsg) {
        noteTextEl.textContent = customMsg;
        noteEl.removeAttribute('hidden');
      } else {
        noteEl.setAttribute('hidden', '');
      }
    }
  }

  function showOverlay(): void {
    if (!overlayEl) return;
    overlayEl.removeAttribute('hidden');
    void overlayEl.offsetWidth;
    overlayEl.classList.add('is-visible');
  }

  function hideOverlay(): void {
    if (!overlayEl) return;
    overlayEl.classList.remove('is-visible');
    overlayEl.setAttribute('hidden', '');
    closeStaffModal();
  }

  function openStaffModal(): void {
    if (!modalEl) return;
    isStaffModalSuccess = false;
    verifiedPin = '';

    if (pinFormViewEl) pinFormViewEl.removeAttribute('hidden');
    if (pinSuccessViewEl) pinSuccessViewEl.setAttribute('hidden', '');
    if (pinInputEl) {
      pinInputEl.value = '';
      pinInputEl.disabled = false;
    }
    if (pinErrorEl) {
      pinErrorEl.textContent = '';
    }
    if (pinSubmitEl) {
      pinSubmitEl.disabled = false;
      pinSubmitEl.textContent = 'Submit';
    }

    modalEl.removeAttribute('hidden');
    void modalEl.offsetWidth;
    modalEl.classList.add('is-visible');
    pinInputEl?.focus();
  }

  function closeStaffModal(): void {
    if (!modalEl) return;
    modalEl.classList.remove('is-visible');
    modalEl.setAttribute('hidden', '');
    isStaffModalSuccess = false;
    if (pinInputEl) pinInputEl.value = '';
    if (pinErrorEl) pinErrorEl.textContent = '';
  }

  async function submitPin(): Promise<void> {
    const pin = pinInputEl?.value.trim() ?? '';
    if (!pin) {
      if (pinErrorEl) pinErrorEl.textContent = 'Please enter PIN';
      pinInputEl?.focus();
      return;
    }

    if (pinErrorEl) pinErrorEl.textContent = '';
    if (pinSubmitEl) {
      pinSubmitEl.disabled = true;
      pinSubmitEl.textContent = 'Verifying...';
    }
    if (pinInputEl) pinInputEl.disabled = true;

    try {
      const res = await fetch('/api/admin/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, action: 'disable_ui_blocking' }),
      });

      const data = (await res.json().catch(() => null)) as {
        valid?: boolean;
        disabled?: boolean;
        token?: string;
        error?: string;
      } | null;

      if (!res.ok || !data?.valid) {
        if (pinErrorEl) {
          pinErrorEl.textContent = 'Incorrect PIN';
        }
        if (pinInputEl) {
          pinInputEl.value = '';
          pinInputEl.disabled = false;
          pinInputEl.focus();
        }
        if (pinSubmitEl) {
          pinSubmitEl.disabled = false;
          pinSubmitEl.textContent = 'Submit';
        }
        return;
      }

      // Success
      verifiedPin = pin;
      if (data.token) {
        try {
          sessionStorage.setItem('adminToken', data.token);
          localStorage.setItem('adminToken', data.token);
        } catch {}
      }

      isStaffModalSuccess = true;
      currentSettings.enabled = false;

      if (pinFormViewEl) pinFormViewEl.setAttribute('hidden', '');
      if (pinSuccessViewEl) pinSuccessViewEl.removeAttribute('hidden');
      disableBtnEl?.focus();
    } catch (err) {
      if (pinErrorEl) {
        pinErrorEl.textContent = 'Connection error. Please try again.';
      }
      if (pinInputEl) {
        pinInputEl.disabled = false;
        pinInputEl.focus();
      }
      if (pinSubmitEl) {
        pinSubmitEl.disabled = false;
        pinSubmitEl.textContent = 'Submit';
      }
    }
  }

  async function handleDisableBlockingClick(): Promise<void> {
    if (disableBtnEl) {
      disableBtnEl.disabled = true;
      disableBtnEl.textContent = 'Disabling...';
    }

    try {
      // Ensure backend disabling in case it was not already triggered
      if (verifiedPin) {
        await fetch('/api/admin/verify-pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pin: verifiedPin,
            action: 'disable_ui_blocking',
          }),
        }).catch(() => {});
      }
    } finally {
      currentSettings.enabled = false;
      closeStaffModal();
      hideOverlay();
      if (disableBtnEl) {
        disableBtnEl.disabled = false;
        disableBtnEl.textContent = 'Disable Blocking Mode';
      }
    }
  }

  function handleOpenAdminConsole(): void {
    window.location.href = '/admin/settings';
  }

  // Keypad click listeners
  const keypadButtons = modalEl?.querySelectorAll('.ui-blocking-keypad__btn');
  keypadButtons?.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!pinInputEl || pinInputEl.disabled) return;
      const key = (btn as HTMLElement).getAttribute('data-key');
      if (!key) return;

      if (key === 'clear') {
        pinInputEl.value = '';
        if (pinErrorEl) pinErrorEl.textContent = '';
      } else if (key === 'backspace') {
        pinInputEl.value = pinInputEl.value.slice(0, -1);
      } else if (pinInputEl.value.length < 10) {
        pinInputEl.value += key;
      }
      pinInputEl.focus();
    });
  });

  // Event handlers
  staffBtnEl?.addEventListener('click', (e) => {
    e.preventDefault();
    openStaffModal();
  });

  pinSubmitEl?.addEventListener('click', (e) => {
    e.preventDefault();
    void submitPin();
  });

  pinCancelEl?.addEventListener('click', (e) => {
    e.preventDefault();
    closeStaffModal();
    if (!currentSettings.enabled) {
      hideOverlay();
    }
  });

  pinInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submitPin();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeStaffModal();
    }
  });

  disableBtnEl?.addEventListener('click', (e) => {
    e.preventDefault();
    void handleDisableBlockingClick();
  });

  adminBtnEl?.addEventListener('click', (e) => {
    e.preventDefault();
    handleOpenAdminConsole();
  });

  function handleUiBlockingEvent(state: UiBlockingSettings): void {
    if (!state || typeof state !== 'object') return;
    const isNowEnabled = Boolean(state.enabled);
    currentSettings = {
      enabled: isNowEnabled,
      mode: state.mode || 'maintenance',
      customMessage:
        typeof state.customMessage === 'string' ? state.customMessage : '',
    };

    options.onStateChange?.(currentSettings);

    if (isNowEnabled) {
      renderPresentation();
      cancelActiveCustomerSessions(currentSettings);
      showOverlay();
    } else {
      if (!isStaffModalSuccess) {
        hideOverlay();
      }
    }
  }

  // Socket subscription helper
  let attachedSocket: any = null;
  const attachToSocket = (sock: any) => {
    if (!sock || attachedSocket === sock || typeof sock.on !== 'function')
      return;
    attachedSocket = sock;
    sock.on('uiBlockingChanged', handleUiBlockingEvent);
    sock.on(
      'systemSettingsChanged',
      (payload: { developerMode?: { enabled?: boolean } }) => {
        if (destroyed) return;
        if (payload?.developerMode?.enabled) {
          attachDevModeBanner();
        } else {
          removeDevModeBanner();
        }
      },
    );
  };

  if (options.socket) {
    if (typeof options.socket === 'function') {
      try {
        attachToSocket(options.socket());
      } catch {}
    } else {
      attachToSocket(options.socket);
    }
  }

  if (!attachedSocket && typeof window !== 'undefined') {
    const ioFactory = (window as unknown as { io?: () => any }).io;
    if (typeof ioFactory === 'function') {
      try {
        attachToSocket(ioFactory());
      } catch {}
    }
  }

  // Initial fetch from /api/settings/idle-timeout
  if (typeof fetch === 'function') {
    void fetch('/api/settings/idle-timeout')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{
          uiBlocking?: UiBlockingSettings;
          developerMode?: { enabled?: boolean };
        }>;
      })
      .then((data) => {
        if (!destroyed && data?.uiBlocking) {
          handleUiBlockingEvent(data.uiBlocking);
        }
        if (!destroyed && data?.developerMode?.enabled) {
          attachDevModeBanner();
        }
      })
      .catch((err) => {
        console.warn(
          '[UI BLOCKING] Failed to load initial blocking state:',
          err,
        );
      });
  }

  return {
    getState() {
      return { ...currentSettings };
    },
    isEnabled() {
      return currentSettings.enabled;
    },
    updateState(state: Partial<UiBlockingSettings>) {
      handleUiBlockingEvent({
        ...currentSettings,
        ...state,
      });
    },
    show() {
      currentSettings.enabled = true;
      renderPresentation();
      showOverlay();
    },
    hide() {
      currentSettings.enabled = false;
      hideOverlay();
    },
    destroy() {
      destroyed = true;
      if (attachedSocket && typeof attachedSocket.off === 'function') {
        attachedSocket.off('uiBlockingChanged', handleUiBlockingEvent);
        attachedSocket.off('systemSettingsChanged');
      }
      overlayEl?.remove();
      modalEl?.remove();
      const styleEl =
        typeof document !== 'undefined'
          ? document.getElementById(STYLE_ELEMENT_ID)
          : null;
      styleEl?.remove();
    },
  };
}
