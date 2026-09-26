import {
  type PageRange,
  type NormalizedPageSelectionResult,
  normalizePageSelection,
} from '../shared/page-selection';

export interface CustomRangeRow {
  id: string;
  start: number;
  end: number;
}

export interface CustomRangeBuilderOptions {
  container: HTMLElement;
  addButton: HTMLButtonElement;
  feedbackCard: HTMLElement;
  hiddenInput: HTMLInputElement;
  getMaxPages: () => number;
  onPagePreviewJump: (page: number) => void;
  onChange: (result: NormalizedPageSelectionResult) => void;
}

export class CustomRangeBuilder {
  private rows: CustomRangeRow[] = [];
  private options: CustomRangeBuilderOptions;
  private idCounter = 0;

  constructor(options: CustomRangeBuilderOptions) {
    this.options = options;
    this.init();
  }

  private init(): void {
    this.options.addButton.addEventListener('click', () => {
      this.addNewRow();
    });

    // Seed with 1 initial row
    this.reset();
  }

  public reset(): void {
    const max = this.options.getMaxPages();
    this.rows = [{ id: this.nextId(), start: 1, end: max }];
    this.render();
    this.notifyChange();
  }

  public setMaxPages(max: number): void {
    for (const row of this.rows) {
      row.start = Math.max(1, Math.min(max, row.start));
      row.end = Math.max(1, Math.min(max, row.end));
      if (row.start > row.end) row.end = row.start;
    }
    this.render();
    this.notifyChange();
  }

  public getSelection(): NormalizedPageSelectionResult {
    const max = this.options.getMaxPages();
    const ranges: PageRange[] = this.rows.map((r) => ({
      start: r.start,
      end: r.end,
    }));
    return normalizePageSelection({ mode: 'custom', ranges }, max);
  }

  public setFromRanges(ranges: PageRange[]): void {
    const max = this.options.getMaxPages();
    if (ranges.length === 0) {
      this.reset();
      return;
    }

    this.rows = ranges.map((r) => ({
      id: this.nextId(),
      start: Math.max(1, Math.min(max, r.start)),
      end: Math.max(1, Math.min(max, r.end)),
    }));
    this.render();
    this.notifyChange();
  }

  private nextId(): string {
    this.idCounter += 1;
    return `range_row_${this.idCounter}`;
  }

  private addNewRow(): void {
    const max = this.options.getMaxPages();
    let nextStart = 1;
    if (this.rows.length > 0) {
      const highestEnd = Math.max(...this.rows.map((r) => r.end));
      nextStart = Math.min(max, highestEnd + 1);
    }
    const nextEnd = Math.min(max, nextStart);

    this.rows.push({
      id: this.nextId(),
      start: nextStart,
      end: nextEnd,
    });

    this.render();
    this.options.onPagePreviewJump(nextStart);
    this.notifyChange();
  }

  private removeRow(id: string): void {
    if (this.rows.length <= 1) return;
    this.rows = this.rows.filter((r) => r.id !== id);
    this.render();
    this.notifyChange();
  }

  private updateRow(
    id: string,
    target: 'start' | 'end',
    delta: number,
  ): void {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;

    const max = this.options.getMaxPages();
    if (target === 'start') {
      row.start = Math.max(1, Math.min(max, row.start + delta));
      if (row.start > row.end) {
        row.end = row.start;
      }
      this.options.onPagePreviewJump(row.start);
    } else {
      row.end = Math.max(1, Math.min(max, row.end + delta));
      if (row.end < row.start) {
        row.start = row.end;
      }
      this.options.onPagePreviewJump(row.end);
    }

    this.render();
    this.notifyChange();
  }

  private render(): void {
    const container = this.options.container;
    container.innerHTML = '';
    const max = this.options.getMaxPages();
    const canDelete = this.rows.length > 1;

    this.rows.forEach((row, index) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'custom-range-row';
      rowEl.dataset.rowId = row.id;

      rowEl.innerHTML = `
        <span class="custom-range-row__label">Range ${index + 1}</span>
        <div class="custom-range-row__controls">
          <div class="copies-control">
            <button type="button" class="copies-btn dec-start" aria-label="Decrease range ${index + 1} start page" ${row.start <= 1 ? 'disabled' : ''}>-</button>
            <input type="number" class="copies-input start-input" min="1" max="${max}" value="${row.start}" readonly tabindex="-1" aria-label="Range ${index + 1} start page" />
            <button type="button" class="copies-btn inc-start" aria-label="Increase range ${index + 1} start page" ${row.start >= max ? 'disabled' : ''}>+</button>
          </div>
          <span class="custom-range-row__sep">to</span>
          <div class="copies-control">
            <button type="button" class="copies-btn dec-end" aria-label="Decrease range ${index + 1} end page" ${row.end <= 1 ? 'disabled' : ''}>-</button>
            <input type="number" class="copies-input end-input" min="1" max="${max}" value="${row.end}" readonly tabindex="-1" aria-label="Range ${index + 1} end page" />
            <button type="button" class="copies-btn inc-end" aria-label="Increase range ${index + 1} end page" ${row.end >= max ? 'disabled' : ''}>+</button>
          </div>
          ${
            canDelete
              ? `<button type="button" class="custom-range-row__delete" aria-label="Delete range ${index + 1}">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                  </svg>
                </button>`
              : '<div class="custom-range-row__delete-spacer"></div>'
          }
        </div>
      `;

      rowEl.querySelector('.dec-start')?.addEventListener('click', () => {
        this.updateRow(row.id, 'start', -1);
      });
      rowEl.querySelector('.inc-start')?.addEventListener('click', () => {
        this.updateRow(row.id, 'start', 1);
      });
      rowEl.querySelector('.dec-end')?.addEventListener('click', () => {
        this.updateRow(row.id, 'end', -1);
      });
      rowEl.querySelector('.inc-end')?.addEventListener('click', () => {
        this.updateRow(row.id, 'end', 1);
      });
      rowEl.querySelector('.custom-range-row__delete')?.addEventListener('click', () => {
        this.removeRow(row.id);
      });

      container.appendChild(rowEl);
    });
  }

  private notifyChange(): void {
    const result = this.getSelection();

    // Update hidden input for pattern validation
    this.options.hiddenInput.value = result.canonicalString;
    this.options.hiddenInput.setCustomValidity('');

    // Update feedback card
    this.renderFeedbackCard(result);

    this.options.onChange(result);
  }

  private renderFeedbackCard(result: NormalizedPageSelectionResult): void {
    const max = this.options.getMaxPages();
    const card = this.options.feedbackCard;

    if (result.totalSelectedPages === 0) {
      card.innerHTML = `
        <div class="range-feedback range-feedback--error">
          <span>❌ No pages selected. Please select at least 1 page.</span>
        </div>
      `;
      return;
    }

    const overlapNotice = result.hasOverlapsMerged
      ? `<div class="range-feedback__merged">⚡ Overlapping ranges merged into: <strong>${result.canonicalString}</strong></div>`
      : '';

    card.innerHTML = `
      <div class="range-feedback range-feedback--valid">
        <div class="range-feedback__summary">
          <span class="range-feedback__badge">✓ ${result.totalSelectedPages} of ${max} pages</span>
          <span class="range-feedback__selection">${result.canonicalString}</span>
        </div>
        ${overlapNotice}
      </div>
    `;
  }
}
