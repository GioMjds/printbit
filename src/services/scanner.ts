import path from "node:path";
import fs from "node:fs";
import { execFile, type ChildProcess } from "node:child_process";
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

// ── NAPS2 adapter (real hardware via NAPS2.Console.exe) ──────────────

const NAPS2_PATH = "C:\\Program Files\\NAPS2\\NAPS2.Console.exe";
const SCAN_TIMEOUT_MS = 90_000;

export class Naps2ScannerAdapter implements ScannerAdapter {
  private deviceName: string;
  private childProc: ChildProcess | null = null;

  constructor(deviceName: string) {
    this.deviceName = deviceName;
  }

  async probe(): Promise<ScannerCapabilities> {
    console.log("[SCANNER] Probing NAPS2 scanner capabilities…");
    console.log(`[SCANNER] Device: ${this.deviceName}`);

    const devices = await listNaps2Devices();
    const found = devices.some(
      (d) => d.toLowerCase() === this.deviceName.toLowerCase(),
    );

    if (!found) {
      console.log(`[SCANNER] ✗ Device "${this.deviceName}" not found in TWAIN list`);
      return {
        available: false,
        sources: [],
        colorModes: [],
        dpiOptions: [],
        duplex: false,
      };
    }

    const caps: ScannerCapabilities = {
      available: true,
      sources: ["adf", "flatbed"],
      colorModes: ["colored", "grayscale"],
      dpiOptions: [150, 300, 600],
      duplex: false,
    };
    console.log("[SCANNER] ✓ NAPS2 capabilities:", JSON.stringify(caps));
    return caps;
  }

  async scan(
    settings: ScanJobSettings,
    outputDir: string,
  ): Promise<ScanResult> {
    console.log("[SCANNER] ── New NAPS2 scan job ────────────────────────");
    console.log("[SCANNER] Settings:", JSON.stringify(settings));
    console.log("[SCANNER] Output dir:", outputDir);

    fs.mkdirSync(outputDir, { recursive: true });

    const ext = settings.format === "jpg" ? "jpg" : settings.format === "png" ? "png" : "pdf";
    const filename = `scan-${Date.now()}.${ext}`;
    const outputPath = path.join(outputDir, filename);

    const args = buildNaps2Args(this.deviceName, settings, outputPath);
    console.log(`[SCANNER] Command: "${NAPS2_PATH}" ${args.join(" ")}`);

    const startMs = Date.now();

    return new Promise<ScanResult>((resolve, reject) => {
      const proc = execFile(
        NAPS2_PATH,
        args,
        { timeout: SCAN_TIMEOUT_MS, windowsHide: true },
        (error, stdout, stderr) => {
          this.childProc = null;
          const elapsed = Date.now() - startMs;

          if (stdout) console.log(`[SCANNER] stdout: ${stdout.trim()}`);
          if (stderr) console.warn(`[SCANNER] stderr: ${stderr.trim()}`);

          if (error) {
            console.error(`[SCANNER] ✗ Scan failed after ${elapsed}ms: ${error.message}`);
            return reject(
              new Error(`Scan failed: ${error.message}${stderr ? ` — ${stderr.trim()}` : ""}`),
            );
          }

          if (!fs.existsSync(outputPath)) {
            console.error(`[SCANNER] ✗ Output file not created: ${outputPath}`);
            return reject(new Error("Scan completed but no output file was created"));
          }

          const stat = fs.statSync(outputPath);
          console.log(`[SCANNER] ✓ Scan complete in ${elapsed}ms → ${outputPath} (${stat.size} bytes)`);

          resolve({
            outputPath,
            pageCount: 1,
            format: settings.format,
          });
        },
      );

      this.childProc = proc;
    });
  }

  cancel(): void {
    console.log("[SCANNER] Cancel requested on NAPS2 adapter");
    if (this.childProc && !this.childProc.killed) {
      console.log(`[SCANNER] Killing NAPS2 process (PID: ${this.childProc.pid})`);
      this.childProc.kill("SIGTERM");
      this.childProc = null;
    }
  }
}

function buildNaps2Args(
  deviceName: string,
  settings: ScanJobSettings,
  outputPath: string,
): string[] {
  const args = [
    "-o", outputPath,
    "--driver", "twain",
    "--device", deviceName,
    "--source", settings.source === "adf" ? "feeder" : "glass",
    "--dpi", String(settings.dpi),
    "--bitdepth", settings.colorMode === "colored" ? "color" : "gray",
    "--force",
    "--verbose",
  ];

  // Paper size (optional field from ScanJobSettings)
  if (settings.paperSize) {
    args.push("--pagesize", settings.paperSize.toLowerCase());
  }

  return args;
}

async function listNaps2Devices(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      NAPS2_PATH,
      ["--listdevices", "--driver", "twain"],
      { timeout: 15_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          console.log(`[SCANNER] ⚠ NAPS2 --listdevices failed: ${error.message}`);
          resolve([]);
          return;
        }
        const devices = stdout
          .trim()
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        console.log(`[SCANNER] NAPS2 TWAIN devices: [${devices.join(", ")}]`);
        resolve(devices);
      },
    );
  });
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

  // Check if NAPS2.Console.exe exists
  const naps2Exists = fs.existsSync(NAPS2_PATH);
  console.log(`[SCANNER] NAPS2.Console: ${NAPS2_PATH} (exists: ${naps2Exists})`);

  if (naps2Exists) {
    try {
      const devices = await listNaps2Devices();
      if (devices.length > 0) {
        const deviceName = devices[0]!;
        console.log(`[SCANNER] ✓ Using NAPS2 adapter with device: "${deviceName}"`);
        const adapter = new Naps2ScannerAdapter(deviceName);
        setAdapter(adapter);

        const caps = await adapter.probe();
        console.log("[SCANNER] ✓ Scanner ready:");
        console.log(`[SCANNER]   Sources: ${caps.sources.join(", ")}`);
        console.log(`[SCANNER]   Color modes: ${caps.colorModes.join(", ")}`);
        console.log(`[SCANNER]   DPI options: ${caps.dpiOptions.join(", ")}`);
        console.log(`[SCANNER]   Duplex: ${caps.duplex}`);
        return;
      }
      console.log("[SCANNER] ⚠ NAPS2 found but no TWAIN devices detected");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[SCANNER] ⚠ NAPS2 detection failed: ${msg}`);
    }
  }

  // Fallback to stub adapter
  console.log("[SCANNER] ⚠ Falling back to stub scanner adapter (no real hardware)");
  try {
    const caps = await activeAdapter.probe();

    if (!caps.available) {
      console.log("[SCANNER] ✗ No scanner available");
      return;
    }

    console.log("[SCANNER] ✓ Stub scanner active:");
    console.log(`[SCANNER]   Sources: ${caps.sources.join(", ")}`);
    console.log(`[SCANNER]   Color modes: ${caps.colorModes.join(", ")}`);
    console.log(`[SCANNER]   DPI options: ${caps.dpiOptions.join(", ")}`);
    console.log(`[SCANNER]   Duplex: ${caps.duplex}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[SCANNER] ⚠ Could not detect scanner: ${msg}`);
  }
}
