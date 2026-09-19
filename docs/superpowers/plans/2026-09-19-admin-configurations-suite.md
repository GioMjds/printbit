# Admin Configurations Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement four major administrative configurations for PrintBit: Max Print Pages enforcement, real-time UI Blocking overlays with on-screen staff unlock, hardware DPI resolution settings for glass vs. ADF in Copy/Scan, and Developer Testing Mode with production accounting isolation.

**Architecture:** Extend `AdminSettings` in Lowdb/schema with typed configuration sub-objects (`printLimits`, `uiBlocking`, `scannerDpi`, `developerMode`). Update `admin.controller.ts` to validate and broadcast changes over Socket.IO. Build a shared `ui-blocking-overlay.ts` for customer screens with an interactive PIN unlock modal. Wire dynamic DPI resolution into `scanner.service.ts` based on source (`flatbed` vs. `adf`). Quarantine test transactions with `environment: 'test'` in `financial-ledger.ts` to shield revenue analytics.

**Tech Stack:** TypeScript, Node.js / Express, Socket.IO, Lowdb (JSON database), HTML5/CSS3 (Native UI), Mocha/Node Test runner.

**Spec:** [docs/superpowers/specs/2026-09-19-admin-configurations-suite-design.md](file:///C:/Users/printbit/printbit/docs/superpowers/specs/2026-09-19-admin-configurations-suite-design.md)

## Global Constraints

- `printLimits.maxPagesPerSession`: Integer between 1 and 500 (default: 30).
- `uiBlocking.mode`: Exactly one of `'maintenance'`, `'needs_admin'`, `'out_of_service'`.
- `scannerDpi` values: Exactly one of `150`, `300`, `600`.
- Developer test transactions must never increment `db.data.earnings` or appear in production revenue analytics.
- Real-time UI updates must communicate via Socket.IO events (`uiBlockingChanged`, `systemSettingsChanged`) with graceful polling fallback.

---

### Task 1: Core Database Schema & Admin Settings API Updates

**Files:**

- Modify: `src/modules/admin/admin.schema.ts:130-163`
- Modify: `src/core/database/models/admin.model.ts:120-160`
- Modify: `src/core/database/db.ts:250-320` and `1180-1250`
- Modify: `src/modules/admin/admin.controller.ts:1350-1650`
- Modify: `src/modules/page/page.controller.ts:205-225`
- Create: `test/modules/admin/admin-settings-suite.test.ts`

**Interfaces:**

- Consumes: `DEFAULT_DATA`, `normalizeDbData()`, `AdminSettings`
- Produces:
  - `PrintLimitsSettings`: `{ maxPagesPerSession: number }`
  - `UiBlockingSettings`: `{ enabled: boolean; mode: UiBlockingMode; customMessage: string }`
  - `ScannerDpiSettings`: `{ copyGlass: SupportedDpi; copyAdf: SupportedDpi; scanGlass: SupportedDpi; scanAdf: SupportedDpi }`
  - `DeveloperModeSettings`: `{ enabled: boolean; environmentTag: 'test' }`

- [ ] **Step 1: Write failing test for schema validation and defaults**

Create `test/modules/admin/admin-settings-suite.test.ts`:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../../src/services/db';

test('DEFAULT_DATA contains suite settings with default values', () => {
  const settings = db.data?.settings;
  assert.ok(settings, 'Settings should be defined');
  assert.equal(settings.printLimits?.maxPagesPerSession, 30);
  assert.equal(settings.uiBlocking?.enabled, false);
  assert.equal(settings.uiBlocking?.mode, 'maintenance');
  assert.equal(settings.scannerDpi?.copyGlass, 300);
  assert.equal(settings.scannerDpi?.copyAdf, 300);
  assert.equal(settings.scannerDpi?.scanGlass, 300);
  assert.equal(settings.scannerDpi?.scanAdf, 300);
  assert.equal(settings.developerMode?.enabled, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/modules/admin/admin-settings-suite.test.ts`
Expected: FAIL (properties undefined)

- [ ] **Step 3: Implement schema, model, db defaults, and controller validator**

In `src/modules/admin/admin.schema.ts`:

```typescript
export interface PrintLimitsSettings {
  maxPagesPerSession: number;
}

export type UiBlockingMode = 'maintenance' | 'needs_admin' | 'out_of_service';

export interface UiBlockingSettings {
  enabled: boolean;
  mode: UiBlockingMode;
  customMessage: string;
}

export type SupportedDpi = 150 | 300 | 600;

export interface ScannerDpiSettings {
  copyGlass: SupportedDpi;
  copyAdf: SupportedDpi;
  scanGlass: SupportedDpi;
  scanAdf: SupportedDpi;
}

export interface DeveloperModeSettings {
  enabled: boolean;
  environmentTag: 'test';
}
```

Add these to `AdminSettings` in `src/modules/admin/admin.schema.ts` and `src/core/database/models/admin.model.ts`.
In `src/core/database/db.ts`:
Update `DEFAULT_DATA.settings` with:

```typescript
printLimits: { maxPagesPerSession: 30 },
uiBlocking: { enabled: false, mode: 'maintenance', customMessage: '' },
scannerDpi: { copyGlass: 300, copyAdf: 300, scanGlass: 300, scanAdf: 300 },
developerMode: { enabled: false, environmentTag: 'test' },
```

Update `normalizeDbData()` to ensure these sections default cleanly.
In `src/modules/admin/admin.controller.ts`:
Add validators to `updateSettings` for:

- `printLimits.maxPagesPerSession` (1..500)
- `uiBlocking.enabled` (boolean), `mode` ('maintenance' | 'needs_admin' | 'out_of_service'), `customMessage` (string <= 250)
- `scannerDpi.copyGlass`, `copyAdf`, `scanGlass`, `scanAdf` (150 | 300 | 600)
- `developerMode.enabled` (boolean)
  Emit Socket.IO event `uiBlockingChanged` when `uiBlocking` changes.
  In `src/modules/page/page.controller.ts`:
  Include `maxPagesPerSession`, `uiBlocking`, `developerMode` in `/api/page/settings`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/modules/admin/admin-settings-suite.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/admin.schema.ts src/core/database/models/admin.model.ts src/core/database/db.ts src/modules/admin/admin.controller.ts src/modules/page/page.controller.ts test/modules/admin/admin-settings-suite.test.ts
git commit -m "feat(admin): add admin configuration suite schema, defaults, and API validation"
```

---

### Task 2: Admin Settings UI Form Cards & Client Controller

**Files:**

- Modify: `src/public/admin/settings/index.html:650-930`
- Modify: `src/public/admin/settings/app.ts:300-850`
- Modify: `src/public/admin/shared.ts:200-240`

**Interfaces:**

- Consumes: `AdminSettings` from `/api/admin/settings`
- Produces: Form fields and payload for `PATCH /api/admin/settings`

- [ ] **Step 1: Write test for admin shared settings types**

Add test in `test/modules/admin/admin-settings-suite.test.ts`:

```typescript
test('PATCH /api/admin/settings validates DPI and page limit bounds', async () => {
  // Test numeric validation bounds
  const validDpis = [150, 300, 600];
  for (const dpi of validDpis) {
    assert.ok([150, 300, 600].includes(dpi));
  }
});
```

- [ ] **Step 2: Add UI Form Cards in `src/public/admin/settings/index.html`**

Add 4 clean cards under appropriate sections:

1. **Print Limits**:
   - Number input `#settingMaxPagesPerSession` (min 1, max 500, default 30).
2. **Kiosk Availability & UI Blocking**:
   - Checkbox `#settingUiBlockingEnabled`
   - Select `#settingUiBlockingMode` with options `maintenance`, `needs_admin`, `out_of_service`.
   - Text input `#settingUiBlockingMessage` (placeholder "e.g., Attendant on site. Back at 2 PM").
3. **Scanner & ADF Resolution**:
   - Selects `#settingCopyGlassDpi`, `#settingCopyAdfDpi`, `#settingScanGlassDpi`, `#settingScanAdfDpi` with options `150`, `300`, `600`.
4. **Developer Testing Mode**:
   - Checkbox `#settingDeveloperModeEnabled` with amber warning callout.

- [ ] **Step 3: Update `src/public/admin/settings/app.ts`**

- Hydrate form fields in `populateForm(settings)`:
  - `settingMaxPagesPerSession.value = String(settings.printLimits?.maxPagesPerSession ?? 30)`
  - `settingUiBlockingEnabled.checked = Boolean(settings.uiBlocking?.enabled)`
  - `settingUiBlockingMode.value = settings.uiBlocking?.mode ?? 'maintenance'`
  - `settingUiBlockingMessage.value = settings.uiBlocking?.customMessage ?? ''`
  - `settingCopyGlassDpi.value = String(settings.scannerDpi?.copyGlass ?? 300)`
  - `settingCopyAdfDpi.value = String(settings.scannerDpi?.copyAdf ?? 300)`
  - `settingScanGlassDpi.value = String(settings.scannerDpi?.scanGlass ?? 300)`
  - `settingScanAdfDpi.value = String(settings.scannerDpi?.scanAdf ?? 300)`
  - `settingDeveloperModeEnabled.checked = Boolean(settings.developerMode?.enabled)`
- Collect in form submission payload and send via `PATCH /api/admin/settings`.

- [ ] **Step 4: Verify syntax & build**

Run: `npx tsc --noEmit`
Expected: PASS with 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/public/admin/settings/index.html src/public/admin/settings/app.ts src/public/admin/shared.ts
git commit -m "feat(admin-ui): add settings UI cards for print limits, UI blocking, DPI, and dev mode"
```

---

### Task 3: Feature 1 Implementation — Dynamic Max Print Pages Enforcement

**Files:**

- Modify: `src/public/shared/large-print-warning.ts:1-18`
- Modify: `src/public/print/app.ts:740-810`
- Modify: `src/public/upload/app.ts:740-770`
- Modify: `src/public/config/app.ts:1495-1540`
- Modify: `src/services/print-quote.ts:50-100`
- Modify: `test/modules/admin/admin-settings-suite.test.ts`

**Interfaces:**

- Consumes: `maxPagesPerSession` from `/api/page/settings`
- Produces: Dynamic client notices and quote limits capping total pages to `maxPagesPerSession`.

- [ ] **Step 1: Write test for dynamic large print warning and quote capping**

Add in `test/modules/admin/admin-settings-suite.test.ts`:

```typescript
import {
  formatLargePrintDisclaimer,
  isLargePrintDocument,
} from '../../src/public/shared/large-print-warning';

test('isLargePrintDocument respects custom threshold', () => {
  assert.equal(isLargePrintDocument(25, 20), true);
  assert.equal(isLargePrintDocument(15, 20), false);
});

test('formatLargePrintDisclaimer includes dynamic page count and limit', () => {
  const disclaimer = formatLargePrintDisclaimer(45, 30);
  assert.ok(disclaimer.includes('30 printed pages'));
  assert.ok(disclaimer.includes('45 pages'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/modules/admin/admin-settings-suite.test.ts`
Expected: FAIL (functions don't accept custom threshold)

- [ ] **Step 3: Update `large-print-warning.ts`, `print/app.ts`, `upload/app.ts`, `config/app.ts`, and `print-quote.ts`**

1. In `src/public/shared/large-print-warning.ts`:
   - Accept optional `threshold: number = PRINT_PAGE_WARNING_THRESHOLD`.
   - Update `formatPrintSessionLimitNote(limit: number)` and `formatLargePrintDisclaimer(pageCount: number, limit: number)`.
2. In `src/public/print/app.ts` and `src/public/upload/app.ts`:
   - Fetch `maxPagesPerSession` from `/api/page/settings`.
   - Pass `maxPagesPerSession` into `isLargePrintDocument(pageCount, maxPagesPerSession)` and `formatLargePrintDisclaimer(pageCount, maxPagesPerSession)`.
3. In `src/public/config/app.ts`:
   - Replace hardcoded `const maxAllowed = 30` with `maxPagesPerSession` (loaded from settings).
   - If document `maxPages > maxAllowed`, disable "All Pages", auto-select "Page Range" with end capped at `Math.min(maxAllowed, maxPages)`.
   - Ensure total sheets validation `(end - start + 1) * copies <= maxAllowed`.
4. In `src/services/print-quote.ts`:
   - Read `db.data?.settings?.printLimits?.maxPagesPerSession ?? 30` and reject with `EXCEEDS_MAX_PAGES` if requested pages exceed limit.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/modules/admin/admin-settings-suite.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/public/shared/large-print-warning.ts src/public/print/app.ts src/public/upload/app.ts src/public/config/app.ts src/services/print-quote.ts test/modules/admin/admin-settings-suite.test.ts
git commit -m "feat(print): enforce dynamic max pages per session across print intake and configuration"
```

---

### Task 4: Feature 2 Implementation — UI Blocking Overlay & On-Screen Staff Unlock

**Files:**

- Create: `src/public/shared/ui-blocking-overlay.ts`
- Modify: `src/public/globals.css:830-920`
- Modify: `src/modules/admin/admin.controller.ts:200-260`
- Modify: `src/public/app.ts:1-120`
- Modify: `src/public/print/app.ts:1-40`
- Modify: `src/public/copy/app.ts:1-40`
- Modify: `src/public/scan/app.ts:1-40`
- Modify: `src/public/config/app.ts:1-40`
- Modify: `src/public/confirm/app.ts:1-40`

**Interfaces:**

- Consumes: Socket.IO event `uiBlockingChanged`, `/api/page/settings`
- Produces: `attachUiBlockingOverlay(options)` singleton controller, `POST /api/admin/verify-pin`

- [ ] **Step 1: Write test for PIN verify & UI blocking status**

Add in `test/modules/admin/admin-settings-suite.test.ts`:

```typescript
test('UI blocking mode titles and descriptions are correctly defined', () => {
  const modes = ['maintenance', 'needs_admin', 'out_of_service'] as const;
  assert.equal(modes.length, 3);
});
```

- [ ] **Step 2: Create `src/public/shared/ui-blocking-overlay.ts`**

Implement `attachUiBlockingOverlay(options)`:

- Create DOM overlay with ID `printbitUiBlockingOverlay`.
- Handle styles and high z-index (`2147483645`).
- Display corresponding mode icon (SVG for Wrench, User Shield, Warning Octagon), headline, and `customMessage`.
- Include Staff Unlock lock icon button in corner.
- Tapping lock button opens inline PIN modal (`#uiBlockingPinModal`).
- Submitting PIN sends `POST /api/admin/verify-pin`. On success, show actions:
  1. "Disable Blocking Mode" -> calls `PATCH /api/admin/settings` with `{ uiBlocking: { enabled: false } }`.
  2. "Open Admin Console" -> navigates to `/admin/settings`.
- Listen to `socket.on('uiBlockingChanged', (state) => updateOverlayState(state))`.

- [ ] **Step 3: Update `src/modules/admin/admin.controller.ts` with `POST /api/admin/verify-pin`**

- Endpoint checks Argon2id hash of `body.pin` against `db.data.settings.adminPin`.
- If `body.action === 'disable_ui_blocking'`, sets `db.data.settings.uiBlocking.enabled = false`, saves db, emits `uiBlockingChanged`, and returns `{ success: true, disabled: true }`.

- [ ] **Step 4: Attach overlay across all customer pages**

Call `attachUiBlockingOverlay()` in:

- `src/public/app.ts` (landing)
- `src/public/print/app.ts`
- `src/public/copy/app.ts`
- `src/public/scan/app.ts`
- `src/public/config/app.ts`
- `src/public/confirm/app.ts`

- [ ] **Step 5: Verify build & typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/public/shared/ui-blocking-overlay.ts src/public/globals.css src/modules/admin/admin.controller.ts src/public/app.ts src/public/print/app.ts src/public/copy/app.ts src/public/scan/app.ts src/public/config/app.ts src/public/confirm/app.ts
git commit -m "feat(kiosk): implement real-time UI blocking overlay with on-screen admin PIN unlock"
```

---

### Task 5: Feature 3 Implementation — Scanner & ADF DPI Resolution Settings

**Files:**

- Modify: `src/modules/scanner/scanner.service.ts:50-100` and `770-830`
- Modify: `src/public/scan/app.ts:180-220` and `650-670`
- Modify: `test/modules/admin/admin-settings-suite.test.ts`

**Interfaces:**

- Consumes: `db.data.settings.scannerDpi`
- Produces: `scannerService.resolveConfiguredDpi(service, source)`

- [ ] **Step 1: Write test for `resolveConfiguredDpi`**

Add in `test/modules/admin/admin-settings-suite.test.ts`:

```typescript
import { scannerService } from '../../src/modules/scanner/scanner.service';

test('scannerService.resolveConfiguredDpi resolves glass and adf correctly', () => {
  // Set custom dpi in test db
  db.data!.settings.scannerDpi = {
    copyGlass: 150,
    copyAdf: 300,
    scanGlass: 600,
    scanAdf: 150,
  };

  assert.equal(scannerService.resolveConfiguredDpi('copy', 'flatbed'), 150);
  assert.equal(scannerService.resolveConfiguredDpi('copy', 'adf'), 300);
  assert.equal(scannerService.resolveConfiguredDpi('scan', 'glass'), 600);
  assert.equal(scannerService.resolveConfiguredDpi('scan', 'feeder'), 150);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/modules/admin/admin-settings-suite.test.ts`
Expected: FAIL (`resolveConfiguredDpi` not a function)

- [ ] **Step 3: Implement `resolveConfiguredDpi` in `scanner.service.ts`**

In `src/modules/scanner/scanner.service.ts`:

- Implement:
  ```typescript
  public resolveConfiguredDpi(
    service: 'copy' | 'scan',
    source: 'flatbed' | 'adf' | 'glass' | 'feeder',
  ): SupportedDpi {
    const isAdf = source === 'adf' || source === 'feeder';
    const cfg = db.data?.settings?.scannerDpi;
    if (service === 'copy') {
      return isAdf ? (cfg?.copyAdf ?? 300) : (cfg?.copyGlass ?? 300);
    }
    return isAdf ? (cfg?.scanAdf ?? 300) : (cfg?.scanGlass ?? 300);
  }
  ```
- In `previewScan(paperSize)`:
  - `const source = toCopyPreviewSource(paperSize);`
  - `const dpi = this.resolveConfiguredDpi('copy', source);`
  - Pass `dpi` into scan preview settings.
- In `interactiveScan` & `createScanJob`:
  - When DPI is not overridden, resolve via `resolveConfiguredDpi('scan', source)`.
- In `src/public/scan/app.ts`:
  - Read configured default scan DPI from `/api/page/settings`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/modules/admin/admin-settings-suite.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/scanner/scanner.service.ts src/public/scan/app.ts test/modules/admin/admin-settings-suite.test.ts
git commit -m "feat(scanner): connect copy and scan workflows to configured glass and ADF DPI settings"
```

---

### Task 6: Feature 4 Implementation — Developer Testing Mode & Financial Isolation

**Files:**

- Modify: `src/services/financial-ledger.ts:30-100`
- Modify: `src/modules/admin/admin.service.ts:750-850`
- Modify: `src/public/admin/transactions/index.html` & `src/public/admin/transactions/app.ts`
- Modify: `src/public/globals.css`
- Modify: `src/public/shared/ui-blocking-overlay.ts` (or watermark banner module)
- Modify: `test/modules/admin/admin-settings-suite.test.ts`

**Interfaces:**

- Consumes: `db.data.settings.developerMode.enabled`
- Produces: Tagged financial entries (`environment: 'test'`), zero production earnings impact, test banner watermark.

- [ ] **Step 1: Write test for Developer Testing Mode financial shield**

Add in `test/modules/admin/admin-settings-suite.test.ts`:

```typescript
import { financialLedgerService } from '../../src/services/financial-ledger';
import { adminService } from '../../src/services/admin';

test('financialLedgerService tags entries with environment=test and shields earnings', async () => {
  const initialEarnings = db.data!.earnings;

  // Turn on developer testing mode
  db.data!.settings.developerMode.enabled = true;

  await financialLedgerService.append({
    transactionId: 'test-tx-1',
    type: 'payment_received',
    amount: 50,
    status: 'completed',
  });

  // Ensure production db.data.earnings was NOT incremented
  assert.equal(
    db.data!.earnings,
    initialEarnings,
    'Production earnings should not increase in dev mode',
  );

  // Verify earnings analytics filters test entries
  const analytics = await adminService.getEarningsAnalytics('daily');
  // Check that test transaction did not pollute totals
  assert.equal(analytics.totals.today, 0);

  // Restore developer mode
  db.data!.settings.developerMode.enabled = false;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/modules/admin/admin-settings-suite.test.ts`
Expected: FAIL (earnings incremented or environment not tagged)

- [ ] **Step 3: Implement Financial Ledger & Analytics Shield**

1. In `src/services/financial-ledger.ts`:
   - Check `const isTest = Boolean(db.data?.settings?.developerMode?.enabled);`
   - Set `environment: isTest ? 'test' : 'production'` on entry.
   - If `isTest` is `false`, increment `db.data.earnings += entry.amount`.
   - If `isTest` is `true`, skip incrementing `db.data.earnings`.
2. In `src/modules/admin/admin.service.ts`:
   - In `getEarningsAnalytics()`, filter: `const entries = db.data.financialLedger.filter(e => e.environment !== 'test');`
3. In `src/public/admin/transactions/index.html` & `app.ts`:
   - Add environment filter dropdown: `All`, `Production Only` (default), `Test Transactions`.
   - Display amber `[TEST]` badge on test transaction rows.
4. In `src/public/shared/ui-blocking-overlay.ts` (or shared header helper):
   - Mount an ambient top banner if `developerMode.enabled === true`:
     `[ 🛠 DEVELOPER TESTING MODE — NO REAL EARNINGS RECORDED ]`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/modules/admin/admin-settings-suite.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/financial-ledger.ts src/modules/admin/admin.service.ts src/public/admin/transactions/index.html src/public/admin/transactions/app.ts src/public/shared/ui-blocking-overlay.ts test/modules/admin/admin-settings-suite.test.ts
git commit -m "feat(accounting): implement Developer Testing Mode financial ledger quarantine and analytics shield"
```

---

### Task 7: End-to-End Suite Integration Verification

**Files:**

- All modified files
- Run whole test suite

- [ ] **Step 1: Run full test suite**

Run: `npx tsx --test test/modules/admin/admin-settings-suite.test.ts`
Expected: All tests PASS with 0 failures.

- [ ] **Step 2: Run TypeScript type checker**

Run: `npx tsc --noEmit`
Expected: 0 type errors across entire codebase.

- [ ] **Step 3: Run linter**

Run: `npm run lint` or `npx eslint src/`
Expected: 0 lint errors in modified files.

- [ ] **Step 4: Update Knowledge Graph**

Run: `graphify update .` (per project rules).

- [ ] **Step 5: Final commit**

```bash
git commit --allow-empty -m "chore: verify admin configurations suite end-to-end"
```
