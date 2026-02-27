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
  return new Promise((resolve, reject) => {
    const filePath = path.resolve("uploads", filename);

    if (!fs.existsSync(filePath)) {
      return reject(new Error(`File not found: ${filePath}`));
    }

    if (!fs.existsSync(SUMATRA_PATH)) {
      return reject(
        new Error(`SumatraPDF not found at ${SUMATRA_PATH}. Place the portable exe in bin/.`),
      );
    }

    const settings = buildPrintSettings(options);
    const args = [
      "-silent",
      "-print-to-default",
      "-print-settings",
      settings,
      filePath,
    ];

    execFile(SUMATRA_PATH, args, { timeout: 60_000, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        return reject(
          new Error(`Print failed: ${error.message}${stderr ? ` — ${stderr}` : ""}`),
        );
      }
      resolve();
    });
  });
}
