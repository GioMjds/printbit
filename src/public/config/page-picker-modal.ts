/**
 * Page Picker Touch Modal
 * Provides a kiosk-optimized touch grid for direct jumping to any page in the preview.
 * Supports chunked tabs for documents > 30 pages to prevent visual clutter.
 */

export interface PagePickerOptions {
  dialog: HTMLDialogElement;
  onSelectPage: (page: number) => void;
}

export class PagePickerModal {
  private dialog: HTMLDialogElement;
  private onSelectPage: (page: number) => void;
  private badgeEl: HTMLElement | null;
  private tabsEl: HTMLElement | null;
  private gridEl: HTMLElement | null;
  private closeBtn: HTMLElement | null;
  private doneBtn: HTMLElement | null;

  private currentPage = 1;
  private totalPages = 1;
  private activeChunkIndex = 0;
  private readonly CHUNK_SIZE = 30;

  constructor(options: PagePickerOptions) {
    this.dialog = options.dialog;
    this.onSelectPage = options.onSelectPage;

    this.badgeEl = this.dialog.querySelector('#pagePickerCurrentBadge');
    this.tabsEl = this.dialog.querySelector('#pagePickerTabs');
    this.gridEl = this.dialog.querySelector('#pagePickerGrid');
    this.closeBtn = this.dialog.querySelector('#pagePickerCloseBtn');
    this.doneBtn = this.dialog.querySelector('#pagePickerCancelBtn');

    this.closeBtn?.addEventListener('click', () => this.close());
    this.doneBtn?.addEventListener('click', () => this.close());

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

  open(currentPage: number, totalPages: number): void {
    if (totalPages <= 1) return;
    this.currentPage = Math.max(1, Math.min(totalPages, currentPage));
    this.totalPages = Math.max(1, totalPages);
    this.activeChunkIndex = Math.floor((this.currentPage - 1) / this.CHUNK_SIZE);

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

  close(): void {
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

  private render(): void {
    if (this.badgeEl) {
      this.badgeEl.textContent = `Page ${this.currentPage} of ${this.totalPages}`;
    }

    this.renderTabs();
    this.renderGrid();
  }

  private renderTabs(): void {
    if (!this.tabsEl) return;
    if (this.totalPages <= this.CHUNK_SIZE) {
      this.tabsEl.style.display = 'none';
      this.tabsEl.innerHTML = '';
      return;
    }

    this.tabsEl.style.display = 'flex';
    this.tabsEl.innerHTML = '';
    const numChunks = Math.ceil(this.totalPages / this.CHUNK_SIZE);

    for (let i = 0; i < numChunks; i++) {
      const start = i * this.CHUNK_SIZE + 1;
      const end = Math.min((i + 1) * this.CHUNK_SIZE, this.totalPages);
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = `page-picker-tab${i === this.activeChunkIndex ? ' page-picker-tab--active' : ''}`;
      tabBtn.textContent = `${start} – ${end}`;
      tabBtn.setAttribute('aria-pressed', i === this.activeChunkIndex ? 'true' : 'false');
      tabBtn.addEventListener('click', () => {
        this.activeChunkIndex = i;
        this.render();
      });
      this.tabsEl.appendChild(tabBtn);
    }
  }

  private renderGrid(): void {
    if (!this.gridEl) return;
    this.gridEl.innerHTML = '';

    const start = this.activeChunkIndex * this.CHUNK_SIZE + 1;
    const end = Math.min((this.activeChunkIndex + 1) * this.CHUNK_SIZE, this.totalPages);

    for (let p = start; p <= end; p++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `page-picker-btn${p === this.currentPage ? ' page-picker-btn--active' : ''}`;
      btn.textContent = String(p);
      btn.setAttribute('aria-label', `Page ${p}`);
      if (p === this.currentPage) {
        btn.setAttribute('aria-current', 'page');
      }

      btn.addEventListener('click', () => {
        this.onSelectPage(p);
        this.close();
      });

      this.gridEl.appendChild(btn);
    }
  }
}
