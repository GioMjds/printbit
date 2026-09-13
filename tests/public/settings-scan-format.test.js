const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '../..');
const htmlPath = path.join(rootDir, 'src/public/admin/settings/index.html');
const cssPath = path.join(rootDir, 'src/public/admin/settings/styles.css');
const appTsPath = path.join(rootDir, 'src/public/admin/settings/app.ts');
const appJsPath = path.join(rootDir, 'src/public/admin/settings/app.js');

test('Customer Scan Filename Format - index.html markup', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');

  // Prefix input exists and has default value
  assert.ok(html.includes('id="settingScanFilenamePrefix"'), 'Prefix input missing');
  assert.ok(html.includes('value="PrintBit-Scan"'), 'Prefix default value missing');

  // Preset inputs exist
  assert.ok(html.includes('id="settingScanFilenameDateFormat"'), 'Date format select missing');
  assert.ok(html.includes('id="settingScanFilenameTimeFormat"'), 'Time format select missing');
  assert.ok(html.includes('id="settingScanFilenameIncludeRandom"'), 'Random checkbox missing');

  // Custom pattern elements exist and have initial template value
  assert.ok(html.includes('id="settingScanFilenameCustomPatternEnabled"'), 'Custom pattern checkbox missing');
  assert.ok(html.includes('id="customPatternContainer"'), 'Custom pattern container missing');
  assert.ok(html.includes('id="settingScanFilenameCustomPattern"'), 'Custom pattern input missing');
  assert.ok(
    html.includes('value="{PREFIX}_{YYYY}{MM}{DD}_{HH}{mm}{ss}"'),
    'Custom pattern input default value missing in HTML',
  );

  // Live preview element exists
  assert.ok(html.includes('id="scanFilenamePreviewText"'), 'Live preview text container missing');
});

test('Customer Scan Filename Format - styles.css disabled styles', () => {
  const css = fs.readFileSync(cssPath, 'utf8');

  assert.ok(css.includes('.field--disabled'), 'Missing .field--disabled styling in styles.css');
  assert.ok(css.includes(':disabled'), 'Missing :disabled input styling in styles.css');
});

test('Customer Scan Filename Format - app.ts initialization and UI synchronization', () => {
  const code = fs.readFileSync(appTsPath, 'utf8');

  // syncScanFilenameUI function exists
  assert.ok(code.includes('syncScanFilenameUI'), 'Missing syncScanFilenameUI function in app.ts');

  // Called on top-level initialize
  assert.ok(
    code.includes('syncScanFilenameUI();'),
    'syncScanFilenameUI() must be called during initialization',
  );

  // Token tag click dispatches input event for settingsDirty tracking
  assert.ok(
    code.includes('settingScanFilenameCustomPattern.dispatchEvent') &&
      code.includes("'input'") &&
      code.includes('bubbles: true'),
    'Token tag click must dispatch input event to keep settingsDirty and preview in sync',
  );

  // Preset inputs are disabled when custom pattern is active
  assert.ok(
    code.includes('.disabled = customEnabled') || code.includes('disabled = Boolean(customEnabled)'),
    'Preset inputs must be disabled when custom pattern template is active',
  );
});

test('Customer Scan Filename Format - compiled app.js bundle is up to date', () => {
  assert.ok(fs.existsSync(appJsPath), 'app.js bundle does not exist');
  const js = fs.readFileSync(appJsPath, 'utf8');

  assert.ok(js.includes('settingScanFilenamePrefix'), 'app.js bundle missing settingScanFilenamePrefix');
  assert.ok(js.includes('scanFilenamePreviewText'), 'app.js bundle missing scanFilenamePreviewText');
  assert.ok(js.includes('customPatternContainer'), 'app.js bundle missing customPatternContainer');
});
