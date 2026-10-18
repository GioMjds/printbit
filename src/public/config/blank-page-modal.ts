import type { PageRange } from '../shared/page-selection';
import type { DotLottie } from '@lottiefiles/dotlottie-web';

export interface BlankPageModalOptions {
  dialog: HTMLDialogElement;
  onExclude: (nonBlankRanges: PageRange[]) => Promise<void>;
  onKeep: () => void;
  onPreviewPage?: (page: number) => void;
  /**
   * Taps are ignored for this long after the modal opens. Swallows the
   * trailing/ghost touch from whatever tap opened it, and kiosk screen noise.
   */
  armDelayMs?: number;
  /** Backdrop taps are ignored by default: a ghost touch must not dismiss a billing warning. */
  dismissOnBackdrop?: boolean;
  /** Served locally – the kiosk has no internet. */
  lottieSrc?: string;
  wasmUrl?: string;
}

/**
 * Computes consecutive non-blank page ranges from the selected pages and blank pages.
 */
export function computeNonBlankRanges(
  selectedPages: number[],
  blankPages: number[],
): PageRange[] {
  const blankSet = new Set(blankPages);
  const nonBlankPages = selectedPages
    .filter((p) => !blankSet.has(p))
    .sort((a, b) => a - b);

  if (nonBlankPages.length === 0) return [];

  const ranges: PageRange[] = [];
  let start = nonBlankPages[0];
  let end = nonBlankPages[0];

  for (let i = 1; i < nonBlankPages.length; i++) {
    const p = nonBlankPages[i];
    if (p === end + 1) {
      end = p;
    } else {
      ranges.push({ start, end });
      start = p;
      end = p;
    }
  }
  ranges.push({ start, end });
  return ranges;
}

const DEFAULT_ARM_DELAY_MS = 400;
const DEFAULT_LOTTIE_SRC = '/assets/lottie/blank-warning.lottie';
const DEFAULT_WASM_URL = '/vendor/dotlottie/dotlottie-player.wasm';

export class BlankPageWarningModal {
  private dialog: HTMLDialogElement;
  private onExclude: (nonBlankRanges: PageRange[]) => Promise<void>;
  private onKeep: () => void;
  private onPreviewPage?: (page: number) => void;
  private armDelayMs: number;
  private dismissOnBackdrop: boolean;
  private lottieSrc: string;
  private wasmUrl: string;

  private pagesListEl: HTMLElement | null;
  private closeBtn: HTMLElement | null;
  private excludeBtn: HTMLButtonElement | null;
  private keepBtn: HTMLButtonElement | null;
  private adjustBtn: HTMLButtonElement | null;
  private lottieWrap: HTMLElement | null;
  private lottieCanvas: HTMLCanvasElement | null;

  private currentBlankPages: number[] = [];
  private currentSelectedPages: number[] = [];
  private isProcessing = false;
  private armTimer: number | undefined;
  private lottie: DotLottie | null = null;
  private reducedMotion: boolean;

  constructor(options: BlankPageModalOptions) {
    this.dialog = options.dialog;
    this.onExclude = options.onExclude;
    this.onKeep = options.onKeep;
    this.onPreviewPage = options.onPreviewPage;
    const isTest =
      typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';
    this.armDelayMs = options.armDelayMs ?? (isTest ? 0 : DEFAULT_ARM_DELAY_MS);
    this.dismissOnBackdrop = options.dismissOnBackdrop ?? false;
    this.lottieSrc = options.lottieSrc ?? DEFAULT_LOTTIE_SRC;
    this.wasmUrl = options.wasmUrl ?? DEFAULT_WASM_URL;
    this.reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.pagesListEl = this.dialog.querySelector('#blankWarningPagesList');
    this.closeBtn = this.dialog.querySelector('#blankWarningCloseBtn');
    this.excludeBtn = this.dialog.querySelector('#blankWarningExcludeBtn');
    this.keepBtn = this.dialog.querySelector('#blankWarningKeepBtn');
    this.adjustBtn = this.dialog.querySelector('#blankWarningAdjustBtn');
    this.lottieWrap = this.dialog.querySelector('#blankWarningLottieWrap');
    this.lottieCanvas = this.dialog.querySelector('#blankWarningLottie');

    this.closeBtn?.addEventListener('click', () => {
      if (!this.canInteract()) return;
      this.close();
    });
    this.adjustBtn?.addEventListener('click', () => {
      if (!this.canInteract()) return;
      this.close();
    });

    this.keepBtn?.addEventListener('click', () => {
      if (!this.canInteract()) return;
      this.close();
      this.onKeep();
    });

    this.excludeBtn?.addEventListener('click', async () => {
      if (!this.canInteract()) return;
      const nonBlankRanges = computeNonBlankRanges(
        this.currentSelectedPages,
        this.currentBlankPages,
      );
      if (nonBlankRanges.length === 0) {
        this.close();
        return;
      }

      this.isProcessing = true;
      this.setBusy(true);
      try {
        await this.onExclude(nonBlankRanges);
        this.close();
      } finally {
        this.isProcessing = false;
        this.setBusy(false);
      }
    });

    this.dialog.addEventListener('click', (e) => {
      if (e.target !== this.dialog) return; // only the backdrop targets the <dialog> itself
      if (!this.dismissOnBackdrop || !this.canInteract()) return;
      this.close();
    });

    // Block the native Esc/cancel while work is in flight.
    this.dialog.addEventListener('cancel', (e) => {
      if (this.isProcessing || !this.isArmed()) e.preventDefault();
    });

    // Warm up the animation off the critical path so the first open is instant.
    window.setTimeout(() => void this.initLottie(), 0);
  }

  public open(selectedPages: number[], blankPages: number[]): void {
    if (blankPages.length === 0) return;
    this.currentSelectedPages = [...selectedPages];
    this.currentBlankPages = [...blankPages];
    this.render();
    this.disarm();

    if (typeof this.dialog.showModal === 'function') {
      try {
        if (!this.dialog.open) {
          this.dialog.showModal();
        }
      } catch {
        this.dialog.setAttribute('open', '');
      }
    } else {
      this.dialog.setAttribute('open', '');
    }

    this.armTimer = window.setTimeout(() => this.arm(), this.armDelayMs);
    if (!this.reducedMotion) void this.lottie?.play();
  }

  public close(): void {
    window.clearTimeout(this.armTimer);
    void this.lottie?.pause();

    if (typeof this.dialog.close === 'function') {
      try {
        if (this.dialog.open) {
          this.dialog.close();
        }
      } catch {
        this.dialog.removeAttribute('open');
      }
    } else {
      this.dialog.removeAttribute('open');
    }
  }

  public isVisible(): boolean {
    return Boolean(this.dialog.open || this.dialog.hasAttribute('open'));
  }

  // ── Ghost-touch guard ─────────────────────────────────────

  private arm(): void {
    this.dialog.dataset.armed = 'true';
  }

  private disarm(): void {
    window.clearTimeout(this.armTimer);
    this.dialog.dataset.armed = 'false';
  }

  private isArmed(): boolean {
    return this.dialog.dataset.armed === 'true';
  }

  /** A tap counts only after the arm delay and never while a request is running. */
  private canInteract(): boolean {
    return this.isArmed() && !this.isProcessing;
  }

  // ── Rendering ─────────────────────────────────────────────

  private render(): void {
    if (!this.pagesListEl) return;
    this.pagesListEl.innerHTML = '';

    for (const page of this.currentBlankPages) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'blank-warning-page-pill';
      pill.innerHTML = `<span>Page ${page}</span><span class="pill-preview-hint">(view)</span>`;
      pill.title = `Jump to page ${page} in preview`;
      pill.addEventListener('click', () => {
        if (!this.canInteract()) return;
        this.close();
        this.onPreviewPage?.(page);
      });
      this.pagesListEl.appendChild(pill);
    }
  }

  /** Locks every action (not just Exclude) so a second tap can't fire mid-request. */
  private setBusy(busy: boolean): void {
    this.dialog.toggleAttribute('aria-busy', busy);
    for (const btn of [
      this.excludeBtn,
      this.keepBtn,
      this.adjustBtn,
    ] as Array<HTMLButtonElement | null>) {
      if (btn) btn.disabled = busy;
    }
    if (this.closeBtn instanceof HTMLButtonElement) {
      this.closeBtn.disabled = busy;
    }
    this.excludeBtn?.classList.toggle('is-loading', busy);

    const textSpan = this.excludeBtn?.querySelector('span');
    if (textSpan) {
      textSpan.textContent = busy
        ? 'Excluding & recalculating…'
        : 'Exclude Blank Pages & Continue';
    }
  }

  // ── Lottie (lazy, self-hosted, optional) ──────────────────

  private async initLottie(): Promise<void> {
    if (this.lottie || !this.lottieCanvas || !this.lottieWrap) return;
    try {
      const { DotLottie } = await import('@lottiefiles/dotlottie-web');
      DotLottie.setWasmUrl(this.wasmUrl);

      const player = new DotLottie({
        canvas: this.lottieCanvas,
        src: this.lottieSrc,
        loop: true,
        autoplay: false, // started in open(), paused in close()
        renderConfig: {
          autoResize: true,
          devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        },
      });

      player.addEventListener('load', () => {
        if (this.lottieWrap) this.lottieWrap.dataset.state = 'ready';
        if (this.isVisible() && !this.reducedMotion) void player.play();
      });
      player.addEventListener('loadError', () => {
        if (this.lottieWrap) this.lottieWrap.dataset.state = 'fallback';
      });

      this.lottie = player;
    } catch {
      // Library/WASM missing: the static SVG icon stays visible.
      if (this.lottieWrap) this.lottieWrap.dataset.state = 'fallback';
    }
  }
}
