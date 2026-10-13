/**
 * @jest-environment jsdom
 */
import { PrinterErrorGuideModalController } from './printer-error-guide-modal';
import type { ActivePrinterErrorState } from '@/services/printer-error-state';

describe('PrinterErrorGuideModalController', () => {
  let container: HTMLElement;
  let controller: PrinterErrorGuideModalController;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    controller = new PrinterErrorGuideModalController({
      container,
      getLanguage: () => 'en',
    });
  });

  afterEach(() => {
    container.remove();
  });

  it('initializes in hidden state', () => {
    expect(controller.isVisible()).toBe(false);
    const overlay = container.querySelector('.printer-error-guide-overlay');
    expect(overlay?.hasAttribute('hidden')).toBe(true);
    expect(overlay?.getAttribute('role')).toBe('alertdialog');
    expect(overlay?.getAttribute('aria-labelledby')).toBe(
      'printer-error-guide-title',
    );
  });

  it('escapes dynamic markup to prevent XSS injection', () => {
    controller.render({
      code: '<script>alert(1)</script>' as unknown as import('@/shared/printer-error-catalog').PrinterErrorCode,
      tier: 'Customer',
      autoClear: true,
      locksCoinSlot: true,
      lookAtPrinterScreen: false,
      jobId: 'PB-<xss>',
      jobRequiresStaff: false,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      occurrences: 1,
      status: 'active',
    });

    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(container.innerHTML).toContain('PB-&lt;xss&gt;');
  });

  it('renders required 3-part message and fixed footer without any buttons', () => {
    const errorState: ActivePrinterErrorState = {
      code: 'E_COVER_OPEN',
      tier: 'Customer',
      autoClear: true,
      locksCoinSlot: true,
      lookAtPrinterScreen: true,
      jobId: 'PB-9876',
      jobRequiresStaff: false,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      occurrences: 1,
      status: 'active',
    };

    controller.render(errorState);

    expect(controller.isVisible()).toBe(true);

    // No buttons allowed
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(0);

    // Title & messages present
    expect(container.textContent).toContain('Printer Cover Open');
    expect(container.textContent).toContain('The printer cover is open.');
    expect(container.textContent).toContain('Please close the cover');

    // Look at printer screen prompt present for customer tier
    expect(container.textContent).toContain('Look at the printer screen');

    // Fixed footer elements
    expect(container.textContent).toContain(
      'Do not press Cancel on the printer',
    );
    expect(container.textContent).toContain('E_COVER_OPEN');
    expect(container.textContent).toContain('PB-9876');
  });

  it('renders Filipino copy when language is fil', () => {
    const filController = new PrinterErrorGuideModalController({
      container,
      getLanguage: () => 'fil',
    });

    filController.render({
      code: 'E_NO_PAPER',
      tier: 'Staff',
      autoClear: false,
      locksCoinSlot: true,
      lookAtPrinterScreen: false,
      jobId: null,
      jobRequiresStaff: false,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      occurrences: 1,
      status: 'active',
    });

    expect(container.textContent).toContain('Naubos na ang papel ng printer');
    expect(container.textContent).toContain('Pakitawag ang staff');
    expect(container.textContent).toContain('Huwag pindutin ang Cancel sa printer');
    // Does not render screen note when lookAtPrinterScreen is false
    expect(container.textContent).not.toContain('Tingnan ang screen ng printer');
    // Does not render job badge when jobId is null
    expect(container.querySelector('.printer-error-guide-badge--ref')).toBeNull();
  });

  it('renders Filipino screen prompt when lookAtPrinterScreen is true', () => {
    const filController = new PrinterErrorGuideModalController({
      container,
      getLanguage: () => 'fil',
    });

    filController.render({
      code: 'E_COVER_OPEN',
      tier: 'Customer',
      autoClear: true,
      locksCoinSlot: true,
      lookAtPrinterScreen: true,
      jobId: 'PB-5555',
      jobRequiresStaff: false,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      occurrences: 1,
      status: 'active',
    });

    expect(container.textContent).toContain('Tingnan ang screen ng printer');
    expect(container.textContent).toContain('PB-5555');
  });

  it('falls back to E_UNKNOWN for unmapped error codes', () => {
    controller.render({
      code: 'E_NON_EXISTENT' as unknown as import('@/shared/printer-error-catalog').PrinterErrorCode,
      tier: 'Staff',
      autoClear: false,
      locksCoinSlot: true,
      lookAtPrinterScreen: true,
      jobId: null,
      jobRequiresStaff: false,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      occurrences: 1,
      status: 'active',
    });

    expect(container.textContent).toContain('Printer Attention Needed');
    expect(container.textContent).toContain('Look at the printer screen and call staff.');
  });

  it('hides modal when clear is called', () => {
    controller.render({
      code: 'E_COVER_OPEN',
      tier: 'Customer',
      autoClear: true,
      locksCoinSlot: true,
      lookAtPrinterScreen: true,
      jobId: null,
      jobRequiresStaff: false,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      occurrences: 1,
      status: 'active',
    });
    expect(controller.isVisible()).toBe(true);

    controller.clear();
    expect(controller.isVisible()).toBe(false);
  });
});
