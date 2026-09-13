import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handoffToWorker } from '../../src/services/worker-handoff';
import { buildPhysicalPrintSettings } from '../../src/public/confirm/print-settings';

describe('print configuration boundary', () => {
  it.each(['A4', 'Letter', 'Legal'] as const)('hands off explicit Fit and retained %s settings', async (paperSize) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'print-contract-'));
    try {
      const source = path.join(dir, 'source.pdf');
      await fs.writeFile(source, '%PDF-1.4');
      const result = await handoffToWorker({ sourcePath: source, queueDir: dir,
        transactionId: 'tx', spoolerCorrelationKey: 'spool',
        printSettings: { paperSize, orientation: 'landscape', quality: 'high', copies: 3, color: true, rotationDeg: 90 } });
      const sidecar = JSON.parse(await fs.readFile(result.targetPath.replace(/\.pdf$/, '.json'), 'utf8'));
      expect(sidecar).toMatchObject({ scaling: 'fit', paperSize, orientation: 'landscape', quality: 'high', copies: 3, color: true, rotationDeg: 90 });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('keeps automatic Fit in the confirmation request', () => {
    expect(buildPhysicalPrintSettings({ copies: 2, paperSize: 'Legal', orientation: 'landscape', quality: 'high' }, 'colored'))
      .toMatchObject({ scaling: 'fit', copies: 2, paperSize: 'Legal', orientation: 'landscape', quality: 'high', colorMode: 'colored' });
  });
});
