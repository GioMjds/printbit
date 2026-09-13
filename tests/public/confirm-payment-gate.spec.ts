import fs from 'fs';
import path from 'path';

describe('confirm payment gate and scc boundary', () => {
  const confirmAppPath = path.resolve(__dirname, '../../src/public/confirm/app.ts');
  const sccAppPath = path.resolve(__dirname, '../../src/public/scc/app.ts');

  it('uses lease lifecycle endpoints on confirm page', () => {
    const confirmContent = fs.readFileSync(confirmAppPath, 'utf8');

    expect(confirmContent).toContain('/api/payment-session/arm');
    expect(confirmContent).toContain('/api/payment-session/heartbeat');
    expect(confirmContent).toContain('/api/payment-session/cancel');
  });

  it('includes paymentLeaseId in /api/confirm-payment payload', () => {
    const confirmContent = fs.readFileSync(confirmAppPath, 'utf8');

    expect(confirmContent).toContain('paymentLeaseId');
    expect(confirmContent).toMatch(/\/api\/confirm-payment/);
  });

  it('does not emit unlockCoinSlot or lockCoinSlot socket events from confirm page', () => {
    const confirmContent = fs.readFileSync(confirmAppPath, 'utf8');

    expect(confirmContent).not.toMatch(/emit\(\s*['"]unlockCoinSlot['"]/);
    expect(confirmContent).not.toMatch(/emit\(\s*['"]lockCoinSlot['"]/);
  });

  it('preserves /api/balance/add-test-coin in scc app', () => {
    const sccContent = fs.readFileSync(sccAppPath, 'utf8');

    expect(sccContent).toContain('/api/balance/add-test-coin');
  });
});
