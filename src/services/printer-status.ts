import { execFile } from "node:child_process";

// ── Types ────────────────────────────────────────────────────────

export interface InkLevel {
  name: string;
  /** 0–100 when readable, null when driver does not expose levels */
  level: number | null;
  /** "ok" | "low" | "empty" | "unknown" */
  status: "ok" | "low" | "empty" | "unknown";
}

export interface PrinterTelemetry {
  connected: boolean;
  name: string | null;
  driverName: string | null;
  portName: string | null;
  /** Human-readable printer status: "Idle", "Printing", "Error", "Offline", etc. */
  status: string;
  ink: InkLevel[];
  lastCheckedAt: string;
  lastError: string | null;
}

// ── Win32_Printer PrinterStatus mapping (CIM) ───────────────────

const PRINTER_STATUS_MAP: Record<number, string> = {
  0: "Idle",
  1: "Other",
  2: "Unknown",
  3: "Idle",
  4: "Printing",
  5: "Warming Up",
  6: "Stopped Printing",
  7: "Offline",
};

function mapPrinterStatus(code: number | undefined): string {
  if (code === undefined || code === null) return "Unknown";
  return PRINTER_STATUS_MAP[code] ?? `Status ${code}`;
}

// ── PowerShell helpers ──────────────────────────────────────────

function runPowerShell(command: string, timeoutMs = 12_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", command],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) return reject(error);
        resolve(stdout.trim());
      },
    );
  });
}

// ── Background-refreshed cache ──────────────────────────────────
//
// PowerShell printer queries can take 10-25 s on some machines.
// We run them on a background timer so the API always returns instantly.

const REFRESH_INTERVAL_MS = 30_000;
let cached: PrinterTelemetry = {
  connected: false,
  name: null,
  driverName: null,
  portName: null,
  status: "Checking…",
  ink: [],
  lastCheckedAt: new Date().toISOString(),
  lastError: null,
};
let refreshing = false;

async function refresh(): Promise<void> {
  if (refreshing) return; // prevent overlapping queries
  refreshing = true;
  try {
    cached = await queryPrinterTelemetry();
  } catch (err: unknown) {
    cached = {
      connected: false,
      name: null,
      driverName: null,
      portName: null,
      status: "Error",
      ink: [],
      lastCheckedAt: new Date().toISOString(),
      lastError: err instanceof Error ? err.message : String(err),
    };
  } finally {
    refreshing = false;
  }
}

// Kick off first query immediately, then repeat on interval
void refresh();
setInterval(() => void refresh(), REFRESH_INTERVAL_MS);

/** Returns the latest cached printer telemetry (never blocks). */
export function getPrinterTelemetry(): PrinterTelemetry {
  return cached;
}

async function queryPrinterTelemetry(): Promise<PrinterTelemetry> {
  const lastCheckedAt = new Date().toISOString();

  // 1) Get default printer basic info
  let printerInfo: {
    Name: string;
    DriverName: string;
    PortName: string;
    PrinterStatus: number;
  } | null = null;

  try {
    const json = await runPowerShell(
      `Get-CimInstance -ClassName Win32_Printer ` +
        `| Where-Object {$_.Default -eq $true} ` +
        `| Select-Object Name, DriverName, PortName, PrinterStatus ` +
        `| ConvertTo-Json`,
    );

    if (!json) {
      return {
        connected: false,
        name: null,
        driverName: null,
        portName: null,
        status: "No default printer",
        ink: [],
        lastCheckedAt,
        lastError: null,
      };
    }

    printerInfo = JSON.parse(json);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[PRINTER-STATUS] ⚠ Could not query printer: ${msg}`);
    return {
      connected: false,
      name: null,
      driverName: null,
      portName: null,
      status: "Error",
      ink: [],
      lastCheckedAt,
      lastError: msg,
    };
  }

  if (!printerInfo) {
    return {
      connected: false,
      name: null,
      driverName: null,
      portName: null,
      status: "No default printer",
      ink: [],
      lastCheckedAt,
      lastError: null,
    };
  }

  // 2) Query ink/toner levels via MSFT_PrinterConfiguration and DevMode
  const ink = await queryInkLevels(printerInfo.Name);

  return {
    connected: true,
    name: printerInfo.Name,
    driverName: printerInfo.DriverName,
    portName: printerInfo.PortName,
    status: mapPrinterStatus(printerInfo.PrinterStatus),
    ink,
    lastCheckedAt,
    lastError: null,
  };
}

/**
 * Attempts to read ink/toner levels via WMI.
 *
 * Most consumer inkjet printers do NOT expose per-cartridge fill levels
 * through standard Windows WMI. This query attempts it, but returns
 * a single "unknown" entry when data is unavailable (the common case).
 */
async function queryInkLevels(printerName: string): Promise<InkLevel[]> {
  try {
    // Try Win32_Printer extended properties for supply info.
    // This works for some printers that expose data via WMI extensions.
    const escapedName = printerName.replace(/'/g, "''");
    const json = await runPowerShell(
      `$p = Get-CimInstance -ClassName Win32_Printer -Filter "Name='${escapedName}'"; ` +
        `$props = @{ ` +
        `  PrinterState = $p.PrinterState; ` +
        `  DetectedErrorState = $p.DetectedErrorState; ` +
        `  ExtendedPrinterStatus = $p.ExtendedPrinterStatus; ` +
        `  ExtendedDetectedErrorState = $p.ExtendedDetectedErrorState ` +
        `}; ` +
        `$props | ConvertTo-Json`,
    );

    if (!json) {
      return buildUnknownInk();
    }

    const props = JSON.parse(json) as {
      PrinterState?: number;
      DetectedErrorState?: number;
      ExtendedPrinterStatus?: number;
      ExtendedDetectedErrorState?: number;
    };

    // DetectedErrorState 8 = "Low Toner", 21 = "Toner Empty"
    // ExtendedDetectedErrorState 8 = "Low Toner"
    if (props.DetectedErrorState === 8 || props.ExtendedDetectedErrorState === 8) {
      return [{ name: "Toner", level: null, status: "low" }];
    }
    if (props.DetectedErrorState === 21) {
      return [{ name: "Toner", level: null, status: "empty" }];
    }

    // No error state detected — attempt numeric level via SNMP-exposed local data
    const levels = await querySnmpLocalLevels(printerName);
    if (levels.length > 0) return levels;

    return buildUnknownInk();
  } catch {
    return buildUnknownInk();
  }
}

/**
 * Tries to read printer supply levels from the local WMI printer property
 * that some drivers populate. Returns empty array when unsupported.
 */
async function querySnmpLocalLevels(printerName: string): Promise<InkLevel[]> {
  try {
    const escapedName = printerName.replace(/'/g, "''");
    const json = await runPowerShell(
      `Get-PrinterProperty -PrinterName '${escapedName}' 2>$null ` +
        `| Where-Object { $_.PropertyName -match 'InkLevel|TonerLevel|Supply' } ` +
        `| Select-Object PropertyName, Value ` +
        `| ConvertTo-Json`,
      8_000,
    );

    if (!json) return [];

    const raw = JSON.parse(json);
    const items = Array.isArray(raw) ? raw : [raw];
    const result: InkLevel[] = [];

    for (const item of items) {
      const name = String(item.PropertyName ?? "Supply")
        .replace(/Level$/i, "")
        .replace(/^Config:/i, "")
        .trim();
      const numVal = Number(item.Value);
      const level = Number.isFinite(numVal) && numVal >= 0 && numVal <= 100 ? numVal : null;

      result.push({
        name: name || "Supply",
        level,
        status: inkStatusFromLevel(level),
      });
    }

    return result;
  } catch {
    return [];
  }
}

function inkStatusFromLevel(level: number | null): InkLevel["status"] {
  if (level === null) return "unknown";
  if (level <= 0) return "empty";
  if (level <= 15) return "low";
  return "ok";
}

function buildUnknownInk(): InkLevel[] {
  return [{ name: "Ink / Toner", level: null, status: "unknown" }];
}
