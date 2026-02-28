import path from "node:path";
import fs from "node:fs";
import type { ScanJobSettings, PageSource } from "./job-store";

export interface ScanResult {
  outputPath: string;
  pageCount: number;
  format: string;
}

export interface ScannerCapabilities {
  available: boolean;
  sources: PageSource[];
  colorModes: ("colored" | "grayscale")[];
  dpiOptions: number[];
  duplex: boolean;
}

export interface ScannerAdapter {
  probe(): Promise<ScannerCapabilities>;
  scan(settings: ScanJobSettings, outputDir: string): Promise<ScanResult>;
  cancel(): void;
}

// ── Stub adapter (testing / no-hardware fallback) ────────────────────

export class StubScannerAdapter implements ScannerAdapter {
  private cancelled = false;

  async probe(): Promise<ScannerCapabilities> {
    console.log("[SCANNER] Probing stub scanner capabilities…");
    const caps: ScannerCapabilities = {
      available: true,
      sources: ["adf", "flatbed"],
      colorModes: ["colored", "grayscale"],
      dpiOptions: [150, 300, 600],
      duplex: false,
    };
    console.log("[SCANNER] Stub capabilities:", JSON.stringify(caps));
    return caps;
  }

  async scan(
    settings: ScanJobSettings,
    outputDir: string,
  ): Promise<ScanResult> {
    this.cancelled = false;
    console.log("[SCANNER] ── New stub scan job ─────────────────────────");
    console.log("[SCANNER] Settings:", JSON.stringify(settings));
    console.log("[SCANNER] Output dir:", outputDir);

    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });

    // Simulate scan delay
    console.log("[SCANNER] Simulating 2-second scan…");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 2_000);
      const check = setInterval(() => {
        if (this.cancelled) {
          clearTimeout(timer);
          clearInterval(check);
          reject(new Error("Scan cancelled by user"));
        }
      }, 100);
      // Clear interval when timer fires normally
      timer.unref?.();
      void new Promise<void>((r) => setTimeout(r, 2_000)).then(() =>
        clearInterval(check),
      );
    });

    const filename = `stub-scan-${Date.now()}.${settings.format}`;
    const outputPath = path.join(outputDir, filename);

    fs.writeFileSync(outputPath, "Stub scan output", "utf-8");
    console.log(`[SCANNER] ✓ Stub scan complete → ${outputPath}`);

    return {
      outputPath,
      pageCount: 1,
      format: settings.format,
    };
  }

  cancel(): void {
    console.log("[SCANNER] Cancel requested on stub adapter");
    this.cancelled = true;
  }
}

// ── Module-level active adapter ──────────────────────────────────────

let activeAdapter: ScannerAdapter = new StubScannerAdapter();

export function setAdapter(adapter: ScannerAdapter): void {
  console.log("[SCANNER] Adapter replaced");
  activeAdapter = adapter;
}

export function getAdapter(): ScannerAdapter {
  return activeAdapter;
}

export async function detectScanner(): Promise<void> {
  console.log("[SCANNER] ── Detecting scanner ──────────────────────────");

  // Ensure default scan output directory exists
  const scanDir = path.resolve("uploads", "scans");
  fs.mkdirSync(scanDir, { recursive: true });
  console.log(`[SCANNER] Scan output directory: ${scanDir}`);

  try {
    const caps = await activeAdapter.probe();

    if (!caps.available) {
      console.log("[SCANNER] ✗ No scanner available");
      return;
    }

    console.log("[SCANNER] ✓ Scanner detected:");
    console.log(`[SCANNER]   Sources: ${caps.sources.join(", ")}`);
    console.log(`[SCANNER]   Color modes: ${caps.colorModes.join(", ")}`);
    console.log(`[SCANNER]   DPI options: ${caps.dpiOptions.join(", ")}`);
    console.log(`[SCANNER]   Duplex: ${caps.duplex}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[SCANNER] ⚠ Could not detect scanner: ${msg}`);
  }
}
