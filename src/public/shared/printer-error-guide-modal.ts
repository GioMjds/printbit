import {
  PRINTER_ERROR_CATALOG,
  type PrinterErrorCode,
} from '@/shared/printer-error-catalog';
import type { ActivePrinterErrorState } from '@/services/printer-error-state';

export interface ErrorGuideModalOptions {
  container: HTMLElement;
  getLanguage?: () => 'en' | 'fil';
}

export class PrinterErrorGuideModalController {
  private overlay: HTMLElement;
  private card: HTMLElement;
  private visible = false;

  constructor(private readonly options: ErrorGuideModalOptions) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'printer-error-guide-overlay';
    this.overlay.setAttribute('role', 'alertdialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('hidden', '');

    this.card = document.createElement('div');
    this.card.className = 'printer-error-guide-card';
    this.overlay.appendChild(this.card);

    options.container.appendChild(this.overlay);
  }

  public render(errorState: ActivePrinterErrorState): void {
    const lang = this.options.getLanguage ? this.options.getLanguage() : 'en';
    const def =
      PRINTER_ERROR_CATALOG[errorState.code as PrinterErrorCode] ??
      PRINTER_ERROR_CATALOG.E_UNKNOWN;

    const titleText = def.title[lang];
    const whatText = def.what[lang];
    const actionText = def.action[lang];

    let screenPrompt = '';
    if (errorState.lookAtPrinterScreen) {
      const screenNote =
        lang === 'fil'
          ? 'Tingnan ang screen ng printer.'
          : 'Look at the printer screen.';
      const normalizedAction = actionText.toLowerCase();
      const normalizedScreenNote = screenNote.toLowerCase().replace('.', '');
      if (!normalizedAction.includes(normalizedScreenNote)) {
        screenPrompt = `<p class="printer-error-guide-screen">${screenNote}</p>`;
      }
    }

    const cancelWarning =
      lang === 'fil'
        ? 'Huwag pindutin ang Cancel sa printer.'
        : 'Do not press Cancel on the printer.';

    const jobBadge = errorState.jobId
      ? `<span class="printer-error-guide-badge printer-error-guide-badge--ref">${errorState.jobId}</span>`
      : '';

    this.card.innerHTML = `
      <div class="printer-error-guide-header">
        <div class="printer-error-guide-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h2 class="printer-error-guide-title">${titleText}</h2>
      </div>

      <div class="printer-error-guide-body">
        <p class="printer-error-guide-what">${whatText}</p>
        <p class="printer-error-guide-action">${actionText}</p>
        ${screenPrompt}
      </div>

      <div class="printer-error-guide-footer">
        <p class="printer-error-guide-warning">${cancelWarning}</p>
        <div class="printer-error-guide-tags">
          <span class="printer-error-guide-badge printer-error-guide-badge--code">${errorState.code}</span>
          ${jobBadge}
        </div>
      </div>
    `;

    this.overlay.removeAttribute('hidden');
    this.visible = true;
  }

  public clear(): void {
    this.overlay.setAttribute('hidden', '');
    this.visible = false;
  }

  public isVisible(): boolean {
    return this.visible;
  }
}
