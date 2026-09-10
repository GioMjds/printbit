# Long-Bond Scan Acquisition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers choose A4, Short Bond, or Long Bond before scanning, which selects a valid source and an exact NAPS2 page size.

**Architecture:** Preserve existing machine values `A4`, `Letter`, and `Legal`; customer labels are A4, Short Bond, and Long Bond. Node validates and forwards the choice. Copy selects glass for A4/Letter and ADF for Legal; scan always uses ADF. The Worker builds deterministic NAPS2 arguments.

**Tech Stack:** TypeScript, Express, Jest, browser TypeScript, C#/.NET 10, xUnit, NAPS2 CLI, named-pipe IPC.

**Spec:** `docs/superpowers/specs/2026-09-10-long-bond-scan-acquisition-design.md`

## Global Constraints

- Short Bond serializes as `Letter`; Long Bond serializes as `Legal`; never add a `Long` value.
- Reject missing or invalid scan paper sizes with HTTP 400.
- NAPS2 uses `--noprofile`; ADF sizes map to `a4`, `letter`, or `legal`; glass uses `216x297mm`.
- Preserve existing uncommitted UI and Worker work; stage only task-owned files.
- Every task follows red, green, focused verification, then an atomic repository-local commit.

---

### Task 1: Node acquisition-size contract

**Files:**
- Create: `tests/modules/scanner-paper-size.spec.ts`
- Modify: `src/modules/scanner/scanner.controller.ts:20-32,112-119,413-422,467-477`
- Modify: `src/modules/scanner/scanner.service.ts:43-66,312-350,660-685,739-757`
- Modify: `src/services/job-store.ts:37-44` if `ScanJobSettings.paperSize` needs to become required.

**Interfaces:** Consumes `paperSize: 'A4' | 'Letter' | 'Legal'`; produces `interactiveScan({ source, color, dpi, paperSize })` and `previewScan(paperSize)`.

- [ ] **Step 1: Write the failing test**

```ts
it.each([['A4', 'flatbed'], ['Letter', 'flatbed'], ['Legal', 'adf']] as const)(
  'uses %s preview source %s', async (paperSize, source) => {
    await service.previewScan(paperSize);
    expect(mockAdapter.scan).toHaveBeenCalledWith(
      expect.objectContaining({ source, paperSize }), 'uploads/scans',
    );
  },
);

it('rejects an unknown paper size', async () => {
  await expect(service.interactiveScan({
    source: 'feeder', color: 'color', dpi: '300', paperSize: 'Long' as never,
  })).rejects.toThrow('Invalid paperSize. Accepted: "A4", "Letter", "Legal"');
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm test -- tests/modules/scanner-paper-size.spec.ts`

Expected: fail because neither service entry point accepts a paper size.

- [ ] **Step 3: Implement the smallest contract**

```ts
const VALID_PAPER_SIZES = new Set(['A4', 'Letter', 'Legal']);
type ScannerPaperSize = 'A4' | 'Letter' | 'Legal';
const toCopyPreviewSource = (paperSize: ScannerPaperSize) =>
  paperSize === 'Legal' ? 'adf' : 'flatbed';
```

Add `paperSize` to interactive and scan-job body/input types. Validate against the set, include it in `getAdapter().scan()` settings, derive preview source with `toCopyPreviewSource`, and map `Invalid paperSize` to HTTP 400 in interactive and preview routes.

- [ ] **Step 4: Verify green**

Run: `pnpm test -- tests/modules/scanner-paper-size.spec.ts tests/modules/power-safety-guards.spec.ts`

Expected: exit 0.

- [ ] **Step 5: Commit**

Run: `git add -- tests/modules/scanner-paper-size.spec.ts src/modules/scanner/scanner.controller.ts src/modules/scanner/scanner.service.ts src/services/job-store.ts; git diff --cached --check; git commit -m "fix: require scan paper size"`

### Task 2: Deterministic Worker NAPS2 mapping

**Files:**
- Modify: `C:\Users\printbit\printbit-worker\src\PrintBit.Infrastructure.Windows\Scanning\Naps2ScannerService.cs:409-438`
- Modify: `C:\Users\printbit\printbit-worker\tests\PrintBit.Tests\Naps2ScannerServiceTests.cs`

**Interfaces:** Consumes `BuildNaps2Args(outputPath, driver, deviceName, source, dpi, colorMode, paperSize)`; produces `--noprofile` plus exact `--pagesize`.

- [ ] **Step 1: Write failing mapping cases**

```csharp
[Theory]
[InlineData("glass", "A4", "--pagesize 216x297mm")]
[InlineData("feeder", "A4", "--pagesize a4")]
[InlineData("feeder", "Letter", "--pagesize letter")]
[InlineData("feeder", "Legal", "--pagesize legal")]
public void BuildNaps2Args_UsesDeterministicPageSize(
    string source, string paperSize, string expectedPageSize)
{
    var args = InvokeBuildNaps2Args(source, paperSize);
    Assert.Contains("--noprofile", args, StringComparison.Ordinal);
    Assert.Contains(expectedPageSize, args, StringComparison.Ordinal);
}
```

- [ ] **Step 2: Verify red**

Run: `dotnet test tests/PrintBit.Tests/PrintBit.Tests.csproj --filter FullyQualifiedName~Naps2ScannerServiceTests`

Expected: glass full-bed case fails because the current code passes raw lower-cased input through.

- [ ] **Step 3: Implement exact mapping without replacing current Worker work**

```csharp
var isFeeder = source.Equals("adf", StringComparison.OrdinalIgnoreCase)
    || source.Equals("feeder", StringComparison.OrdinalIgnoreCase);
var pageSize = isFeeder ? paperSize?.Trim().ToLowerInvariant() switch
{
    "a4" => "a4", "letter" => "letter", "legal" => "legal", _ => null
} : "216x297mm";
if (pageSize is not null) sb.Append($"--pagesize {pageSize} ");
```

Keep `--noprofile`, driver/device/source/DPI/bit-depth, `--force`, and `--verbose`. Do not modify existing probe timeout work.

- [ ] **Step 4: Verify and commit**

Run: `dotnet test tests/PrintBit.Tests/PrintBit.Tests.csproj --filter FullyQualifiedName~Naps2ScannerServiceTests`

Expected: exit 0.

Run: `git -C C:\Users\printbit\printbit-worker add -- src/PrintBit.Infrastructure.Windows/Scanning/Naps2ScannerService.cs tests/PrintBit.Tests/Naps2ScannerServiceTests.cs; git -C C:\Users\printbit\printbit-worker diff --cached --check; git -C C:\Users\printbit\printbit-worker commit -m "fix: make scanner page size deterministic"`

### Task 3: Customer pre-scan size pickers

**Files:**
- Create: `tests/public/scan-paper-size-ui.spec.ts`
- Modify: `src/public/copy/index.html`, `src/public/copy/app.ts`, `src/public/copy/styles.css`
- Modify: `src/public/scan/index.html`, `src/public/scan/app.ts`, `src/public/scan/styles.css`

**Interfaces:** `copySourcePaperSize` and `scanSourcePaperSize` radio inputs have values `A4`, `Letter`, `Legal`. Copy posts `{ paperSize }`; scan posts `{ source, color, dpi, paperSize }` and persists `printbit.config.paperSize`.

- [ ] **Step 1: Write failing browser-contract tests**

```ts
expect(copyHtml).toContain('name="copySourcePaperSize"');
expect(copyHtml).toContain('Short Bond');
expect(copyHtml).toContain('Long Bond');
expect(copyApp).toMatch(/JSON\.stringify\(\{ paperSize \}\)/);
expect(scanHtml).toContain('name="scanSourcePaperSize"');
expect(scanApp).toContain("const SCAN_DPI: ScanDpi = '300'");
expect(scanApp).toContain('paperSize,');
expect(scanApp).not.toContain("paperSize: 'A4'");
```

- [ ] **Step 2: Verify red**

Run: `pnpm test -- tests/public/scan-paper-size-ui.spec.ts`

Expected: fail because UI controls, request fields, and dynamic session state do not exist.

- [ ] **Step 3: Implement the UI contracts**

Place a three-radio group before each primary acquisition action; A4 is default, Short Bond serializes `Letter`, and Long Bond serializes `Legal`. Copy’s instruction is glass/face-down for A4 and Short Bond, ADF/face-up/short-edge-first for Long Bond. Copy posts the selected value and stores `printbit.copySourcePaperSize`. Scan stays feeder/color, changes only `SCAN_DPI` to `'300'`, posts the selected value, and passes it into `saveScanStateToSession` instead of hardcoding A4. Preserve existing clear/rescan work.

- [ ] **Step 4: Verify and commit the two UI slices**

Run: `pnpm test -- tests/public/scan-paper-size-ui.spec.ts`

Expected: exit 0.

Run: `git add -- src/public/copy/index.html src/public/copy/app.ts src/public/copy/styles.css tests/public/scan-paper-size-ui.spec.ts; git diff --cached --check; git commit -m "feat: choose copy document size before scanning"`

Run: `git add -- src/public/scan/index.html src/public/scan/app.ts src/public/scan/styles.css tests/public/scan-paper-size-ui.spec.ts; git diff --cached --check; git commit -m "fix: send scan document size to the ADF"`

### Task 4: Integrated verification and physical acceptance

**Files:**
- Modify: none; return to the owning task if a check fails.

- [ ] **Step 1: Run focused tests**

Run: `pnpm test -- tests/modules/scanner-paper-size.spec.ts tests/public/scan-paper-size-ui.spec.ts tests/modules/power-safety-guards.spec.ts`

Expected: exit 0.

Run: `dotnet test C:\Users\printbit\printbit-worker\tests\PrintBit.Tests\PrintBit.Tests.csproj --filter FullyQualifiedName~Naps2ScannerServiceTests`

Expected: exit 0.

- [ ] **Step 2: Build and update the graph**

Run: `pnpm run lint; pnpm run build; dotnet build C:\Users\printbit\printbit-worker\src\PrintBit.HardwareService\PrintBit.HardwareService.csproj; graphify update .`

Expected: all commands exit 0.

- [ ] **Step 3: Supervised hardware acceptance**

1. Copy A4 and Short Bond from the glass; inspect each raw file under `uploads/scans`.
2. Copy Long Bond / Legal from the ADF; inspect its raw file.
3. Scan all three sizes through the ADF and inspect each raw file before its browser preview.
4. Confirm each raw file is complete and each placement instruction matched the selected size.

- [ ] **Step 4: Report task commits separately from shared-worktree changes**

Run: `git log --oneline -5; git -C C:\Users\printbit\printbit-worker log --oneline -5; git status --short; git -C C:\Users\printbit\printbit-worker status --short`

Expected: task-owned commits are visible; do not claim either shared worktree is clean if unrelated changes remain.
