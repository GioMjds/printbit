import {
  buildMaintenanceReceiptView,
  isMaintenancePrintFailure,
} from '../../src/public/confirm/maintenance-receipt';

describe('maintenance receipt presentation', () => {
  test.each([
    'PAPER_TRAY_EMPTY',
    'PAPER_INSUFFICIENT_MID_JOB',
    'PAPER_JAM_PRINT',
    'PRINTER_DOOR_OPEN',
    'PRINTER_HARDWARE_ERROR',
    'WORKER_HARDWARE_ERROR',
    'WORKER_PRINT_FAILED',
  ])('routes %s to staff-assisted resolution', (code) => {
    expect(isMaintenancePrintFailure(code)).toBe(true);
  });

  test('keeps unrelated warnings outside the maintenance resolution flow', () => {
    expect(isMaintenancePrintFailure('PRINTER_LOW_INK')).toBe(false);
  });

  test('exposes the transaction identity and receipt when both are available', () => {
    expect(
      buildMaintenanceReceiptView({
        transactionId: ' tx-verified ',
        receiptUrl: 'https://kiosk.test/receipt/t/token',
        receiptExpiresAt: '2026-08-31T13:30:00.000Z',
      }),
    ).toEqual({
      transactionId: 'tx-verified',
      receipt: {
        url: 'https://kiosk.test/receipt/t/token',
        expiresAt: '2026-08-31T13:30:00.000Z',
      },
    });
  });

  test('keeps the failure visible while the receipt is still being prepared', () => {
    expect(
      buildMaintenanceReceiptView({
        transactionId: 'tx-pending-receipt',
        receiptUrl: null,
        receiptExpiresAt: null,
      }),
    ).toEqual({
      transactionId: 'tx-pending-receipt',
      receipt: null,
    });
  });
});
