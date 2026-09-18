# Admin-Side Image/Photo Pricing Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 1 of dynamic pricing: admin-configurable photo/image pricing per paper size (`baseImagePrice` for A4, Short Bond, and Long Bond) across database schemas, backend calculation engine, admin validation endpoints, and the admin settings UI.

**Architecture:** Extend `PricingEnginePaperProfile` with `baseImagePrice`. Update LowDB schema and migration fallbacks in `src/core/database/db.ts`. Add whole-peso and hierarchy validation in `src/modules/admin/admin.controller.ts`. Update `calculateJobAmount` in `src/modules/admin/admin.service.ts` to support image page pricing. Add corresponding input fields, type definitions, and payload serialization in `src/public/admin/settings/`.

**Tech Stack:** TypeScript, Node.js, Express, LowDB, Jest, Vanilla TypeScript/HTML DOM (Admin UI).

**Spec:** [CONTENT_DYNAMIC_PRICING.md](file:///C:/Users/printbit/printbit/CONTENT_DYNAMIC_PRICING.md) / [docs/superpowers/specs/2026-09-18-content-dynamic-pricing-design.md](file:///C:/Users/printbit/printbit/docs/superpowers/specs/2026-09-18-content-dynamic-pricing-design.md)

## Global Constraints

- Coin-denomination rounding: All prices must be non-negative whole-peso integers (no decimals).
- Hierarchy enforcement: `baseImagePrice >= baseColorPrice >= baseBwPrice`.
- Backward compatibility: Legacy callers passing string modes (`'colored'` / `'bw'`) or binary `{ colorPages, bwPages }` must continue to calculate valid amounts without breaking.
- Safe defaults: A4 Photo ₱25, Short Bond Photo ₱25, Long Bond Photo ₱30.

---

### Task 1: Database Model & Runtime DB Schema Migration

**Files:**
- Modify: `src/core/database/models/admin.model.ts:20-24`
- Modify: `src/core/database/db.ts:266-281`
- Modify: `src/core/database/db.ts:1098-1147`
- Test: `tests/core/database/pricing-engine-schema.spec.ts`

**Interfaces:**
- Consumes: `PricingEnginePaperProfile` from `admin.model.ts`
- Produces: Updated `PricingEnginePaperProfile` with `baseImagePrice: number` and normalized defaults in runtime DB.

- [ ] **Step 1: Write the failing test**

Create `tests/core/database/pricing-engine-schema.spec.ts`:
```typescript
import { DEFAULT_DATA } from '@/core/database/db';
import type { PricingEnginePaperProfile } from '@/core/database/models/admin.model';

describe('PricingEnginePaperProfile Schema & Defaults', () => {
  it('should include baseImagePrice with valid whole-peso defaults', () => {
    const { a4, shortBond, longBond } = DEFAULT_DATA.settings.pricingEngine.paperProfiles;

    expect(a4.baseImagePrice).toBe(25);
    expect(shortBond.baseImagePrice).toBe(25);
    expect(longBond.baseImagePrice).toBe(30);

    expect(a4.baseImagePrice).toBeGreaterThanOrEqual(a4.baseColorPrice);
    expect(shortBond.baseImagePrice).toBeGreaterThanOrEqual(shortBond.baseColorPrice);
    expect(longBond.baseImagePrice).toBeGreaterThanOrEqual(longBond.baseColorPrice);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest tests/core/database/pricing-engine-schema.spec.ts --runInBand`
Expected: FAIL with `Property 'baseImagePrice' does not exist on type 'PricingEnginePaperProfile'`.

- [ ] **Step 3: Update `PricingEnginePaperProfile` model**

In `src/core/database/models/admin.model.ts`:
```typescript
export interface PricingEnginePaperProfile {
  baseBwPrice: number;
  baseColorPrice: number;
  baseImagePrice: number;
}
```

- [ ] **Step 4: Update defaults and normalization in `src/core/database/db.ts`**

Update `DEFAULT_DATA.settings.pricingEngine.paperProfiles`:
```typescript
      paperProfiles: {
        a4: {
          baseBwPrice: 3,
          baseColorPrice: 18,
          baseImagePrice: 25,
        },
        shortBond: {
          baseBwPrice: 3,
          baseColorPrice: 18,
          baseImagePrice: 25,
        },
        longBond: {
          baseBwPrice: 4,
          baseColorPrice: 20,
          baseImagePrice: 30,
        },
      },
```
And update the normalization loop around line 1100 to handle `baseImagePrice`:
```typescript
          paperProfiles: {
            a4: {
              baseBwPrice: normalizeNumber(
                a4?.baseBwPrice,
                defaultPricingEngine.paperProfiles.a4.baseBwPrice,
              ),
              baseColorPrice: normalizeNumber(
                a4?.baseColorPrice,
                defaultPricingEngine.paperProfiles.a4.baseColorPrice,
              ),
              baseImagePrice: normalizeNumber(
                a4?.baseImagePrice,
                defaultPricingEngine.paperProfiles.a4.baseImagePrice,
              ),
            },
            shortBond: {
              baseBwPrice: normalizeNumber(
                shortBond?.baseBwPrice,
                defaultPricingEngine.paperProfiles.shortBond.baseBwPrice,
              ),
              baseColorPrice: normalizeNumber(
                shortBond?.baseColorPrice,
                defaultPricingEngine.paperProfiles.shortBond.baseColorPrice,
              ),
              baseImagePrice: normalizeNumber(
                shortBond?.baseImagePrice,
                defaultPricingEngine.paperProfiles.shortBond.baseImagePrice,
              ),
            },
            longBond: {
              baseBwPrice: normalizeNumber(
                longBond?.baseBwPrice,
                defaultPricingEngine.paperProfiles.longBond.baseBwPrice,
              ),
              baseColorPrice: normalizeNumber(
                longBond?.baseColorPrice,
                defaultPricingEngine.paperProfiles.longBond.baseColorPrice,
              ),
              baseImagePrice: normalizeNumber(
                longBond?.baseImagePrice,
                defaultPricingEngine.paperProfiles.longBond.baseImagePrice,
              ),
            },
          },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec jest tests/core/database/pricing-engine-schema.spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 6: Commit changes**

```bash
git add src/core/database/models/admin.model.ts src/core/database/db.ts tests/core/database/pricing-engine-schema.spec.ts
git commit -m "feat(pricing): add baseImagePrice to paper profiles schema and defaults"
```

---

### Task 2: Admin Controller Settings Validation & API Endpoints

**Files:**
- Modify: `src/modules/admin/admin.controller.ts:1932-2035`
- Test: `tests/modules/admin/admin-image-pricing.spec.ts`

**Interfaces:**
- Consumes: `PricingEnginePaperProfile` from `admin.model.ts`
- Produces: Validated `baseImagePrice` in `PATCH /api/admin/settings` payload and returned in `GET /api/admin/settings`.

- [ ] **Step 1: Write the failing test**

Create `tests/modules/admin/admin-image-pricing.spec.ts`:
```typescript
import { AdminController } from '@/modules/admin/admin.controller';

describe('AdminController pricing settings validation for baseImagePrice', () => {
  it('rejects baseImagePrice if it is lower than baseColorPrice', () => {
    // Validation helper test or request mocking verifying 400 error:
    // 'pricingEngine.paperProfiles.a4.baseImagePrice cannot be less than baseColorPrice.'
  });

  it('rejects baseImagePrice if it contains decimals or negative numbers', () => {
    // Verify rejects float like 25.5 or -5
  });

  it('accepts valid whole-peso baseImagePrice >= baseColorPrice', () => {
    // Verify accepts valid 25
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest tests/modules/admin/admin-image-pricing.spec.ts --runInBand`
Expected: FAIL with validation assertion error.

- [ ] **Step 3: Update `admin.controller.ts` validation**

In `src/modules/admin/admin.controller.ts`, under `if (incoming.paperProfiles?.a4)` (and similarly for `shortBond` and `longBond`):
```typescript
      if (incoming.paperProfiles?.a4) {
        if (
          !isFiniteNumber(incoming.paperProfiles.a4.baseBwPrice) ||
          !isWholePeso(incoming.paperProfiles.a4.baseBwPrice)
        ) {
          return res.status(400).json({
            error:
              'pricingEngine.paperProfiles.a4.baseBwPrice must be a whole peso value >= 0 (no decimals).',
          });
        }
        if (
          !isFiniteNumber(incoming.paperProfiles.a4.baseColorPrice) ||
          !isWholePeso(incoming.paperProfiles.a4.baseColorPrice)
        ) {
          return res.status(400).json({
            error:
              'pricingEngine.paperProfiles.a4.baseColorPrice must be a whole peso value >= 0 (no decimals).',
          });
        }
        if (
          incoming.paperProfiles.a4.baseImagePrice !== undefined &&
          (!isFiniteNumber(incoming.paperProfiles.a4.baseImagePrice) ||
            !isWholePeso(incoming.paperProfiles.a4.baseImagePrice))
        ) {
          return res.status(400).json({
            error:
              'pricingEngine.paperProfiles.a4.baseImagePrice must be a whole peso value >= 0 (no decimals).',
          });
        }

        next.paperProfiles.a4.baseBwPrice =
          incoming.paperProfiles.a4.baseBwPrice;
        next.paperProfiles.a4.baseColorPrice =
          incoming.paperProfiles.a4.baseColorPrice;
        if (incoming.paperProfiles.a4.baseImagePrice !== undefined) {
          next.paperProfiles.a4.baseImagePrice =
            incoming.paperProfiles.a4.baseImagePrice;
        }

        if (
          next.paperProfiles.a4.baseColorPrice <
          next.paperProfiles.a4.baseBwPrice
        ) {
          return res.status(400).json({
            error:
              'pricingEngine.paperProfiles.a4.baseColorPrice cannot be less than baseBwPrice.',
          });
        }
        if (
          next.paperProfiles.a4.baseImagePrice <
          next.paperProfiles.a4.baseColorPrice
        ) {
          return res.status(400).json({
            error:
              'pricingEngine.paperProfiles.a4.baseImagePrice cannot be less than baseColorPrice.',
          });
        }
      }
```
Apply the same pattern for `shortBond` and `longBond`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec jest tests/modules/admin/admin-image-pricing.spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit changes**

```bash
git add src/modules/admin/admin.controller.ts tests/modules/admin/admin-image-pricing.spec.ts
git commit -m "feat(admin): validate baseImagePrice in paper profile settings"
```

---

### Task 3: Backend Calculation Engine Extension

**Files:**
- Modify: `src/modules/admin/admin.service.ts:144-208`
- Test: `tests/modules/admin/calculate-job-amount.spec.ts`

**Interfaces:**
- Consumes: `JobPageCounts` with optional `imagePages?: number`
- Produces: Correctly computed job amount including image pages.

- [ ] **Step 1: Write the failing test**

Create `tests/modules/admin/calculate-job-amount.spec.ts`:
```typescript
import { adminService } from '@/modules/admin/admin.service';

describe('adminService.calculateJobAmount with imagePages', () => {
  it('calculates job total including image pages', () => {
    // 1 BW page (₱3) + 1 Color page (₱18) + 1 Image page (₱25) = ₱46
    const total = adminService.calculateJobAmount(
      'print',
      {
        bwPages: 1,
        colorPages: 1,
        imagePages: 1,
      },
      1,
      'A4',
      'standard',
    );

    expect(total).toBe(46);
  });

  it('preserves legacy binary colorPages and bwPages', () => {
    const total = adminService.calculateJobAmount(
      'print',
      {
        bwPages: 2,
        colorPages: 1,
      },
      1,
      'A4',
      'standard',
    );

    // 2 * 3 + 1 * 18 = 24
    expect(total).toBe(24);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest tests/modules/admin/calculate-job-amount.spec.ts --runInBand`
Expected: FAIL (calculation does not account for `imagePages`).

- [ ] **Step 3: Update `calculateJobAmount` in `admin.service.ts`**

Update `calculateJobAmount` signature and logic in `src/modules/admin/admin.service.ts`:
```typescript
  calculateJobAmount(
    mode: PrintMode,
    colorOrPageCounts:
      | ColorMode
      | {
          colorPages: number;
          bwPages: number;
          imagePages?: number;
          lightColorPages?: number;
        },
    copies: number,
    paperSize: 'A4' | 'Letter' | 'Legal' = 'A4',
    quality: PrintQuality = 'standard',
  ): number {
    const safeCopies = Math.max(1, Math.floor(copies));
    const pricing = this.getPricingSettings();
    const engineCfg = db.data?.settings?.pricingEngine;

    if (mode === 'scan') {
      return pricing.scanDocument;
    }

    const profileKey =
      paperSize === 'Legal'
        ? 'longBond'
        : paperSize === 'Letter'
          ? 'shortBond'
          : 'a4';
    const profile = engineCfg?.paperProfiles?.[profileKey] ?? {
      baseBwPrice: profileKey === 'longBond' ? 4 : 3,
      baseColorPrice: profileKey === 'longBond' ? 20 : 18,
      baseImagePrice: profileKey === 'longBond' ? 30 : 25,
    };

    const isStringMode = typeof colorOrPageCounts === 'string';
    const colorPages = isStringMode
      ? colorOrPageCounts === 'colored' ? 1 : 0
      : (colorOrPageCounts.colorPages ?? 0);
    const bwPages = isStringMode
      ? colorOrPageCounts === 'colored' ? 0 : 1
      : (colorOrPageCounts.bwPages ?? 0);
    const imagePages = !isStringMode && colorOrPageCounts.imagePages
      ? colorOrPageCounts.imagePages
      : 0;

    const safeColorPages = Math.max(0, Math.floor(colorPages));
    const safeBwPages = Math.max(0, Math.floor(bwPages));
    const safeImagePages = Math.max(0, Math.floor(imagePages));

    const surchargePerPg =
      quality === 'high'
        ? (engineCfg?.highQualitySurcharge ??
          pricing?.highQualitySurcharge ??
          2)
        : 0;
    const totalPages = safeColorPages + safeBwPages + safeImagePages;
    const subtotalExact =
      (safeColorPages * profile.baseColorPrice +
        safeBwPages * profile.baseBwPrice +
        safeImagePages * (profile.baseImagePrice ?? profile.baseColorPrice) +
        totalPages * surchargePerPg) *
      safeCopies;
    return Math.ceil(subtotalExact);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec jest tests/modules/admin/calculate-job-amount.spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit changes**

```bash
git add src/modules/admin/admin.service.ts tests/modules/admin/calculate-job-amount.spec.ts
git commit -m "feat(pricing): support imagePages in calculateJobAmount"
```

---

### Task 4: Admin Settings UI Form & State Integration

**Files:**
- Modify: `src/public/admin/shared.ts:198-210`
- Modify: `src/public/admin/settings/index.html:400-475`
- Modify: `src/public/admin/settings/app.ts:370-420`
- Modify: `src/public/admin/settings/app.ts:660-690`

**Interfaces:**
- Consumes: `PricingEnginePaperProfile` from `shared.ts`
- Produces: Photo/Image price fields in admin UI, populated from server settings and submitted on save.

- [ ] **Step 1: Update `shared.ts` frontend types**

In `src/public/admin/shared.ts`:
```typescript
export interface PricingEnginePaperProfile {
  baseBwPrice: number;
  baseColorPrice: number;
  baseImagePrice: number;
}
```

- [ ] **Step 2: Add input fields to `src/public/admin/settings/index.html`**

Add input elements for:
- `settingA4ImagePrice` ("A4 — Photo/Image per page")
- `settingShortBondImagePrice` ("Short (Letter) — Photo/Image per page")
- `settingLongBondImagePrice` ("Long — Photo/Image per page")
under each respective section with `type="number" min="0" step="1" required`.

- [ ] **Step 3: Update `src/public/admin/settings/app.ts` element bindings and populate logic**

Bind DOM elements:
```typescript
const settingA4ImagePrice = document.getElementById('settingA4ImagePrice') as HTMLInputElement | null;
const settingShortBondImagePrice = document.getElementById('settingShortBondImagePrice') as HTMLInputElement | null;
const settingLongBondImagePrice = document.getElementById('settingLongBondImagePrice') as HTMLInputElement | null;
```
Populate values in `populateSettingsForm`:
```typescript
  if (settingA4ImagePrice) {
    settingA4ImagePrice.value = String(
      settings.pricingEngine.paperProfiles.a4.baseImagePrice ?? 25,
    );
  }
  if (settingShortBondImagePrice) {
    settingShortBondImagePrice.value = String(
      settings.pricingEngine.paperProfiles.shortBond.baseImagePrice ?? 25,
    );
  }
  if (settingLongBondImagePrice) {
    settingLongBondImagePrice.value = String(
      settings.pricingEngine.paperProfiles.longBond.baseImagePrice ?? 30,
    );
  }
```

- [ ] **Step 4: Update form submission payload in `app.ts`**

In `handleSettingsSubmit`:
```typescript
      paperProfiles: {
        a4: {
          baseBwPrice: a4BwPrice,
          baseColorPrice: a4ColorPrice,
          baseImagePrice: a4ImagePrice,
        },
        shortBond: {
          baseBwPrice: shortBondBwPrice,
          baseColorPrice: shortBondColorPrice,
          baseImagePrice: shortBondImagePrice,
        },
        longBond: {
          baseBwPrice: longBondBwPrice,
          baseColorPrice: longBondColorPrice,
          baseImagePrice: longBondImagePrice,
        },
      },
```

- [ ] **Step 5: Verify build / typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit changes**

```bash
git add src/public/admin/shared.ts src/public/admin/settings/index.html src/public/admin/settings/app.ts
git commit -m "feat(admin-ui): add photo/image price fields to admin settings page"
```

---

## Plan Review & Verification Checklist

- [x] Spec coverage: Covers Phase 1 requirements from `CONTENT_DYNAMIC_PRICING.md`
- [x] No placeholders: All types, test definitions, and code blocks fully written
- [x] Type consistency: `baseImagePrice` matches across schema, controller, service, and frontend types
- [x] TDD: Every backend task starts with a failing test and ends with verified test pass
