import { SummaryResponse, apiFetch, setMessage, initAuth } from '../shared';

// ── DOM refs ────────────────────────────────────────

const serverStatus = document.getElementById('serverStatus') as HTMLElement;
const serverBadge = document.getElementById(
  'serverBadge',
) as HTMLElement | null;
const hostStatus = document.getElementById('hostStatus') as HTMLElement;
const wifiStatus = document.getElementById('wifiStatus') as HTMLElement;
const wifiBadge = document.getElementById('wifiBadge') as HTMLElement | null;
const serialStatus = document.getElementById('serialStatus') as HTMLElement;
const serialBadge = document.getElementById(
  'serialBadge',
) as HTMLElement | null;
const serialPortStatus = document.getElementById(
  'serialPortStatus',
) as HTMLElement;
const hopperStatus = document.getElementById('hopperStatus') as HTMLElement;
const hopperBadge = document.getElementById(
  'hopperBadge',
) as HTMLElement | null;
const hopperPortStatus = document.getElementById(
  'hopperPortStatus',
) as HTMLElement;
const hopperLastStatus = document.getElementById(
  'hopperLastStatus',
) as HTMLElement;

const printerStatus = document.getElementById('printerStatus') as HTMLElement;
const printerBadge = document.getElementById(
  'printerBadge',
) as HTMLElement | null;
const printerNameEl = document.getElementById('printerName') as HTMLElement;
const inkGrid = document.getElementById('inkGrid') as HTMLElement;

const refreshBtn = document.getElementById('refreshBtn') as HTMLButtonElement;
const selfTestBtn = document.getElementById('selfTestBtn') as HTMLButtonElement;

// ── New printer-detail element refs ──────────────────────────────────────────

const printerIconWrap = document.getElementById(
  'printerIconWrap',
) as HTMLElement | null;
const printerDriver = document.getElementById(
  'printerDriver',
) as HTMLElement | null;
const printerPort = document.getElementById(
  'printerPort',
) as HTMLElement | null;
const printerConnectionType = document.getElementById(
  'printerConnectionType',
) as HTMLElement | null;
const printerUpdatedAt = document.getElementById(
  'printerUpdatedAt',
) as HTMLElement | null;

// ── New action button refs ────────────────────────────────────────────────────

const reDetectBtn = document.getElementById(
  'reDetectBtn',
) as HTMLButtonElement | null;
const testPrintBtn = document.getElementById(
  'testPrintBtn',
) as HTMLButtonElement | null;

// ── Spooler alert refs ────────────────────────────────────────────────────────

const spoolerAlert = document.getElementById(
  'spoolerAlert',
) as HTMLElement | null;
const spoolerAlertMsg = document.getElementById(
  'spoolerAlertMsg',
) as HTMLElement | null;
const spoolerAlertDismiss = document.getElementById(
  'spoolerAlertDismiss',
) as HTMLButtonElement | null;

let refreshTimer: number | null = null;

// ── Printer telemetry type (extended fields from Phase 4) ─────────────────────

interface PrinterTelemetryExt {
  name?: string | null;
  status: string;
  connected: boolean;
  driverName?: string | null;
  portName?: string | null;
  connectionType?: string | null;
  ink?: Array<{ name: string; level: number | null; status: string }>;
}

type PrinterTelemetryPatch = Partial<PrinterTelemetryExt>;

let lastPrinterSnapshot: PrinterTelemetryExt | null = null;

function mergePrinterSnapshot(
  patch: PrinterTelemetryPatch,
): PrinterTelemetryExt | null {
  if (
    !lastPrinterSnapshot &&
    (patch.connected === undefined || patch.status === undefined)
  ) {
    return null;
  }

  const merged: PrinterTelemetryExt = {
    connected: patch.connected ?? lastPrinterSnapshot?.connected ?? false,
    status: patch.status ?? lastPrinterSnapshot?.status ?? 'Unknown',
    name: lastPrinterSnapshot?.name,
    driverName: lastPrinterSnapshot?.driverName,
    portName: lastPrinterSnapshot?.portName,
    connectionType: lastPrinterSnapshot?.connectionType,
    ink: lastPrinterSnapshot?.ink,
  };

  if (patch.name !== undefined) merged.name = patch.name;
  if (patch.driverName !== undefined) merged.driverName = patch.driverName;
  if (patch.portName !== undefined) merged.portName = patch.portName;
  if (patch.connectionType !== undefined) {
    merged.connectionType = patch.connectionType;
  }
  if (patch.connected !== undefined) merged.connected = patch.connected;
  if (patch.status !== undefined) merged.status = patch.status;
  if (patch.ink !== undefined) merged.ink = patch.ink;

  return merged;
}

// ── Helper: apply extended printer fields ─────────────────────────────────────

function applyPrinterExt(p: PrinterTelemetryExt): void {
  // Icon colouring
  if (printerIconWrap) {
    printerIconWrap.dataset.connected = String(p.connected);
  }

  // Extended metadata
  if (printerDriver) {
    printerDriver.textContent = p.driverName ?? '—';
  }
  if (printerPort) {
    printerPort.textContent = p.portName ?? '—';
  }
  if (printerConnectionType) {
    printerConnectionType.textContent = p.connectionType ?? '—';
  }
  if (printerUpdatedAt) {
    printerUpdatedAt.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }
}

// ── Existing applySystem function (unchanged except printer ext call added) ───

function applySystem(summary: SummaryResponse): void {
  serverStatus.textContent = summary.status.serverRunning ? 'Running' : 'Down';
  serverBadge?.setAttribute('data-ok', String(summary.status.serverRunning));
  hostStatus.textContent = summary.status.host;
  wifiStatus.textContent = summary.status.wifiActive ? 'Active' : 'Inactive';
  wifiBadge?.setAttribute('data-ok', String(summary.status.wifiActive));
  serialStatus.textContent = summary.status.serial.connected
    ? 'Connected'
    : 'Disconnected';
  serialBadge?.setAttribute('data-ok', String(summary.status.serial.connected));
  serialPortStatus.textContent = summary.status.serial.portPath ?? '—';

  const hopper = summary.status.hopper;
  const hopperHealthy =
    hopper.connected && !hopper.pending && !hopper.lastError;
  hopperStatus.textContent = hopper.pending
    ? 'Busy'
    : hopper.connected
      ? 'Ready'
      : 'Unavailable';
  hopperBadge?.setAttribute('data-ok', String(hopperHealthy));
  hopperPortStatus.textContent = hopper.portPath ?? '—';
  hopperLastStatus.textContent = hopper.lastError
    ? hopper.lastError
    : hopper.lastSuccessAt
      ? `Last OK: ${new Date(hopper.lastSuccessAt).toLocaleString()}`
      : 'No recent activity';

  // Printer — basic fields (same as before)
  const p = summary.status.printer;
  printerStatus.textContent = p.connected ? p.status : 'Not Found';
  printerBadge?.setAttribute('data-ok', String(p.connected));
  printerNameEl.textContent = p.name ?? '—';

  // Printer — extended fields (opt-in; no error if fields absent)
  applyPrinterExt(p as PrinterTelemetryExt);

  // Ink / toner levels (unchanged)
  inkGrid.innerHTML = '';
  if (p.ink.length === 0) {
    inkGrid.innerHTML = `<div class="ink-empty">No supply data available</div>`;
    return;
  }

  for (const ink of p.ink) {
    const bar = document.createElement('div');
    bar.className = 'ink-item';

    const pct = ink.level !== null ? ink.level : 0;
    const statusCls = `ink-bar--${ink.status}`;
    const label =
      ink.level !== null
        ? `${ink.level}%`
        : ink.status === 'unknown'
          ? 'N/A'
          : ink.status;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'ink-item__name';
    nameSpan.textContent = ink.name;

    const barDiv = document.createElement('div');
    barDiv.className = 'ink-bar';
    const fillDiv = document.createElement('div');
    fillDiv.className = `ink-bar__fill ${statusCls}`;
    fillDiv.style.width = `${pct}%`;
    barDiv.appendChild(fillDiv);

    const labelSpan = document.createElement('span');
    labelSpan.className = `ink-item__label ink-item__label--${ink.status}`;
    labelSpan.textContent = label;

    bar.append(nameSpan, barDiv, labelSpan);

    inkGrid.appendChild(bar);
  }
}

// ── Data loader (unchanged) ───────────────────────────────────────────────────

async function loadData(): Promise<void> {
  const res = await apiFetch('/api/admin/summary');
  if (!res.ok) {
    if (res.status === 401) throw new Error('Invalid admin PIN.');
    throw new Error('Failed to load system data.');
  }
  const summary = (await res.json()) as SummaryResponse;
  applySystem(summary);
}

// ── Existing button handlers (unchanged) ──────────────────────────────────────

refreshBtn.addEventListener('click', () => {
  setMessage('Refreshing...');
  void loadData()
    .then(() => setMessage('System refreshed.'))
    .catch((e: unknown) =>
      setMessage(e instanceof Error ? e.message : 'Refresh failed.'),
    );
});

selfTestBtn.addEventListener('click', () => {
  selfTestBtn.disabled = true;
  setMessage('Running hopper self-test...');
  void apiFetch('/api/admin/hopper/self-test', { method: 'POST' })
    .then(async (res) => {
      const payload = (await res.json()) as { ok: boolean; message: string };
      if (!res.ok) {
        setMessage(payload.message || 'Hopper self-test failed.');
      } else {
        setMessage(payload.message || 'Hopper self-test passed.');
      }
      await loadData();
    })
    .catch((e: unknown) => {
      setMessage(e instanceof Error ? e.message : 'Self-test failed.');
    })
    .finally(() => {
      selfTestBtn.disabled = false;
    });
});

// ── New: Re-detect Printer ────────────────────────────────────────────────────

reDetectBtn?.addEventListener('click', () => {
  reDetectBtn.disabled = true;
  setMessage('Re-detecting printer...');

  void apiFetch('/api/admin/printer/re-detect', { method: 'POST' })
    .then(async (res) => {
      const body = (await res.json()) as {
        ok: boolean;
        printer: PrinterTelemetryExt;
      };
      if (!res.ok || !body.ok) {
        throw new Error(
          'Re-detection failed. Ensure a default printer is set in Windows.',
        );
      }
      // Update the card immediately with the fresh telemetry
      const p = body.printer;
      lastPrinterSnapshot = { ...p };
      printerStatus.textContent = p.connected ? p.status : 'Not Found';
      printerBadge?.setAttribute('data-ok', String(p.connected));
      printerNameEl.textContent = p.name ?? '—';
      applyPrinterExt(p);
      setMessage(`Re-detected: ${p.name ?? 'unknown'}`);
    })
    .catch((e: unknown) =>
      setMessage(e instanceof Error ? e.message : 'Re-detection failed.'),
    )
    .finally(() => {
      reDetectBtn.disabled = false;
    });
});

// ── New: Send Test Page ───────────────────────────────────────────────────────

testPrintBtn?.addEventListener('click', () => {
  if (!window.confirm('Send a diagnostic test page to the printer?')) return;

  testPrintBtn.disabled = true;
  setMessage('Sending test page...');

  void apiFetch('/api/admin/printer/test-print', { method: 'POST' })
    .then(async (res) => {
      const body = (await res.json()) as {
        ok: boolean;
        message?: string;
        error?: string;
        printerName?: string;
      };
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? 'Printer unavailable or not connected.');
      }
      setMessage(body.message ?? 'Test page sent successfully.');
    })
    .catch((e: unknown) =>
      setMessage(e instanceof Error ? e.message : 'Test print failed.'),
    )
    .finally(() => {
      testPrintBtn.disabled = false;
    });
});

// ── New: Spooler failure alert dismiss ────────────────────────────────────────

spoolerAlertDismiss?.addEventListener('click', () => {
  spoolerAlert?.classList.add('hidden');
  if (spoolerAlertMsg) spoolerAlertMsg.textContent = '';
});

// ── Socket.IO — live printer updates ─────────────────────────────────────────

// socket.io client is loaded via <script src="/socket.io/socket.io.js">
declare const io: (opts?: {
  auth?: Record<string, string>;
  reconnectionDelay?: number;
}) => {
  on(event: string, cb: (...args: unknown[]) => void): void;
  disconnect(): void;
};

let socket: ReturnType<typeof io> | null = null;

function connectSocket(): void {
  // initAuth stores the PIN in sessionStorage under the key used by shared.ts
  const pin = sessionStorage.getItem('adminPin') ?? '';
  socket = io({ auth: { pin }, reconnectionDelay: 2000 });

  // Live printer card update (emitted by Phase 2 health monitor)
  socket.on('printerStatusChanged', (payload: unknown) => {
    const next = mergePrinterSnapshot(payload as PrinterTelemetryPatch);
    if (!next) return;

    lastPrinterSnapshot = next;
    printerStatus.textContent = next.connected ? next.status : 'Not Found';
    printerBadge?.setAttribute('data-ok', String(next.connected));
    if (next.name !== undefined) printerNameEl.textContent = next.name ?? '—';
    applyPrinterExt(next);
    setMessage(`Printer: ${next.status}`);
  });

  // Spooler failure banner (emitted by Phase 3 spooler monitor)
  socket.on('printerSpoolerFailure', (payload: unknown) => {
    const ev = payload as {
      jobStatus: string;
      chargedAmount: number;
      refundId: string;
      pagesPrinted: number;
      printerName: string;
    };
    const pagesStr =
      ev.pagesPrinted > 0 ? `, ${ev.pagesPrinted} page(s) printed` : '';
    if (spoolerAlertMsg) {
      spoolerAlertMsg.textContent =
        `Spooler reported "${ev.jobStatus}" on "${ev.printerName}"${pagesStr}. ` +
        `₱${ev.chargedAmount.toFixed(2)} pending refund created (ID: ${ev.refundId.slice(0, 8)}…).`;
    }
    spoolerAlert?.classList.remove('hidden');
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

initAuth(async () => {
  await loadData();
  connectSocket();

  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => void loadData(), 10_000);
});

window.addEventListener('pagehide', () => {
  socket?.disconnect();
});
