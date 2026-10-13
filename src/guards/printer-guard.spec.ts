/**
 * @jest-environment jsdom
 */
import {
  initPrinterGuard,
  destroyPrinterGuard,
  isPrinterBlocked,
  getPrinterErrorGuideModal,
} from './printer-guard';

describe('printer-guard', () => {
  let mockSocket: any;
  let socketHandlers: Record<string, Function>;

  beforeEach(() => {
    socketHandlers = {};
    mockSocket = {
      on: jest.fn((event: string, handler: Function) => {
        socketHandlers[event] = handler;
      }),
      off: jest.fn((event: string, handler?: Function) => {
        delete socketHandlers[event];
      }),
    };

    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url === '/api/printer/active-error') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            activeError: {
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
            },
            outOfService: false,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          ready: true,
          blocked: false,
          status: 'ready',
          printerName: 'Epson',
          lastCheckedAt: '',
        }),
      });
    });
  });

  afterEach(() => {
    destroyPrinterGuard();
    document.body.innerHTML = '';
    window.localStorage.clear();
    jest.restoreAllMocks();
  });

  it('fetches /api/printer/active-error and mounts error guide modal on load', async () => {
    await initPrinterGuard(mockSocket);
    expect(global.fetch).toHaveBeenCalledWith('/api/printer/active-error');
    expect(mockSocket.on).toHaveBeenCalledWith(
      'printer:error-guide-update',
      expect.any(Function),
    );

    const titleEl = document.querySelector('.printer-error-guide-title');
    expect(titleEl?.textContent).toContain('Printer Cover Open');
    expect(isPrinterBlocked()).toBe(true);
  });

  it('updates modal on printer:error-guide-update socket event', async () => {
    await initPrinterGuard(mockSocket);

    // Socket clears error
    socketHandlers['printer:error-guide-update']({ activeError: null });
    const overlay = document.querySelector('.printer-error-guide-overlay');
    expect(overlay?.hasAttribute('hidden')).toBe(true);

    // Socket reports new error
    socketHandlers['printer:error-guide-update']({
      activeError: {
        code: 'E_OUTPUT_TRAY',
        tier: 'Customer',
        autoClear: true,
        locksCoinSlot: true,
        lookAtPrinterScreen: true,
        jobId: 'PB-1234',
        jobRequiresStaff: false,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        occurrences: 1,
        status: 'active',
      },
    });

    expect(overlay?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('.printer-error-guide-title')?.textContent).toContain('Output Tray');
    expect(document.querySelector('.printer-error-guide-badge--ref')?.textContent).toBe('PB-1234');
    expect(isPrinterBlocked()).toBe(true);
  });

  it('displays mid-job reference badge when jobRequiresStaff is true', async () => {
    await initPrinterGuard(mockSocket);

    socketHandlers['printer:error-guide-update']({
      activeError: {
        code: 'E_NO_PAPER',
        tier: 'Staff',
        autoClear: false,
        locksCoinSlot: true,
        lookAtPrinterScreen: false,
        jobId: 'PB-8888',
        jobRequiresStaff: true,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        occurrences: 1,
        status: 'active',
      },
    });

    const badge = document.querySelector('.printer-error-guide-badge--ref');
    expect(badge?.textContent).toBe('PB-8888');
    expect(document.querySelector('.printer-error-guide-title')?.textContent).toContain('Paper');
  });

  it('renders Filipino copy when language is set to fil in localStorage', async () => {
    window.localStorage.setItem('printbit.kiosk.language', 'fil');
    await initPrinterGuard(mockSocket);

    const titleEl = document.querySelector('.printer-error-guide-title');
    expect(titleEl?.textContent).toContain('Bukas ang Takip ng Printer');
  });

  it('filters out non-fatal errors in kiosk_wide_only mode, but shows fatal errors', async () => {
    // In kiosk_wide_only mode, on-load E_COVER_OPEN is filtered out
    await initPrinterGuard(mockSocket, { mode: 'kiosk_wide_only' });
    const overlay = document.querySelector('.printer-error-guide-overlay');
    expect(overlay?.hasAttribute('hidden')).toBe(true);

    // Socket sending E_OUTPUT_TRAY is also filtered out
    socketHandlers['printer:error-guide-update']({
      activeError: {
        code: 'E_OUTPUT_TRAY',
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
      },
    });
    expect(overlay?.hasAttribute('hidden')).toBe(true);

    // Socket sending E_INK_OUT is rendered
    socketHandlers['printer:error-guide-update']({
      activeError: {
        code: 'E_INK_OUT',
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
      },
    });
    expect(overlay?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('.printer-error-guide-title')?.textContent).toContain('Ink Tank Empty');
  });

  it('cleans up socket listeners and removes modal on destroyPrinterGuard', async () => {
    await initPrinterGuard(mockSocket);
    expect(mockSocket.on).toHaveBeenCalledWith('printer:error-guide-update', expect.any(Function));
    expect(getPrinterErrorGuideModal()).not.toBeNull();

    destroyPrinterGuard();
    expect(mockSocket.off).toHaveBeenCalledWith('printer:error-guide-update', expect.any(Function));
    const overlay = document.querySelector('.printer-error-guide-overlay');
    expect(overlay).toBeNull();
    expect(getPrinterErrorGuideModal()).toBeNull();
  });
});
