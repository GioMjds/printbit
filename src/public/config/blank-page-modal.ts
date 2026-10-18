import { formatPageRangeString, type PageRange } from '../shared/page-selection';

export interface BlankPageModalOptions {
  dialog: HTMLDialogElement;
  onExclude: (nonBlankRanges: PageRange[]) => Promise<void>;
  onKeep: () => void;
  onPreviewPage?: (page: number) => void;
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

export class BlankPageWarningModal {
  private dialog: HTMLDialogElement;
  private onExclude: (nonBlankRanges: PageRange[]) => Promise<void>;
  private onKeep: () => void;
  private onPreviewPage?: (page: number) => void;

  private pagesListEl: HTMLElement | null;
  private closeBtn: HTMLElement | null;
  private excludeBtn: HTMLButtonElement | null;
  private keepBtn: HTMLElement | null;
  private adjustBtn: HTMLElement | null;

  private currentBlankPages: number[] = [];
  private currentSelectedPages: number[] = [];
  private isProcessing = false;

  constructor(options: BlankPageModalOptions) {
    this.dialog = options.dialog;
    this.onExclude = options.onExclude;
    this.onKeep = options.onKeep;
    this.onPreviewPage = options.onPreviewPage;

    this.pagesListEl = this.dialog.querySelector('#blankWarningPagesList');
    this.closeBtn = this.dialog.querySelector('#blankWarningCloseBtn');
    this.excludeBtn = this.dialog.querySelector('#blankWarningExcludeBtn');
    this.keepBtn = this.dialog.querySelector('#blankWarningKeepBtn');
    this.adjustBtn = this.dialog.querySelector('#blankWarningAdjustBtn');

    this.closeBtn?.addEventListener('click', () => this.close());
    this.adjustBtn?.addEventListener('click', () => this.close());

    this.keepBtn?.addEventListener('click', () => {
      this.close();
      this.onKeep();
    });

    this.excludeBtn?.addEventListener('click', async () => {
      if (this.isProcessing) return;
      const nonBlankRanges = computeNonBlankRanges(
        this.currentSelectedPages,
        this.currentBlankPages,
      );
      if (nonBlankRanges.length === 0) {
        this.close();
        return;
      }

      this.isProcessing = true;
      this.setButtonLoading(true);
      try {
        await this.onExclude(nonBlankRanges);
        this.close();
      } finally {
        this.isProcessing = false;
        this.setButtonLoading(false);
      }
    });

    // Native backdrop click dismissal
    this.dialog.addEventListener('click', (e) => {
      const rect = this.dialog.getBoundingClientRect();
      const isInDialog =
        rect.top <= e.clientY &&
        e.clientY <= rect.top + rect.height &&
        rect.left <= e.clientX &&
        e.clientX <= rect.left + rect.width;
      if (!isInDialog || e.target === this.dialog) {
        this.close();
      }
    });
  }

  public open(selectedPages: number[], blankPages: number[]): void {
    if (blankPages.length === 0) return;
    this.currentSelectedPages = [...selectedPages];
    this.currentBlankPages = [...blankPages];
    this.render();

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
  }

  public close(): void {
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
        this.close();
        this.onPreviewPage?.(page);
      });
      this.pagesListEl.appendChild(pill);
    }
  }

  private setButtonLoading(loading: boolean): void {
    if (!this.excludeBtn) return;
    this.excludeBtn.disabled = loading;
    const textSpan = this.excludeBtn.querySelector('span');
    if (textSpan) {
      textSpan.textContent = loading
        ? 'Excluding & recalculating…'
        : 'Exclude Blank Pages & Continue';
    }
  }
}
