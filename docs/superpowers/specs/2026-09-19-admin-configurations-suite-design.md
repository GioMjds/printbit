# Admin Configurations Suite Design Specification

**Date:** 2026-09-19  
**Status:** Approved  
**Topic:** Admin Configuration Suite: Max Print Pages, UI Blocking Modes, Scanner/ADF DPI Settings, and Developer Testing Mode

---

## 1. Executive Summary

This specification defines four key administrative capabilities for the PrintBit kiosk platform:

1. **Max Print Pages Enforcement:** Dynamic limit configuration for maximum printable pages per session in customer flows (`/print`, `/upload`, `/config`).
2. **UI Blocking Overlay:** Real-time customer interface lockdown for Maintenance Mode, Needs Admin, and Out of Service states, with custom messages and an on-screen Admin PIN unlock prompt.
3. **Scanner & ADF DPI Settings:** Dedicated resolution configuration (150, 300, 600 DPI) for flatbed glass and automatic document feeder (ADF) across both Copy and Scan workflows.
4. **Developer Testing Mode:** An isolated testing environment where test transactions and hardware runs are tagged with `environment='test'`, completely shielding production earnings, ledger totals, and revenue analytics from false data.

---

## 2. Architecture & Data Model

### 2.1 Database Schema Extensions

In `src/modules/admin/admin.schema.ts`, `src/core/database/models/admin.model.ts`, and `src/core/database/db.ts`, `AdminSettings` is extended with the following four typed properties:

```typescript
export interface PrintLimitsSettings {
  maxPagesPerSession: number; // Default: 30, Range: 1 - 500
}

export type UiBlockingMode = 'maintenance' | 'needs_admin' | 'out_of_service';

export interface UiBlockingSettings {
  enabled: boolean; // Default: false
  mode: UiBlockingMode; // Default: 'maintenance'
  customMessage: string; // Default: '' (e.g., "Technician arrives at 2 PM")
}

export type SupportedDpi = 150 | 300 | 600;

export interface ScannerDpiSettings {
  copyGlass: SupportedDpi; // Default: 300
  copyAdf: SupportedDpi; // Default: 300
  scanGlass: SupportedDpi; // Default: 300
  scanAdf: SupportedDpi; // Default: 300
}

export interface DeveloperModeSettings {
  enabled: boolean; // Default: false
  environmentTag: 'test'; // Default: 'test'
}

export interface AdminSettings {
  // ... existing fields (pricing, idleTimeout, adminPin, alerts, etc.)
  printLimits: PrintLimitsSettings;
  uiBlocking: UiBlockingSettings;
  scannerDpi: ScannerDpiSettings;
  developerMode: DeveloperModeSettings;
}
```

### 2.2 Default Values and Normalization

In `src/core/database/db.ts`, `DEFAULT_DATA.settings` is updated to include:

```typescript
printLimits: {
  maxPagesPerSession: 30,
},
uiBlocking: {
  enabled: false,
  mode: 'maintenance',
  customMessage: '',
},
scannerDpi: {
  copyGlass: 300,
  copyAdf: 300,
  scanGlass: 300,
  scanAdf: 300,
},
developerMode: {
  enabled: false,
  environmentTag: 'test',
},
```

`normalizeDbData()` automatically backfills missing properties from `DEFAULT_DATA` when opening older database versions.

### 2.3 API Contracts

#### Admin Settings Endpoints

- **`GET /api/admin/settings`**: Returns full settings object (requires authenticated admin session).
- **`PATCH /api/admin/settings`**: Accepts partial or full updates to `printLimits`, `uiBlocking`, `scannerDpi`, and `developerMode`.
  - **Validation Rules**:
    - `printLimits.maxPagesPerSession`: Integer between `1` and `500`.
    - `uiBlocking.enabled`: Boolean.
    - `uiBlocking.mode`: Must be one of `'maintenance'`, `'needs_admin'`, `'out_of_service'`.
    - `uiBlocking.customMessage`: String, max length 250 characters.
    - `scannerDpi.copyGlass`, `scannerDpi.copyAdf`, `scannerDpi.scanGlass`, `scannerDpi.scanAdf`: Must be one of `150`, `300`, `600`.
    - `developerMode.enabled`: Boolean.
  - Emits Socket.IO events upon change:
    - `uiBlockingChanged` -> `{ enabled, mode, customMessage }`
    - `systemSettingsChanged` -> `{ printLimits, scannerDpi, developerMode }`

#### Public System State Endpoints

- **`GET /api/page/settings`** and **`GET /api/public/system-state`**:
  - Unauthenticated, safe client endpoint returning:
    ```typescript
    {
      idleTimeoutSeconds: number;
      idleScreenTimeoutSeconds: number;
      maxPagesPerSession: number;
      uiBlocking: {
        enabled: boolean;
        mode: UiBlockingMode;
        customMessage: string;
      }
      developerMode: {
        enabled: boolean;
      }
    }
    ```

#### On-Screen Staff PIN Verification

- **`POST /api/admin/verify-pin`**:
  - Body: `{ pin: string, action?: 'disable_ui_blocking' }`
  - Validates PIN with Argon2id hash against stored `settings.adminPin`.
  - If `action === 'disable_ui_blocking'`, turns off `uiBlocking.enabled`, emits `uiBlockingChanged`, and returns success.

---

## 3. Detailed Component Specifications

### 3.1 Feature 1: Max Print Pages Enforcement

#### Client Intake (`src/public/print/app.ts` & `src/public/upload/app.ts`)

- When document analysis finishes:
  - If `pageCount > maxPagesPerSession`:
    - Render informative notice on document item:
      `Notice: Document contains ${pageCount} pages. Kiosk limit is ${maxPagesPerSession} pages. You can print a range up to ${maxPagesPerSession} pages.`
    - Update `large-print-warning.ts` to dynamically accept `maxPagesPerSession` rather than the hardcoded `30`.

#### Print Configuration Screen (`src/public/config/app.ts`)

- Fetch `maxPagesPerSession` from `/api/page/settings`.
- If total document pages exceed `maxPagesPerSession`:
  - "All Pages" radio option is disabled and marked with `Max ${maxPagesPerSession} pages allowed`.
  - "Page Range" is automatically checked with end page defaulted to `Math.min(maxPagesPerSession, totalPages)`.
  - Real-time calculation enforces: `(rangeEnd - rangeStart + 1) * copies <= maxPagesPerSession`.
  - If the user selects a range or copy count exceeding this limit, the quote button is disabled and an inline warning indicates the excess.

#### Server-Side Print Guard (`src/modules/printer/printer.service.ts` & `src/services/print-quote.ts`)

- Enforce hard validation in `buildPrintQuote` and job submission. If calculated total sheets exceed `settings.printLimits.maxPagesPerSession`, return HTTP 400 with a descriptive error.

---

### 3.2 Feature 2: UI Blocking Overlay & On-Screen Admin Unlock

#### Client Overlay Module (`src/public/shared/ui-blocking-overlay.ts`)

- Shared singleton attached to all customer views (`/`, `/print`, `/scan`, `/copy`, `/config`, `/confirm`).
- Injects a fixed full-screen container (`#printbitUiBlockingOverlay`, `z-index: 2147483645`) with blurred backdrop (`backdrop-filter: blur(20px)`).
- Mode visual presentation:
  - **Maintenance Mode:** Wrench/Gear icon, title "Under Scheduled Maintenance", subtitle "The kiosk is undergoing routine maintenance or hardware updates."
  - **Needs Admin:** User Shield icon, title "Attendant Assistance Required", subtitle "Please notify staff or an administrator."
  - **Out of Service:** Warning icon, title "Temporarily Out of Service", subtitle "This kiosk is currently unavailable."
- Displays `customMessage` if provided by the administrator.
- If a customer session is running when blocking is activated, it safely purges session storage and cancels in-flight timers.

#### On-Screen Staff Unlock Modal

- An unobtrusive lock icon button in the bottom corner of the blocking screen.
- Clicking opens a secure PIN entry overlay (`#uiBlockingPinModal`).
- Upon submitting the correct PIN:
  - Displays two actions:
    1. **"Resume Service"**: Disables UI blocking on the server (`PATCH /api/admin/settings` -> `uiBlocking.enabled = false`) and unlocks all kiosks immediately.
    2. **"Open Admin Console"**: Creates an authenticated admin session and navigates to `/admin/settings`.

---

### 3.3 Feature 3: Scanner & ADF DPI Resolution Settings

#### Admin Form (`src/public/admin/settings/index.html` & `app.ts`)

- Added under **"Scanner & ADF Resolution Settings"** with 4 accessible select controls:
  1. `settingCopyGlassDpi`: Options `150`, `300`, `600`.
  2. `settingCopyAdfDpi`: Options `150`, `300`, `600`.
  3. `settingScanGlassDpi`: Options `150`, `300`, `600`.
  4. `settingScanAdfDpi`: Options `150`, `300`, `600`.

#### Backend Resolution Resolver (`src/modules/scanner/scanner.service.ts`)

- Helper method:
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
  - Detect source: `const source = toCopyPreviewSource(paperSize);` (`'adf'` for Legal, `'flatbed'` for A4/Letter).
  - Resolve DPI: `const dpi = this.resolveConfiguredDpi('copy', source);`
  - Pass resolved DPI into the scan adapter settings.
- In `createScanJob()` and `interactiveScan()`:
  - If DPI is not explicitly supplied by client, use `resolveConfiguredDpi('scan', source)`.

---

### 3.4 Feature 4: Developer Testing Mode & Production Accounting Shield

#### Admin Form (`src/public/admin/settings/index.html` & `app.ts`)

- Added under **"Developer Testing Mode"**:
  - Toggle: `settingDeveloperModeEnabled`.
  - Warning description explaining that test transactions will not impact real earnings or revenue reporting.
  - Toggling on opens a confirmation dialog to verify operator intent.

#### Ambient Watermark Banner

- When `developerMode.enabled` is `true`, a persistent amber bar is mounted at the top of customer views:
  `[ 🛠 DEVELOPER TESTING MODE — NO REAL EARNINGS RECORDED ]`

#### Financial Ledger Quarantine (`src/services/financial-ledger.ts`)

- When `financialLedgerService.append(entry)` is invoked:
  - Check `const isTest = Boolean(db.data?.settings?.developerMode?.enabled);`
  - Attach `environment: isTest ? 'test' : 'production'`.
  - If `isTest` is `true`:
    - Skip incrementing `db.data.earnings`.
    - Tag transaction record metadata with `{ isTest: true }`.

#### Revenue Analytics Shield (`src/modules/admin/admin.service.ts`)

- In `getEarningsAnalytics()`:
  - Filter: `const entries = db.data.financialLedger.filter(e => e.environment !== 'test');`
  - Compute `totals` (`today`, `week`, `month`, `year`, `allTime`) and time buckets strictly using production entries.
- In Transaction Logs (`/admin/transactions`):
  - Default view displays production transactions.
  - A dropdown filter allows toggling between `"Production Only"` and `"Test Transactions"`.
  - Test transactions display an amber `[TEST]` badge.

---

## 4. Error Handling & Edge Cases

1. **Network or Socket Disconnections:** If a kiosk loses connection, polling fallback verifies UI blocking state every 30 seconds.
2. **Missing/Legacy Settings:** All configuration reads provide fallback defaults (`maxPages = 30`, `DPI = 300`, `uiBlocking.enabled = false`, `developerMode.enabled = false`).
3. **Invalid Admin Submissions:** Strong Zod/TypeScript runtime validation rejects invalid values with HTTP 400 and clear error messages.
4. **Hard Crash or Power Loss During Test Mode:** The setting remains stored in `db.json`. Upon reboot, the watermark banner continues to warn operators if test mode is still active.

---

## 5. Verification Plan

- **Automated Unit Tests:**
  - Test settings schema validator (`PATCH /api/admin/settings`).
  - Test `resolveConfiguredDpi` with all permutations of glass/ADF and copy/scan.
  - Test `financialLedgerService.append` under normal and developer test mode, asserting that `db.data.earnings` and `getEarningsAnalytics()` remain 0 for test transactions.
- **Manual Integration Testing:**
  - Verify UI blocking overlay appears on all kiosk pages instantly when enabled in Admin Settings.
  - Verify PIN unlock modal dismisses the overlay and restores normal kiosk operation.
  - Verify `/config` restricts page ranges to configured `maxPagesPerSession`.
  - Verify scan preview respects glass and ADF DPI configs.
