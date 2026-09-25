const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '../..');
const copyHtmlPath = path.join(rootDir, 'src/public/copy/index.html');
const copyCssPath = path.join(rootDir, 'src/public/copy/styles.css');
const scanHtmlPath = path.join(rootDir, 'src/public/scan/index.html');
const scanCssPath = path.join(rootDir, 'src/public/scan/styles.css');
const scanAppTsPath = path.join(rootDir, 'src/public/scan/app.ts');
const scanAppJsPath = path.join(rootDir, 'src/public/scan/app.js');
const confirmAppTsPath = path.join(rootDir, 'src/public/confirm/app.ts');
const scannerServiceTsPath = path.join(rootDir, 'src/modules/scanner/scanner.service.ts');

test('Copy Preview Orientation Hint', () => {
  const html = fs.readFileSync(copyHtmlPath, 'utf8');
  const css = fs.readFileSync(copyCssPath, 'utf8');

  assert.ok(
    html.includes('preview-result__orientation-note'),
    'Copy preview orientation note missing in copy/index.html',
  );
  assert.ok(
    html.includes('Initial preview is in standard portrait'),
    'Expected reassurance message missing in copy/index.html',
  );
  assert.ok(
    css.includes('.preview-result__orientation-note'),
    'Missing .preview-result__orientation-note rule in copy/styles.css',
  );
});

test('Scan Preview Rotation UI Elements and Styles', () => {
  const html = fs.readFileSync(scanHtmlPath, 'utf8');
  const css = fs.readFileSync(scanCssPath, 'utf8');

  assert.ok(html.includes('id="rotateScanBtn"'), 'Rotate button missing in scan/index.html');
  assert.ok(html.includes('id="rotateScanLabel"'), 'Rotate button label missing in scan/index.html');
  assert.ok(html.includes('id="pagerGroup"'), 'Pager group wrapper missing in scan/index.html');

  assert.ok(css.includes('--preview-rotation'), 'Missing --preview-rotation CSS variable in scan/styles.css');
  assert.ok(css.includes('.rotate-btn'), 'Missing .rotate-btn style in scan/styles.css');
});

test('Scan App logic persists rotation and passes to charge flow', () => {
  const scanAppTs = fs.readFileSync(scanAppTsPath, 'utf8');
  const confirmAppTs = fs.readFileSync(confirmAppTsPath, 'utf8');
  const scannerServiceTs = fs.readFileSync(scannerServiceTsPath, 'utf8');
  const scanAppJs = fs.readFileSync(scanAppJsPath, 'utf8');

  assert.ok(scanAppTs.includes('scanRotationDeg'), 'scanRotationDeg state missing in scan/app.ts');
  assert.ok(scanAppTs.includes('applyScanRotation'), 'applyScanRotation helper missing in scan/app.ts');
  assert.ok(
    scanAppTs.includes('rotationDeg: scanRotationDeg'),
    'rotationDeg must be saved to session config in scan/app.ts',
  );

  assert.ok(
    confirmAppTs.includes('rotationDeg: config.rotationDeg'),
    'confirm/app.ts must send rotationDeg in soft-copy charge request',
  );

  assert.ok(
    scannerServiceTs.includes('rotationDeg?: number'),
    'SoftCopyChargeInput must accept rotationDeg in scanner.service.ts',
  );

  assert.ok(
    scanAppJs.includes('rotateScanBtn'),
    'Compiled scan/app.js must include rotateScanBtn',
  );
});
