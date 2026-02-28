import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export type ColorMode = "colored" | "grayscale";
export type Orientation = "portrait" | "landscape";
export type PaperSize = "A4" | "Letter" | "Legal";

export interface PrintJobOptions {
  copies: number;
  colorMode: ColorMode;
  orientation: Orientation;
  paperSize: PaperSize;
}

const SUMATRA_PATH = path.resolve("bin", "SumatraPDF.exe");

export async function detectDefaultPrinter(): Promise<void> {
  console.log("[PRINTER] ── Detecting default printer ─────────────────");

  // Check SumatraPDF existence
  const sumatraExists = fs.existsSync(SUMATRA_PATH);
  console.log(`[PRINTER] SumatraPDF: ${SUMATRA_PATH} (exists: ${sumatraExists})`);

  try {
    const json = await new Promise<string>((resolve, reject) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance -ClassName Win32_Printer | Where-Object {$_.Default -eq $true} | Select-Object Name, DriverName, PortName, PrinterStatus | ConvertTo-Json",
        ],
        { timeout: 10_000, windowsHide: true },
        (error, stdout) => {
          if (error) return reject(error);
          resolve(stdout.trim());
        },
      );
    });

    if (!json) {
      console.log("[PRINTER] ✗ No default printer set — printing will fail");
      return;
    }

    const printer = JSON.parse(json) as {
      Name: string;
      DriverName: string;
      PortName: string;
      PrinterStatus: number;
    };

    console.log("[PRINTER] ✓ Default printer found:");
    console.log(`[PRINTER]   Name: ${printer.Name}`);
    console.log(`[PRINTER]   Driver: ${printer.DriverName}`);
    console.log(`[PRINTER]   Port: ${printer.PortName}`);
    console.log(`[PRINTER]   Status: ${printer.PrinterStatus} (0=idle/ready)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[PRINTER] ⚠ Could not detect printer: ${msg}`);
  }
}

function buildPrintSettings(options: PrintJobOptions): string {
  const parts: string[] = [];

  const copies = Math.max(1, Math.floor(options.copies));
  if (copies > 1) parts.push(`${copies}x`);

  parts.push(options.colorMode === "colored" ? "color" : "monochrome");
  parts.push(options.orientation === "landscape" ? "landscape" : "portrait");
  parts.push(`paper=${options.paperSize}`);

  return parts.join(",");
}

export function printFile(
  filename: string,
  options: PrintJobOptions,
): Promise<void> {
  console.log("[PRINTER] ── New print job ──────────────────────────");
  console.log("[PRINTER] File:", filename);
  console.log("[PRINTER] Options:", JSON.stringify(options, null, 2));

  return new Promise((resolve, reject) => {
    const filePath = path.resolve("uploads", filename);
    const fileExists = fs.existsSync(filePath);
    console.log(`[PRINTER] Resolved path: ${filePath} (exists: ${fileExists})`);

    if (!fileExists) {
      console.error("[PRINTER] ✗ File not found — aborting");
      return reject(new Error(`File not found: ${filePath}`));
    }

    const sumatraExists = fs.existsSync(SUMATRA_PATH);
    console.log(`[PRINTER] SumatraPDF path: ${SUMATRA_PATH} (exists: ${sumatraExists})`);

    if (!sumatraExists) {
      console.error("[PRINTER] ✗ SumatraPDF not found — aborting");
      return reject(
        new Error(`SumatraPDF not found at ${SUMATRA_PATH}. Place the portable exe in bin/.`),
      );
    }

    const settings = buildPrintSettings(options);
    console.log(`[PRINTER] Settings string: "${settings}"`);

    const args = [
      "-silent",
      "-print-to-default",
      "-print-settings",
      settings,
      filePath,
    ];
    console.log(`[PRINTER] Executing: ${SUMATRA_PATH} ${args.join(" ")}`);

    const startMs = Date.now();
    execFile(SUMATRA_PATH, args, { timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
      const elapsed = Date.now() - startMs;

      if (stdout) console.log(`[PRINTER] stdout: ${stdout}`);
      if (stderr) console.warn(`[PRINTER] stderr: ${stderr}`);

      if (error) {
        console.error(`[PRINTER] ✗ Print failed after ${elapsed}ms: ${error.message}`);
        return reject(
          new Error(`Print failed: ${error.message}${stderr ? ` — ${stderr}` : ""}`),
        );
      }

      console.log(`[PRINTER] ✓ Print job completed in ${elapsed}ms`);
      resolve();
    });
  });
}
