import { runPowerShell } from '@/utils';

// ── Types ────────────────────────────────────────────────────────

export interface InkLevel {
  name: string;
  /** 0–100 when readable, null when driver does not expose levels */
  level: number | null;
  /** "ok" | "low" | "empty" | "unknown" */
  status: 'ok' | 'low' | 'empty' | 'unknown';
  /** Optional color hint for UI rendering, e.g. "cyan", "black" */
  colorHint?: string;
}

export interface PrinterTelemetry {
  connected: boolean;
  name: string | null;
  driverName: string | null;
  portName: string | null;
  /** Connection type derived from port name */
  connectionType: 'usb' | 'network' | 'wsd' | 'virtual' | 'unknown';
  /** Human-readable printer status: "Idle", "Printing", "Error", "Offline", etc. */
  status: string;
  /** Active status flags parsed from the PrinterState bitmask */
  statusFlags: string[];
  ink: InkLevel[];
  /** Which detection method successfully returned ink data */
  inkDetectionMethod:
    | 'snmp'
    | 'vendor-wmi'
    | 'printer-property'
    | 'error-state'
    | 'none';
  lastCheckedAt: string;
  lastError: string | null;
}

// ── PrinterState bitmask (Win32_Printer) ─────────────────────────
// Ref: https://docs.microsoft.com/en-us/windows/win32/cimwin32prov/win32-printer

const PRINTER_STATE_FLAGS: Record<number, string> = {
  0x00000001: 'Paused',
  0x00000002: 'Error',
  0x00000004: 'Deleting',
  0x00000008: 'Paper Jam',
  0x00000010: 'Paper Out',
  0x00000020: 'Manual Feed Required',
  0x00000040: 'Paper Problem',
  0x00000080: 'Offline',
  0x00000200: 'IO Active',
  0x00000400: 'Busy',
  0x00000800: 'Printing',
  0x00001000: 'Output Bin Full',
  0x00002000: 'Not Available',
  0x00004000: 'Waiting',
  0x00008000: 'Processing',
  0x00010000: 'Initializing',
  0x00020000: 'Warming Up',
  0x00040000: 'Toner Low',
  0x00080000: 'No Toner',
  0x00100000: 'Page Punt',
  0x00200000: 'User Intervention Required',
  0x00400000: 'Out of Memory',
  0x00800000: 'Door Open',
  0x02000000: 'Server Unknown',
  0x04000000: 'Power Save',
};

function parsePrinterStateFlags(state: number | undefined | null): string[] {
  if (!state) return [];
  return Object.entries(PRINTER_STATE_FLAGS)
    .filter(([bit]) => (state & Number(bit)) !== 0)
    .map(([, label]) => label);
}

function humanStatusFromFlags(
  flags: string[],
  printerStatusCode: number,
): string {
  if (flags.includes('Offline')) return 'Offline';
  if (flags.includes('Error')) return 'Error';
  if (flags.includes('Paper Jam')) return 'Paper Jam';
  if (flags.includes('Paper Out')) return 'Paper Out';
  if (flags.includes('Door Open')) return 'Door Open';
  if (flags.includes('User Intervention Required'))
    return 'User Intervention Required';
  if (flags.includes('Printing')) return 'Printing';
  if (flags.includes('Warming Up')) return 'Warming Up';
  if (flags.includes('Paused')) return 'Paused';
  if (flags.length === 0 || printerStatusCode === 3) return 'Idle';
  return flags[0] ?? 'Unknown';
}

// ── Port → connection type ───────────────────────────────────────

function detectConnectionType(
  portName: string | null,
): PrinterTelemetry['connectionType'] {
  if (!portName) return 'unknown';
  const p = portName.toUpperCase();
  if (p.startsWith('USB') || p.includes('USBPRINT')) return 'usb';
  if (p.startsWith('WSD-') || p.startsWith('WSD:')) return 'wsd';
  if (
    p.startsWith('IP_') ||
    p.startsWith('TCPIP') ||
    p.startsWith('10.') ||
    p.startsWith('192.') ||
    p.startsWith('172.') ||
    p.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)
  )
    return 'network';
  if (
    p.includes('NUL') ||
    p.includes('FILE:') ||
    p.includes('PDF') ||
    p.includes('XPS') ||
    p.includes('ONENOTE') ||
    p.includes('SEND') ||
    p.includes('FAX')
  )
    return 'virtual';
  return 'unknown';
}

/**
 * Extracts a best-guess IP address from Windows port names.
 * Handles formats like "IP_192.168.1.5", "192.168.1.5", "TCPIP_192.168.1.5".
 */
function extractIpFromPortName(portName: string | null): string | null {
  if (!portName) return null;
  // "IP_x.x.x.x" or "TCPIP_x.x.x.x"
  const prefixed = portName.match(
    /^(?:IP|TCPIP)[_:](\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i,
  );
  if (prefixed) return prefixed[1];
  // bare IP
  const bare = portName.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (bare) return bare[1];
  return null;
}

// ── Color hints for common supply names ─────────────────────────

const COLOR_HINT_MAP: [RegExp, string][] = [
  [/black|bk|k\b|pgbk/i, 'black'],
  [/cyan|c\b/i, 'cyan'],
  [/magenta|m\b/i, 'magenta'],
  [/yellow|y\b/i, 'yellow'],
  [/photo|gray|grey/i, 'gray'],
  [/toner/i, 'black'],
];

function colorHintFromName(name: string): string | undefined {
  for (const [re, hint] of COLOR_HINT_MAP) {
    if (re.test(name)) return hint;
  }
  return undefined;
}

// ── Refresh-callback registry ────────────────────────────────────
//
// printer-monitor.ts (and any other subscriber) can register a callback here
// instead of running a second independent timer. Callbacks are invoked
// synchronously inside the refresh() try/catch so errors are isolated per
// subscriber via a try/catch wrapper.

type RefreshCallback = (telemetry: PrinterTelemetry) => void;
const refreshCallbacks: RefreshCallback[] = [];

/**
 * Register a function to be called after every telemetry refresh cycle.
 * The callback receives the latest PrinterTelemetry snapshot.
 * Call this once during application startup (before the first interval fires).
 */
export function onPrinterRefresh(cb: RefreshCallback): void {
  refreshCallbacks.push(cb);
}

const REFRESH_INTERVAL_MS = 30_000;
let cached: PrinterTelemetry = {
  connected: false,
  name: null,
  driverName: null,
  portName: null,
  connectionType: 'unknown',
  status: 'Checking…',
  statusFlags: [],
  ink: [],
  inkDetectionMethod: 'none',
  lastCheckedAt: new Date().toISOString(),
  lastError: null,
};
let refreshing = false;

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    cached = await queryPrinterTelemetry();
  } catch (err: unknown) {
    cached = {
      connected: false,
      name: null,
      driverName: null,
      portName: null,
      connectionType: 'unknown',
      status: 'Error',
      statusFlags: [],
      ink: [],
      inkDetectionMethod: 'none',
      lastCheckedAt: new Date().toISOString(),
      lastError: err instanceof Error ? err.message : String(err),
    };
  } finally {
    refreshing = false;
  }

  // Notify all registered subscribers with the latest snapshot.
  // Each callback is wrapped individually so one failing subscriber cannot
  // prevent the others from receiving the update.
  for (const cb of refreshCallbacks) {
    try {
      cb(cached);
    } catch (err) {
      console.warn(
        '[PRINTER-STATUS] refresh callback threw:',
        err instanceof Error ? err.message : err,
      );
    }
  }
}

void refresh();
setInterval(() => void refresh(), REFRESH_INTERVAL_MS);

/** Returns the latest cached printer telemetry (never blocks). */
export function getPrinterTelemetry(): PrinterTelemetry {
  return cached;
}

/**
 * Performs a fast, ink-free status query directly against Win32_Printer.
 * Completes in < 1 s on most systems — intentionally skips all ink-detection
 * strategies so the mid-job watchdog can poll tightly without blocking.
 *
 * Unlike getPrinterTelemetry() this always issues a live PowerShell call
 * instead of returning the 30 s cached value.
 */
export async function queryLivePrinterStatus(): Promise<{
  connected: boolean;
  status: string;
  statusFlags: string[];
}> {
  try {
    const json = await runPowerShell(
      `Get-CimInstance -ClassName Win32_Printer ` +
        `| Where-Object {$_.Default -eq $true} ` +
        `| Select-Object PrinterStatus, PrinterState ` +
        `| ConvertTo-Json -Depth 2`,
      5_000,
    );

    if (!json) {
      return {
        connected: false,
        status: 'No default printer',
        statusFlags: [],
      };
    }

    const raw = JSON.parse(json) as {
      PrinterStatus: number;
      PrinterState: number;
    };
    const statusFlags = parsePrinterStateFlags(raw.PrinterState);
    const status = humanStatusFromFlags(statusFlags, raw.PrinterStatus);
    return { connected: true, status, statusFlags };
  } catch {
    return { connected: false, status: 'Error', statusFlags: [] };
  }
}

// ── Main telemetry query ─────────────────────────────────────────

async function queryPrinterTelemetry(): Promise<PrinterTelemetry> {
  const lastCheckedAt = new Date().toISOString();

  // 1) Fetch default printer basic info
  let printerInfo: {
    Name: string;
    DriverName: string;
    PortName: string;
    PrinterStatus: number;
    PrinterState: number;
  } | null = null;

  try {
    const json = await runPowerShell(
      `Get-CimInstance -ClassName Win32_Printer ` +
        `| Where-Object {$_.Default -eq $true} ` +
        `| Select-Object Name, DriverName, PortName, PrinterStatus, PrinterState ` +
        `| ConvertTo-Json -Depth 2`,
    );

    if (!json) {
      return noDefaultPrinter(lastCheckedAt);
    }

    printerInfo = JSON.parse(json);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[PRINTER-STATUS] ⚠ Could not query printer: ${msg}`);
    return {
      connected: false,
      name: null,
      driverName: null,
      portName: null,
      connectionType: 'unknown',
      status: 'Error',
      statusFlags: [],
      ink: [],
      inkDetectionMethod: 'none',
      lastCheckedAt,
      lastError: msg,
    };
  }

  if (!printerInfo) return noDefaultPrinter(lastCheckedAt);

  const statusFlags = parsePrinterStateFlags(printerInfo.PrinterState);
  const status = humanStatusFromFlags(statusFlags, printerInfo.PrinterStatus);
  const connectionType = detectConnectionType(printerInfo.PortName);

  // 2) Attempt ink detection with a prioritized strategy chain
  const { ink, method } = await detectInkLevels(
    printerInfo.Name,
    printerInfo.DriverName,
    printerInfo.PortName,
    printerInfo.PrinterState,
    printerInfo.PrinterStatus,
    connectionType,
  );

  return {
    connected: true,
    name: printerInfo.Name,
    driverName: printerInfo.DriverName,
    portName: printerInfo.PortName,
    connectionType,
    status,
    statusFlags,
    ink,
    inkDetectionMethod: method,
    lastCheckedAt,
    lastError: null,
  };
}

function noDefaultPrinter(lastCheckedAt: string): PrinterTelemetry {
  return {
    connected: false,
    name: null,
    driverName: null,
    portName: null,
    connectionType: 'unknown',
    status: 'No default printer',
    statusFlags: [],
    ink: [],
    inkDetectionMethod: 'none',
    lastCheckedAt,
    lastError: null,
  };
}

// ── Ink detection strategy chain ────────────────────────────────

interface InkResult {
  ink: InkLevel[];
  method: PrinterTelemetry['inkDetectionMethod'];
}

async function detectInkLevels(
  printerName: string,
  driverName: string,
  portName: string,
  printerState: number,
  printerStatus: number,
  connectionType: PrinterTelemetry['connectionType'],
): Promise<InkResult> {
  // Strategy 1 – SNMP Printer MIB (most accurate for network/WSD printers)
  if (connectionType === 'network' || connectionType === 'wsd') {
    const ip =
      extractIpFromPortName(portName) ??
      (await resolveWsdPrinterIp(printerName));

    if (ip) {
      const snmp = await querySnmpPrinterMib(ip);
      if (snmp.length > 0) return { ink: snmp, method: 'snmp' };
    }
  }

  // Strategy 2 – Vendor-specific WMI namespaces (USB + some network)
  const vendorWmi = await queryVendorWmiInk(printerName, driverName);
  if (vendorWmi.length > 0) return { ink: vendorWmi, method: 'vendor-wmi' };

  // Strategy 3 – Get-PrinterProperty (works for some USB + network drivers)
  const prop = await queryPrinterPropertyInk(printerName);
  if (prop.length > 0) return { ink: prop, method: 'printer-property' };

  // Strategy 4 – DetectedErrorState / PrinterState bitmask flags
  const errorState = inferInkFromErrorState(printerState, printerStatus);
  if (errorState.length > 0) return { ink: errorState, method: 'error-state' };

  // Nothing worked — return unknown
  return {
    ink: [{ name: 'Ink / Toner', level: null, status: 'unknown' }],
    method: 'none',
  };
}

// ── Strategy 1: SNMP Printer MIB v1 ────────────────────────────
//
// Queries prtMarkerSupplies table (RFC 3805 / Printer MIB v2).
// OID prefix: 1.3.6.1.2.1.43.11.1.1
//   .6.1.x  – prtMarkerSuppliesDescription (string)
//   .8.1.x  – prtMarkerSuppliesMaxCapacity  (-1 = unlimited/unknown)
//   .9.1.x  – prtMarkerSuppliesLevel        (-1 = unknown, -2 = ≥ some)
//   .10.1.x – prtMarkerSuppliesClass        (1 = consumed, 3 = waste)
//
// Uses a self-contained PowerShell UDP SNMP GET-NEXT walk so no extra
// npm packages are required.  Times out to avoid blocking the chain.

const SNMP_PS_SCRIPT = (ip: string) =>
  `
$ErrorActionPreference = 'Stop'
$timeout = 3000
$community = [System.Text.Encoding]::ASCII.GetBytes('public')
$oidBase = @(1,3,6,1,2,1,43,11,1,1)

function Encode-OID([int[]]$oid) {
  $body = @(0x2b) # 1.3 encoded
  $rest = $oid[2..($oid.Length-1)]
  foreach ($v in $rest) {
    if ($v -lt 128) { $body += [byte]$v }
    else {
      $bytes = [System.Collections.Generic.List[byte]]::new()
      $tmp = $v
      $bytes.Insert(0, [byte]($tmp -band 0x7f))
      $tmp = $tmp -shr 7
      while ($tmp -gt 0) { $bytes.Insert(0, [byte](0x80 -bor ($tmp -band 0x7f))); $tmp = $tmp -shr 7 }
      $body += $bytes.ToArray()
    }
  }
  return ,$body
}

function Build-GetRequest([int[]]$oid) {
  $oidBytes = Encode-OID $oid
  $oidTlv   = @(0x06, $oidBytes.Count) + $oidBytes
  $nullTlv  = @(0x05, 0x00)
  $varBind  = @(0x30, ($oidTlv.Count + $nullTlv.Count)) + $oidTlv + $nullTlv
  $varList  = @(0x30, $varBind.Count) + $varBind
  $reqId    = @(0x02, 0x01, 0x01)   # integer 1
  $errStat  = @(0x02, 0x01, 0x00)
  $errIdx   = @(0x02, 0x01, 0x00)
  $pduBody  = $reqId + $errStat + $errIdx + $varList
  $pdu      = @(0xa0, $pduBody.Count) + $pduBody  # GetRequest PDU
  $commTlv  = @(0x04, $community.Count) + $community
  $version  = @(0x02, 0x01, 0x00)  # version 1
  $msgBody  = $version + $commTlv + $pdu
  return [byte[]](@(0x30, $msgBody.Count) + $msgBody)
}

$results = [System.Collections.Generic.List[hashtable]]::new()
$udp = [System.Net.Sockets.UdpClient]::new()
try {
  $udp.Client.ReceiveTimeout = $timeout
  $ep = [System.Net.IPEndPoint]::new([System.Net.IPAddress]::Parse('${ip}'), 161)

  # Probe columns: description=6, maxCapacity=8, level=9, class=10
  foreach ($col in @(6, 8, 9, 10)) {
    for ($idx = 1; $idx -le 8; $idx++) {
      $oid = $oidBase + @($col, 1, $idx)
      $pkt = Build-GetRequest $oid
      try {
        [void]$udp.Send($pkt, $pkt.Length, $ep)
        $resp = $udp.Receive([ref]$ep)
        # Extract value from response (very simplified; works for integer + octet-string)
        # Walk to end of PDU to find value TLV
        $i = 0
        # Skip outer SEQUENCE, version, community, PDU header to reach varBindList
        # For our purposes parse last TLV in the packet
        $i = $resp.Length - 1
        # Find last value: scan backwards for the value TLV after the OID
        # Simpler: search for our OID echo, then the NULL, then the value
        $valType = $resp[$resp.Length - ($resp[$resp.Length-1] + 2 + 1 )]
        $valLen  = $resp[$resp.Length - ($resp[$resp.Length-1] + 2)]
        $valBytes = $resp[($resp.Length - $resp[$resp.Length-1])..($resp.Length-1)]
        
        if ($valType -eq 0x02 -or $valType -eq 0x41 -or $valType -eq 0x42) {
          # INTEGER or Gauge32 or Counter32
          $num = 0
          foreach ($b in $valBytes) { $num = ($num -shl 8) -bor $b }
          [void]$results.Add(@{ col=$col; idx=$idx; type='int'; value=$num })
        } elseif ($valType -eq 0x04) {
          # OCTET STRING
          $str = [System.Text.Encoding]::UTF8.GetString($valBytes).Trim([char]0)
          [void]$results.Add(@{ col=$col; idx=$idx; type='str'; value=$str })
        }
      } catch { <# timeout / no response for this index — stop column scan #>; break }
    }
  }
} finally { $udp.Close() }

$results | ConvertTo-Json -Depth 3
`.trim();

async function querySnmpPrinterMib(ip: string): Promise<InkLevel[]> {
  try {
    const json = await runPowerShell(SNMP_PS_SCRIPT(ip), 20_000);
    if (!json || json === 'null') return [];

    const raw = JSON.parse(json);
    const rows: { col: number; idx: number; type: string; value: unknown }[] =
      Array.isArray(raw) ? raw : [raw];

    // Index by [col][idx]
    const table: Record<number, Record<number, unknown>> = {};
    for (const row of rows) {
      table[row.col] ??= {};
      table[row.col][row.idx] = row.value;
    }

    const result: InkLevel[] = [];
    const indices = Object.keys(table[9] ?? {}).map(Number);

    for (const idx of indices) {
      const supplyClass = Number(table[10]?.[idx] ?? 1);
      if (supplyClass === 3) continue; // skip waste tanks

      const raw_max = Number(table[8]?.[idx] ?? -1);
      const raw_level = Number(table[9]?.[idx] ?? -1);
      const desc = String(table[6]?.[idx] ?? `Supply ${idx}`);

      let level: number | null = null;
      if (raw_level >= 0 && raw_max > 0) {
        level = Math.round((raw_level / raw_max) * 100);
      } else if (raw_level === -2) {
        // at-least-some — treat as low-confidence ok
        level = null;
      }

      result.push({
        name: desc,
        level,
        status: inkStatusFromLevel(level),
        colorHint: colorHintFromName(desc),
      });
    }

    return result;
  } catch (err) {
    console.warn(
      '[PRINTER-STATUS] SNMP query failed:',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** For WSD printers, resolve the underlying IP from the WSD port definition. */
async function resolveWsdPrinterIp(
  printerName: string,
): Promise<string | null> {
  try {
    const escapedName = printerName.replace(/'/g, "''");
    const out = await runPowerShell(
      `$port = (Get-CimInstance -ClassName Win32_Printer -Filter "Name='${escapedName}'").PortName; ` +
        `$wsd  = Get-PnpDevice | Where-Object { $_.FriendlyName -match [regex]::Escape('${escapedName}') } ` +
        `        | Get-PnpDeviceProperty -KeyName 'DEVPKEY_Device_LocationInfo' ` +
        `        | Select-Object -ExpandProperty Data -ErrorAction SilentlyContinue; ` +
        `$ip   = ([regex]::Match($wsd, '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b')).Value; ` +
        `if ($ip) { $ip } else { '' }`,
      10_000,
    );
    const trimmed = out.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

// ── Strategy 2: Vendor-specific WMI namespaces ──────────────────
//
// HP:     root\HP  (HPStatus, HPInkLevel)
// Epson:  WMI via Epson BIDI service → Get-PrinterProperty
// Canon:  root\Canon (not universally available)
// Brother: Get-PrinterProperty with vendor keys

async function queryVendorWmiInk(
  printerName: string,
  driverName: string,
): Promise<InkLevel[]> {
  const driver = driverName.toLowerCase();

  if (driver.includes('hp') || driver.includes('hewlett')) {
    const hp = await queryHpWmi(printerName);
    if (hp.length > 0) return hp;
  }

  if (driver.includes('epson')) {
    const epson = await queryEpsonBidi(printerName);
    if (epson.length > 0) return epson;
  }

  if (driver.includes('canon')) {
    const canon = await queryCanonWmi(printerName);
    if (canon.length > 0) return canon;
  }

  if (driver.includes('brother')) {
    const brother = await queryBrotherProperty(printerName);
    if (brother.length > 0) return brother;
  }

  return [];
}

async function queryHpWmi(printerName: string): Promise<InkLevel[]> {
  try {
    const escapedName = printerName.replace(/'/g, "''");
    // HP exposes ink via root\HP namespace on some models
    const json = await runPowerShell(
      `$ns = 'root\\HP'; ` +
        `if (-not (Get-WmiObject -Namespace $ns -List 2>$null)) { return '[]' }; ` +
        `$ink = Get-WmiObject -Namespace $ns -Query ` +
        `  "SELECT * FROM HP_InkLevel WHERE PrinterName='${escapedName}'" ` +
        `  -ErrorAction SilentlyContinue; ` +
        `if (-not $ink) { ` +
        `  $ink = Get-WmiObject -Namespace $ns -Class HP_PrinterStatus ` +
        `    -ErrorAction SilentlyContinue; ` +
        `}; ` +
        `if ($ink) { $ink | Select-Object Name,Level,MaxLevel,Color | ConvertTo-Json -Depth 2 } else { '[]' }`,
      10_000,
    );

    return parseVendorInkJson(json);
  } catch {
    return [];
  }
}

async function queryEpsonBidi(printerName: string): Promise<InkLevel[]> {
  try {
    const escapedName = printerName.replace(/'/g, "''");
    // Epson bidirectional driver exposes ink via Get-PrinterProperty or
    // a local COM object.  Try the broader property list first.
    const json = await runPowerShell(
      `Get-PrinterProperty -PrinterName '${escapedName}' 2>$null ` +
        `| Where-Object { $_.PropertyName -match 'Ink|Supply|Level|Cartridge|Color|Cyan|Magenta|Yellow|Black|Gray|Photo' } ` +
        `| Select-Object PropertyName,Value | ConvertTo-Json -Depth 2`,
      10_000,
    );

    return parsePrinterPropertyJson(json);
  } catch {
    return [];
  }
}

async function queryCanonWmi(printerName: string): Promise<InkLevel[]> {
  try {
    const escapedName = printerName.replace(/'/g, "''");
    const json = await runPowerShell(
      `$ns = 'root\\Canon'; ` +
        `if (-not (Get-WmiObject -Namespace $ns -List 2>$null)) { return '[]' }; ` +
        `$ink = Get-WmiObject -Namespace $ns -Class Canon_InkLevel ` +
        `  -ErrorAction SilentlyContinue ` +
        `  | Where-Object { $_.PrinterName -eq '${escapedName}' }; ` +
        `if ($ink) { $ink | Select-Object InkName,InkLevel,MaxInkLevel | ConvertTo-Json -Depth 2 } else { '[]' }`,
      10_000,
    );

    // Remap Canon's property names
    if (!json || json === '[]') return [];
    const raw = JSON.parse(json);
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map((i) => {
      const lvl = parsePercentLevel(i.InkLevel, i.MaxInkLevel);
      const name = String(i.InkName ?? 'Ink');
      return {
        name,
        level: lvl,
        status: inkStatusFromLevel(lvl),
        colorHint: colorHintFromName(name),
      };
    });
  } catch {
    return [];
  }
}

async function queryBrotherProperty(printerName: string): Promise<InkLevel[]> {
  try {
    const escapedName = printerName.replace(/'/g, "''");
    const json = await runPowerShell(
      `Get-PrinterProperty -PrinterName '${escapedName}' 2>$null ` +
        `| Where-Object { $_.PropertyName -match 'Ink|Toner|Supply|Level|BK|CY|MG|YL' } ` +
        `| Select-Object PropertyName,Value | ConvertTo-Json -Depth 2`,
      10_000,
    );

    return parsePrinterPropertyJson(json);
  } catch {
    return [];
  }
}

// ── Strategy 3: Get-PrinterProperty (generic) ───────────────────

async function queryPrinterPropertyInk(
  printerName: string,
): Promise<InkLevel[]> {
  try {
    const escapedName = printerName.replace(/'/g, "''");
    const json = await runPowerShell(
      `Get-PrinterProperty -PrinterName '${escapedName}' 2>$null ` +
        `| Where-Object { $_.PropertyName -match 'InkLevel|TonerLevel|Supply|Cartridge|Ink|Toner' } ` +
        `| Select-Object PropertyName,Value | ConvertTo-Json -Depth 2`,
      8_000,
    );

    return parsePrinterPropertyJson(json);
  } catch {
    return [];
  }
}

// ── Strategy 4: Infer from error state bits ─────────────────────

function inferInkFromErrorState(
  printerState: number,
  _printerStatus: number,
): InkLevel[] {
  const tonerLow = (printerState & 0x00040000) !== 0;
  const noToner = (printerState & 0x00080000) !== 0;
  if (noToner) return [{ name: 'Toner / Ink', level: 0, status: 'empty' }];
  if (tonerLow) return [{ name: 'Toner / Ink', level: null, status: 'low' }];
  return [];
}

// ── Shared parsers ───────────────────────────────────────────────

function parseVendorInkJson(json: string): InkLevel[] {
  if (!json || json === '[]' || json === 'null') return [];
  try {
    const raw = JSON.parse(json);
    const items = Array.isArray(raw) ? raw : [raw];
    const result: InkLevel[] = [];
    for (const item of items) {
      const name = String(
        item.Name ?? item.Color ?? item.InkName ?? 'Supply',
      ).trim();
      const lvl = parsePercentLevel(
        item.Level ?? item.InkLevel,
        item.MaxLevel ?? item.MaxInkLevel ?? 100,
      );
      result.push({
        name: name || 'Supply',
        level: lvl,
        status: inkStatusFromLevel(lvl),
        colorHint: colorHintFromName(name),
      });
    }
    return result;
  } catch {
    return [];
  }
}

function parsePrinterPropertyJson(json: string): InkLevel[] {
  if (!json || json === '[]' || json === 'null') return [];
  try {
    const raw = JSON.parse(json);
    const items = Array.isArray(raw) ? raw : [raw];
    const result: InkLevel[] = [];

    for (const item of items) {
      const rawName = String(item.PropertyName ?? 'Supply');
      const name = rawName
        .replace(/Level$/i, '')
        .replace(/^Config:/i, '')
        .replace(/InkLevel/i, 'Ink')
        .trim();

      const numVal = Number(item.Value);
      const level =
        Number.isFinite(numVal) && numVal >= 0 && numVal <= 100 ? numVal : null;

      result.push({
        name: name || 'Supply',
        level,
        status: inkStatusFromLevel(level),
        colorHint: colorHintFromName(name),
      });
    }
    return result;
  } catch {
    return [];
  }
}

// ── Utilities ────────────────────────────────────────────────────

function parsePercentLevel(level: unknown, max: unknown = 100): number | null {
  const l = Number(level);
  const m = Number(max);
  if (!Number.isFinite(l) || l < 0) return null;
  if (m > 0 && m !== 100) return Math.round((l / m) * 100);
  if (l >= 0 && l <= 100) return l;
  return null;
}

function inkStatusFromLevel(level: number | null): InkLevel['status'] {
  if (level === null) return 'unknown';
  if (level <= 0) return 'empty';
  if (level <= 15) return 'low';
  return 'ok';
}

/**
 * Forces an immediate re-query of the default Windows printer, bypassing the
 * 30-second background poll interval.
 *
 * Use this after a printer swap, driver re-registration, or USB reconnect so
 * the admin panel reflects the new hardware state without waiting for the next
 * automatic refresh cycle.
 *
 * Safe to call concurrently — if a background refresh is already running it is
 * allowed to finish first (we await it via the shared `refreshing` guard),
 * then we run a fresh query on top so the caller always gets a post-action
 * snapshot, not a stale one.
 *
 * @returns The freshly-queried PrinterTelemetry object (also updates the cache
 *          so subsequent `getPrinterTelemetry()` calls see the same value).
 */
export async function refreshPrinterTelemetry(): Promise<PrinterTelemetry> {
  // If a refresh is already in flight, wait for it to settle before we
  // fire our own so we don't race against it.
  while (refreshing) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }

  refreshing = true;
  try {
    cached = await queryPrinterTelemetry();
  } catch (err: unknown) {
    cached = {
      connected: false,
      name: null,
      driverName: null,
      portName: null,
      connectionType: 'unknown',
      status: 'Error',
      statusFlags: [],
      ink: [],
      inkDetectionMethod: 'none',
      lastCheckedAt: new Date().toISOString(),
      lastError: err instanceof Error ? err.message : String(err),
    };
  } finally {
    refreshing = false;
  }

  return cached;
}
