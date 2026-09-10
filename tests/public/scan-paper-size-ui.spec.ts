import fs from 'node:fs';
import path from 'node:path';

describe('customer document size pickers', () => {
  const copyHtml = fs.readFileSync(
    path.resolve('src/public/copy/index.html'),
    'utf8',
  );
  const copyApp = fs.readFileSync(
    path.resolve('src/public/copy/app.ts'),
    'utf8',
  );
  const scanHtml = fs.readFileSync(
    path.resolve('src/public/scan/index.html'),
    'utf8',
  );
  const scanApp = fs.readFileSync(
    path.resolve('src/public/scan/app.ts'),
    'utf8',
  );

  it('presents and submits the selected copy source size', () => {
    expect(copyHtml).toContain('name="copySourcePaperSize"');
    expect(copyHtml).toContain('Short Bond');
    expect(copyHtml).toContain('Long Bond');
    expect(copyApp).toMatch(/JSON\.stringify\(\{ paperSize \}\)/);
  });

  it('sends the selected ADF source size at the standard scan quality', () => {
    expect(scanHtml).toContain('name="scanSourcePaperSize"');
    expect(scanApp).toContain("const SCAN_DPI: ScanDpi = '300'");
    expect(scanApp).toContain('paperSize,');
    expect(scanApp).not.toContain("paperSize: 'A4'");
  });
});
