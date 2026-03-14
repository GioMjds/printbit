import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export type ColorMode = 'colored' | 'grayscale';
export type Orientation = 'portrait' | 'landscape';
export type PaperSize = 'A4' | 'Letter' | 'Legal';

export interface PrintJobOptions {
  copies: number;
  colorMode: ColorMode;
  orientation: Orientation;
  paperSize: PaperSize;
  pageRange?: string;
  duplex?: boolean;
}

export class PrinterService {
  private readonly sumatraPath: string;

  constructor() {
    this.sumatraPath = path.resolve('bin', 'SumatraPDF.exe');
  }

  async detectDefaultPrinter(): Promise<void> {
    console.log('[PRINTER] ── Detecting default printer ─────────────────');

    const sumatraExists = fs.existsSync(this.sumatraPath);
    console.log(
      `[PRINTER] SumatraPDF: ${this.sumatraPath} (exists: ${sumatraExists})`,
    );

    try {
      const json = await new Promise<string>((resolve, reject) => {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance -ClassName Win32_Printer | Where-Object {$_.Default -eq $true} | Select-Object Name, DriverName, PortName, PrinterStatus | ConvertTo-Json',
          ],
          { timeout: 10_000, windowsHide: true },
          (error, stdout) => {
            if (error) return reject(error);
            resolve(stdout.trim());
          },
        );
      });

      if (!json) {
        console.log('[PRINTER] ✗ No default printer set — printing will fail');
        return;
      }

      const printer = JSON.parse(json) as {
        Name: string;
        DriverName: string;
        PortName: string;
        PrinterStatus: number;
      };

      console.log('[PRINTER] ✓ Default printer found:');
      console.log(`[PRINTER]   Name: ${printer.Name}`);
      console.log(`[PRINTER]   Driver: ${printer.DriverName}`);
      console.log(`[PRINTER]   Port: ${printer.PortName}`);
      console.log(
        `[PRINTER]   Status: ${printer.PrinterStatus} (0=idle/ready)`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[PRINTER] ⚠ Could not detect printer: ${msg}`);
    }
  }

  private buildPrintSettings(options: PrintJobOptions): string {
    const parts: string[] = [];

    const pageRange = options.pageRange?.trim();
    if (pageRange) parts.push(pageRange);

    const copies = Math.max(1, Math.floor(options.copies));
    if (copies > 1) parts.push(`${copies}x`);

    parts.push(options.colorMode === 'colored' ? 'color' : 'monochrome');
    parts.push(options.orientation === 'landscape' ? 'landscape' : 'portrait');
    if (typeof options.duplex === 'boolean') {
      parts.push(options.duplex ? 'duplex' : 'simplex');
    }
    parts.push(`paper=${options.paperSize}`);

    return parts.join(',');
  }

  printFile(filename: string, options: PrintJobOptions): Promise<void> {
    console.log('[PRINTER] ── New print job ──────────────────────────');
    console.log('[PRINTER] File:', filename);
    console.log('[PRINTER] Options:', JSON.stringify(options, null, 2));

    return new Promise((resolve, reject) => {
      const uploadsDir = path.resolve('uploads');
      const normalizeFilename = filename.trim();
      if (!normalizeFilename) {
        console.error('[PRINTER] ✗ Invalid filename — empty string');
        return reject(new Error('Invalid filename'));
      }
      const filePath = path.resolve(uploadsDir, normalizeFilename);
      const relativePath = path.relative(uploadsDir, filePath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        console.error(
          '[PRINTER] ✗ Invalid filename — outside uploads directory',
        );
        return reject(new Error('Invalid filename'));
      }
      const fileExists = fs.existsSync(filePath);
      if (fileExists && !fs.statSync(filePath).isFile()) {
        console.error('[PRINTER] ✗ Invalid filename — not a file');
        return reject(new Error('Invalid filename'));
      }
      console.log(
        `[PRINTER] Resolved path: ${filePath} (exists: ${fileExists})`,
      );

      if (!fileExists) {
        console.error('[PRINTER] ✗ File not found — aborting');
        return reject(new Error(`File not found: ${filePath}`));
      }

      const sumatraExists = fs.existsSync(this.sumatraPath);
      console.log(
        `[PRINTER] SumatraPDF path: ${this.sumatraPath} (exists: ${sumatraExists})`,
      );

      if (!sumatraExists) {
        console.error('[PRINTER] ✗ SumatraPDF not found — aborting');
        return reject(
          new Error(
            `SumatraPDF not found at ${this.sumatraPath}. Place the portable exe in bin/.`,
          ),
        );
      }

      const settings = this.buildPrintSettings(options);
      console.log(`[PRINTER] Settings string: "${settings}"`);

      const args = [
        '-silent',
        '-print-to-default',
        '-print-settings',
        settings,
        filePath,
      ];
      console.log(`[PRINTER] Executing: ${this.sumatraPath} ${args.join(' ')}`);

      const startMs = Date.now();
      execFile(
        this.sumatraPath,
        args,
        { timeout: 60_000, windowsHide: true },
        (error, stdout, stderr) => {
          const elapsed = Date.now() - startMs;

          if (stdout) console.log(`[PRINTER] stdout: ${stdout}`);
          if (stderr) console.warn(`[PRINTER] stderr: ${stderr}`);

          if (error) {
            console.error(
              `[PRINTER] ✗ Print failed after ${elapsed}ms: ${error.message}`,
            );
            return reject(
              new Error(
                `Print failed: ${error.message}${stderr ? ` — ${stderr}` : ''}`,
              ),
            );
          }

          console.log(`[PRINTER] ✓ Print job sent to spooler in ${elapsed}ms`);
          resolve();
        },
      );
    });
  }
}

export const printerService = new PrinterService();
export const detectDefaultPrinter =
  printerService.detectDefaultPrinter.bind(printerService);
export const printFile = printerService.printFile.bind(printerService);
