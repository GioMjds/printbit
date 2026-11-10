import { readFileSync } from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..', '..');
const read = (rel: string): string =>
  readFileSync(path.join(root, rel), 'utf-8');

const HARDWARE_DIR = 'worker/src/PrintBit.HardwareService';
const SETTINGS_CS = 'worker/src/PrintBit.Shared/Configurations/ScannerSettings.cs';
const EXPORT_HEADROOM_MS = 10_000;

function csDefault(name: string): number {
  const match = new RegExp(`${name}\\s*\\{\\s*get;\\s*set;\\s*\\}\\s*=\\s*(\\d+)`).exec(
    read(SETTINGS_CS),
  );
  if (!match) throw new Error(`${name} default not found`);
  return Number(match[1]);
}

function tsConstant(file: string, name: string): number {
  const match = new RegExp(`${name}\\s*=\\s*([\\d_]+)`).exec(read(file));
  if (!match) throw new Error(`${name} not found in ${file}`);
  return Number(match[1].replace(/_/g, ''));
}

const APPSETTINGS = ['appsettings.json', 'appsettings.Development.json'];

describe('scan timeout alignment (worker, Node, scan page)', () => {
  it.each(APPSETTINGS)(
    '%s ScanTimeoutSeconds and ScanPageTimeoutSeconds match the worker code defaults',
    (file) => {
      const cfg = JSON.parse(read(`${HARDWARE_DIR}/${file}`)) as {
        ScannerSettings: {
          ScanTimeoutSeconds: number;
          ScanPageTimeoutSeconds: number;
        };
      };
      expect(cfg.ScannerSettings.ScanTimeoutSeconds).toBe(
        csDefault('ScanTimeoutSeconds'),
      );
      expect(cfg.ScannerSettings.ScanPageTimeoutSeconds).toBe(
        csDefault('ScanPageTimeoutSeconds'),
      );
    },
  );

  it('per-page timeout is shorter than the overall worker timeout', () => {
    expect(csDefault('ScanPageTimeoutSeconds')).toBeLessThan(
      csDefault('ScanTimeoutSeconds'),
    );
  });

  it('Node waits at least the worker timeout plus export headroom', () => {
    expect(tsConstant('src/services/scanner.ts', 'SCAN_COMMAND_TIMEOUT_MS')).toBeGreaterThanOrEqual(
      csDefault('ScanTimeoutSeconds') * 1000 + EXPORT_HEADROOM_MS,
    );
  });

  it('scan page client timeout stays above the Node IPC timeout', () => {
    expect(tsConstant('src/public/scan/app.ts', 'SCAN_REQUEST_TIMEOUT_MS')).toBeGreaterThan(
      tsConstant('src/services/scanner.ts', 'SCAN_COMMAND_TIMEOUT_MS'),
    );
  });

  it('copy page pre-scan client timeout stays above the Node IPC timeout', () => {
    expect(
      tsConstant('src/public/copy/app.ts', 'COPY_PREVIEW_REQUEST_TIMEOUT_MS'),
    ).toBeGreaterThan(
      tsConstant('src/services/scanner.ts', 'SCAN_COMMAND_TIMEOUT_MS'),
    );
  });
});
