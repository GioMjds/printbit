const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '../..');
const htmlPath = path.join(rootDir, 'src/public/upload/index.html');
const appTsPath = path.join(rootDir, 'src/public/upload/app.ts');
const appJsPath = path.join(rootDir, 'src/public/upload/app.js');
const portalServicePath = path.join(rootDir, 'src/modules/upload-portal/upload-portal.service.ts');
const wirelessSessionServicePath = path.join(rootDir, 'src/modules/wireless-session/wireless-session.service.ts');

test('Upload Portal - index.html markup and placeholders', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');

  // The server replaces {{documentConversionEnabled}} with true/false; the raw template file
  // contains this placeholder which is also the window.documentConversionEnabled assignment.
  assert.ok(
    html.includes('{{documentConversionEnabled}}'),
    'index.html should have {{documentConversionEnabled}} placeholder for server injection into window.documentConversionEnabled',
  );

  // Check subtitle and hint element IDs
  assert.ok(
    html.includes('id="uploadSubTitle"'),
    'index.html should have id="uploadSubTitle" on the card subtitle',
  );
  assert.ok(
    html.includes('id="dropZoneHint"'),
    'index.html should have id="dropZoneHint" on the drop zone hint',
  );
});

test('Upload Portal - UploadPortalService renders documentConversionEnabled', () => {
  const serviceCode = fs.readFileSync(portalServicePath, 'utf8');

  assert.ok(
    serviceCode.includes('documentConversionEnabled'),
    'UploadPortalService should query documentConversionEnabled from pipelineSettings',
  );
  assert.ok(
    serviceCode.includes('{{documentConversionEnabled}}'),
    'UploadPortalService should replace {{documentConversionEnabled}} placeholder',
  );
});

test('Upload Portal - WirelessSessionService includes documentConversionEnabled in getSessionByToken', () => {
  const serviceCode = fs.readFileSync(wirelessSessionServicePath, 'utf8');

  assert.ok(
    serviceCode.includes('documentConversionEnabled'),
    'WirelessSessionService getSessionByToken should include documentConversionEnabled in response',
  );
});

test('Upload Portal - app.ts handles Word document conversion state', () => {
  const code = fs.readFileSync(appTsPath, 'utf8');

  // Should have reference to documentConversionEnabled
  assert.ok(
    code.includes('documentConversionEnabled'),
    'app.ts should track documentConversionEnabled state',
  );

  // Should update file input accept attribute
  assert.ok(
    code.includes('fileInput.accept'),
    'app.ts should update fileInput.accept depending on documentConversionEnabled',
  );

  // Should restrict doc and docx when document conversion is disabled
  assert.ok(
    code.includes('.doc') && code.includes('.docx'),
    'app.ts should check .doc and .docx extensions',
  );

  // Should provide a specific error message when Word conversion is disabled
  assert.ok(
    code.toLowerCase().includes('word document conversion is disabled') ||
      code.toLowerCase().includes('document conversion is disabled'),
    'app.ts should provide a clear error message when Word documents are rejected because conversion is disabled',
  );

  // mapError should use r.error if provided
  assert.ok(
    code.includes("r.error ?? 'Unsupported file type.'") ||
      code.includes("r.error || 'Unsupported file type.'") ||
      code.includes('case \'UNSUPPORTED_TYPE\':\n      return r.error'),
    'mapError in app.ts should display r.error if available for UNSUPPORTED_TYPE',
  );
});

test('Upload Portal - compiled app.js bundle includes documentConversionEnabled logic', () => {
  assert.ok(fs.existsSync(appJsPath), 'app.js bundle does not exist');
  const js = fs.readFileSync(appJsPath, 'utf8');

  assert.ok(
    js.includes('documentConversionEnabled'),
    'app.js bundle should include documentConversionEnabled',
  );
  assert.ok(
    js.includes('uploadSubTitle') || js.includes('dropZoneHint'),
    'app.js bundle should reference dynamic subtitle or drop zone hint',
  );
});
