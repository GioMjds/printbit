import {
  SummaryResponse,
  apiFetch,
  setMessage,
  initAuth,
  updateSidebarBadges,
} from '../shared';
import {
  buildPrinterSelectionOptions,
  type PrinterSelectionInput,
} from './printer-selection';
import { attachSubsystemCardToggles } from './subsystem-toggle';

// ── DOM refs ────────────────────────────────────────

const serverStatus = document.getElementById('serverStatus') as HTMLElement;
const serverBadge = document.getElementById(
  'serverBadge',
) as HTMLElement | null;
const hostStatus = document.getElementById('hostStatus') as HTMLElement;
const wifiStatus = document.getElementById('wifiStatus') as HTMLElement;
const wifiBadge = document.getElementById('wifiBadge') as HTMLElement | null;

const printerStatus = document.getElementById('printerStatus') as HTMLElement;
const printerBadge = document.getElementById(
  'printerBadge',
) as HTMLElement | null;
const printerNameEl = document.getElementById('printerName') as HTMLElement;

const refreshBtn = document.getElementById('refreshBtn') as HTMLButtonElement;

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
const printerInkDetectionMethod = document.getElementById(
  'printerInkDetectionMethod',
) as HTMLElement | null;
const printerInkTelemetryStatus = document.getElementById(
  'printerInkTelemetryStatus',
) as HTMLElement | null;

// ── New action button refs ────────────────────────────────────────────────────

const reDetectBtn = document.getElementById(
  'reDetectBtn',
) as HTMLButtonElement | null;
const restartSpoolerBtn = document.getElementById(
  'restartSpoolerBtn',
) as HTMLButtonElement | null;
const testPrintBtn = document.getElementById(
  'testPrintBtn',
) as HTMLButtonElement | null;
const restartWindowsBtn = document.getElementById(
  'restartWindowsBtn',
) as HTMLButtonElement | null;
const shutdownWindowsBtn = document.getElementById(
  'shutdownWindowsBtn',
) as HTMLButtonElement | null;
const printerSelection = document.getElementById(
  'printerSelection',
) as HTMLSelectElement | null;
const applyPrinterSelectionBtn = document.getElementById(
  'applyPrinterSelectionBtn',
) as HTMLButtonElement | null;
const printerSelectionHint = document.getElementById(
  'printerSelectionHint',
) as HTMLElement | null;

// ── Document Conversion element refs ──────────────────────────────────────────

const conversionIconWrap = document.getElementById(
  'conversionIconWrap',
) as HTMLElement | null;
const conversionStatus = document.getElementById(
  'conversionStatus',
) as HTMLElement | null;
const conversionEngine = document.getElementById(
  'conversionEngine',
) as HTMLElement | null;
const conversionUpdatedAt = document.getElementById(
  'conversionUpdatedAt',
) as HTMLElement | null;
const conversionBadge = document.getElementById(
  'conversionBadge',
) as HTMLElement | null;
const conversionExecutable = document.getElementById(
  'conversionExecutable',
) as HTMLElement | null;
const conversionPipe = document.getElementById(
  'conversionPipe',
) as HTMLElement | null;
const zombieTerminationStatus = document.getElementById(
  'zombieTerminationStatus',
) as HTMLElement | null;
const zombieProcessCount = document.getElementById(
  'zombieProcessCount',
) as HTMLElement | null;
const terminateZombiesBtn = document.getElementById(
  'terminateZombiesBtn',
) as HTMLButtonElement | null;
const toggleZombieTerminationBtn = document.getElementById(
  'toggleZombieTerminationBtn',
) as HTMLButtonElement | null;
const zombieToggleText = document.getElementById(
  'zombieToggleText',
) as HTMLElement | null;
const zombieToggleSubText = document.getElementById(
  'zombieToggleSubText',
) as HTMLElement | null;
const testConversionBtn = document.getElementById(
  'testConversionBtn',
) as HTMLButtonElement | null;

// ── Error simulation refs ────────────────────────────────────────────────────

const simLowInkBtn = document.getElementById(
  'simLowInkBtn',
) as HTMLButtonElement | null;
const simOutOfPaperBtn = document.getElementById(
  'simOutOfPaperBtn',
) as HTMLButtonElement | null;
const simAdfErrorBtn = document.getElementById(
  'simAdfErrorBtn',
) as HTMLButtonElement | null;
const simPaperJamBtn = document.getElementById(
  'simPaperJamBtn',
) as HTMLButtonElement | null;
const simInkOutBtn = document.getElementById(
  'simInkOutBtn',
) as HTMLButtonElement | null;
const simCoverOpenBtn = document.getElementById(
  'simCoverOpenBtn',
) as HTMLButtonElement | null;
const simOfflineBtn = document.getElementById(
  'simOfflineBtn',
) as HTMLButtonElement | null;
const simServiceBtn = document.getElementById(
  'simServiceBtn',
) as HTMLButtonElement | null;
const simOutputTrayBtn = document.getElementById(
  'simOutputTrayBtn',
) as HTMLButtonElement | null;
const clearPrinterErrorsBtn = document.getElementById(
  'clearPrinterErrorsBtn',
) as HTMLButtonElement | null;
const clearPaperJamBtn = document.getElementById(
  'clearPaperJamBtn',
) as HTMLButtonElement | null;
const simStatusBadge = document.getElementById(
  'simStatusBadge',
) as HTMLElement | null;

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
  inkDetectionMethod?: string | null;
  inkTelemetryAvailable?: boolean;
  inkTelemetryReason?: string | null;
  ink?: { name: string; level: number | null; status: string }[];
  targetPrinterName?: string | null;
  targetIsDefault?: boolean;
}

interface PrinterListResponse {
  printers: PrinterSelectionInput[];
  targetPrinterName: string | null;
}

type PrinterTelemetryPatch = Partial<PrinterTelemetryExt>;
type PrintLifecycleMode = 'print' | 'copy';
type PrintLifecycleState = 'queued' | 'processing' | 'printed' | 'failed';

interface PrintLifecyclePayload {
  mode: PrintLifecycleMode;
  state: PrintLifecycleState;
  transactionId: string | null;
  printerName: string | null;
  reason: string | null;
}

let lastPrinterSnapshot: PrinterTelemetryExt | null = null;
const BLOCKED_PRINTER_STATUSES = new Set([
  'offline',
  'error',
  'paper jam',
  'paper out',
  'door open',
  'user intervention required',
  'paused',
  'no default printer',
  'not connected',
  'unavailable',
  'not available',
]);

function isPrinterReadyForJobs(p: PrinterTelemetryExt): boolean {
  if (!p.connected) return false;
  return !BLOCKED_PRINTER_STATUSES.has(p.status.trim().toLowerCase());
}

function parsePrintLifecyclePayload(
  payload: unknown,
): PrintLifecyclePayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;

  const mode =
    record.mode === 'print' || record.mode === 'copy' ? record.mode : null;
  const state =
    record.state === 'queued' ||
    record.state === 'processing' ||
    record.state === 'printed' ||
    record.state === 'failed'
      ? record.state
      : null;
  if (!mode || !state) return null;

  return {
    mode,
    state,
    transactionId:
      typeof record.transactionId === 'string' ? record.transactionId : null,
    printerName: typeof record.printerName === 'string' ? record.printerName : null,
    reason: typeof record.reason === 'string' ? record.reason : null,
  };
}

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
    inkDetectionMethod: lastPrinterSnapshot?.inkDetectionMethod,
    inkTelemetryAvailable: lastPrinterSnapshot?.inkTelemetryAvailable,
    inkTelemetryReason: lastPrinterSnapshot?.inkTelemetryReason,
    ink: lastPrinterSnapshot?.ink,
    targetPrinterName: lastPrinterSnapshot?.targetPrinterName,
    targetIsDefault: lastPrinterSnapshot?.targetIsDefault,
  };

  if (patch.name !== undefined) merged.name = patch.name;
  if (patch.driverName !== undefined) merged.driverName = patch.driverName;
  if (patch.portName !== undefined) merged.portName = patch.portName;
  if (patch.connectionType !== undefined) {
    merged.connectionType = patch.connectionType;
  }
  if (patch.connected !== undefined) merged.connected = patch.connected;
  if (patch.status !== undefined) merged.status = patch.status;
  if (patch.inkDetectionMethod !== undefined) {
    merged.inkDetectionMethod = patch.inkDetectionMethod;
  }
  if (patch.inkTelemetryAvailable !== undefined) {
    merged.inkTelemetryAvailable = patch.inkTelemetryAvailable;
  }
  if (patch.inkTelemetryReason !== undefined) {
    merged.inkTelemetryReason = patch.inkTelemetryReason;
  }
  if (patch.targetPrinterName !== undefined) {
    merged.targetPrinterName = patch.targetPrinterName;
  }
  if (patch.targetIsDefault !== undefined) {
    merged.targetIsDefault = patch.targetIsDefault;
  }
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
  if (printerInkDetectionMethod) {
    printerInkDetectionMethod.textContent = p.inkDetectionMethod ?? 'none';
  }
  if (printerInkTelemetryStatus) {
    const targetLabel =
      p.targetPrinterName && !p.targetIsDefault
        ? ` (target: ${p.targetPrinterName})`
        : '';
    printerInkTelemetryStatus.textContent =
      p.inkTelemetryAvailable === true
        ? `Available${targetLabel}`
        : `${p.inkTelemetryReason ?? 'Unavailable'}${targetLabel}`;
  }
  if (printerUpdatedAt) {
    printerUpdatedAt.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }
}

// ── Helper: apply conversion fields ──────────────────────────────────────────

function applyConversion(c: SummaryResponse['status']['conversion']): void {
  if (!c) {
    if (conversionStatus) conversionStatus.textContent = 'Disabled';
    conversionBadge?.setAttribute('data-ok', 'false');
    if (conversionIconWrap) conversionIconWrap.dataset.connected = 'false';
    return;
  }

  const isOk = c.connected && c.status === 'operational';
  if (conversionStatus) {
    conversionStatus.textContent =
      c.status === 'operational'
        ? 'Operational'
        : c.status === 'degraded'
          ? 'Degraded'
          : 'Offline';
  }
  conversionBadge?.setAttribute('data-ok', String(isOk));
  if (conversionIconWrap) {
    conversionIconWrap.dataset.connected = String(c.connected);
  }
  if (conversionEngine) {
    conversionEngine.textContent = c.engine || 'LibreOffice Headless';
  }
  if (conversionUpdatedAt) {
    conversionUpdatedAt.textContent = `Updated ${new Date(c.lastCheckedAt).toLocaleTimeString()}`;
  }
  if (conversionExecutable) {
    conversionExecutable.textContent = c.resolvedPath
      ? c.resolvedPath
      : c.executableFound
        ? 'Found'
        : 'Missing';
  }
  if (conversionPipe) {
    conversionPipe.textContent = c.pipeConnected ? 'Connected' : 'Unavailable';
  }
  if (zombieTerminationStatus) {
    zombieTerminationStatus.textContent = c.zombieTerminationEnabled
      ? 'Active (Auto-Kill)'
      : 'Disabled';
  }
  if (zombieProcessCount) {
    zombieProcessCount.textContent = `${c.activeZombieProcesses} running (${c.totalZombiesTerminated} killed)`;
  }
  if (zombieToggleText) {
    zombieToggleText.textContent = c.zombieTerminationEnabled
      ? 'Disable Auto-Termination'
      : 'Enable Auto-Termination';
  }
  if (zombieToggleSubText) {
    zombieToggleSubText.textContent = c.zombieTerminationEnabled
      ? 'Auto-kill is ON (clears frozen soffice)'
      : 'Auto-kill is OFF (processes may linger)';
  }
}

// ── Apply summary data to UI ────────────────────────────────────────────────────

function applySystem(summary: SummaryResponse): void {
  serverStatus.textContent = summary.status.serverRunning ? 'Running' : 'Down';
  serverBadge?.setAttribute('data-ok', String(summary.status.serverRunning));
  hostStatus.textContent = summary.status.host;
  wifiStatus.textContent = summary.status.wifiActive ? 'Active' : 'Inactive';
  wifiBadge?.setAttribute('data-ok', String(summary.status.wifiActive));

  const p = summary.status.printer;
  const printerReady = isPrinterReadyForJobs(p as PrinterTelemetryExt);
  printerStatus.textContent = p.connected ? p.status : 'Not Found';
  printerBadge?.setAttribute('data-ok', String(printerReady));
  printerNameEl.textContent = p.name ?? '—';

  applyPrinterExt(p as PrinterTelemetryExt);
  applyConversion(summary.status.conversion);
  updateSidebarBadges(summary);
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

function updatePrinterSelectionHint(): void {
  if (!printerSelection || !printerSelectionHint) return;
  const selectedOption = printerSelection.selectedOptions[0];
  if (!selectedOption) {
    printerSelectionHint.textContent = 'Choose an installed printer.';
    return;
  }

  const isDirty = printerSelection.dataset.dirty === 'true';
  const details = selectedOption.dataset.details ?? '';
  printerSelectionHint.textContent = isDirty
    ? `Unsaved change · ${details}`
    : details;
}

function renderPrinterSelection(
  printers: PrinterSelectionInput[],
  targetPrinterName: string | null,
): void {
  if (!printerSelection) return;

  const options = buildPrinterSelectionOptions(printers, targetPrinterName);
  printerSelection.replaceChildren();

  for (const option of options) {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.isAutomatic
      ? option.label
      : option.available && option.isDefault
        ? `${option.label} — Windows default`
        : option.label;
    element.dataset.details = option.details;
    element.selected = option.selected;
    element.disabled = !option.available;
    printerSelection.append(element);
  }

  printerSelection.dataset.dirty = 'false';
  printerSelection.disabled = false;
  if (applyPrinterSelectionBtn) applyPrinterSelectionBtn.disabled = true;
  updatePrinterSelectionHint();
}

async function loadPrinterSelection(): Promise<void> {
  if (!printerSelection) return;

  printerSelection.disabled = true;
  if (applyPrinterSelectionBtn) applyPrinterSelectionBtn.disabled = true;
  if (printerSelectionHint) {
    printerSelectionHint.textContent = 'Loading installed printers...';
  }

  try {
    const response = await apiFetch('/api/admin/printer/list');
    if (!response.ok) throw new Error('Failed to load installed printers.');
    const body = (await response.json()) as PrinterListResponse;
    renderPrinterSelection(body.printers ?? [], body.targetPrinterName ?? null);
  } catch (error: unknown) {
    printerSelection.replaceChildren();
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Unable to load installed printers';
    printerSelection.append(option);
    if (printerSelectionHint) {
      printerSelectionHint.textContent =
        error instanceof Error
          ? error.message
          : 'Unable to load installed printers.';
    }
  } finally {
    printerSelection.disabled = false;
  }
}

async function savePrinterSelection(): Promise<void> {
  if (!printerSelection) return;

  const targetPrinterName = printerSelection.value.trim() || null;
  printerSelection.disabled = true;
  if (applyPrinterSelectionBtn) applyPrinterSelectionBtn.disabled = true;
  setMessage('Saving printer selection...');

  try {
    const response = await apiFetch('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        inkMonitoring: { targetPrinterName },
      }),
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(body.error ?? 'Failed to save printer selection.');
    }

    printerSelection.dataset.dirty = 'false';
    await Promise.all([loadData(), loadPrinterSelection()]);
    setMessage(
      targetPrinterName
        ? `Print target set to ${targetPrinterName}.`
        : 'Print target set to Automatic.',
    );
  } catch (error: unknown) {
    setMessage(
      error instanceof Error
        ? error.message
        : 'Failed to save printer selection.',
    );
    printerSelection.disabled = false;
    if (applyPrinterSelectionBtn) applyPrinterSelectionBtn.disabled = false;
  }
}

// ── Action handlers ─────────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', () => {
  setMessage('Refreshing...');
  void Promise.all([loadData(), loadPrinterSelection()])
    .then(() => setMessage('System refreshed.'))
    .catch((e: unknown) =>
      setMessage(e instanceof Error ? e.message : 'Refresh failed.'),
    );
});

printerSelection?.addEventListener('change', () => {
  printerSelection.dataset.dirty = 'true';
  if (applyPrinterSelectionBtn) applyPrinterSelectionBtn.disabled = false;
  updatePrinterSelectionHint();
});

applyPrinterSelectionBtn?.addEventListener('click', () => {
  void savePrinterSelection();
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
      const printerReady = isPrinterReadyForJobs(p);
      lastPrinterSnapshot = { ...p };
      printerStatus.textContent = p.connected ? p.status : 'Not Found';
      printerBadge?.setAttribute('data-ok', String(printerReady));
      printerNameEl.textContent = p.name ?? '—';
      applyPrinterExt(p);
      setMessage(
        `Re-detected: ${p.name ?? 'unknown'} (${printerReady ? 'ready' : 'not ready'})`,
      );
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
        timing?: {
          totalElapsedMs?: number | null;
          dispatchDurationMs?: number | null;
          dispatchEngine?: string | null;
          dispatchAttempts?: number | null;
        };
      };
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? 'Printer unavailable or not connected.');
      }
      const timingParts: string[] = [];
      if (typeof body.timing?.dispatchEngine === 'string') {
        timingParts.push(`engine: ${body.timing.dispatchEngine}`);
      }
      if (typeof body.timing?.dispatchDurationMs === 'number') {
        timingParts.push(`dispatch: ${body.timing.dispatchDurationMs}ms`);
      }
      if (typeof body.timing?.totalElapsedMs === 'number') {
        timingParts.push(`total: ${body.timing.totalElapsedMs}ms`);
      }
      const timingSuffix =
        timingParts.length > 0 ? ` (${timingParts.join(', ')})` : '';
      setMessage((body.message ?? 'Test page sent successfully.') + timingSuffix);
    })
    .catch((e: unknown) =>
      setMessage(e instanceof Error ? e.message : 'Test print failed.'),
    )
    .finally(() => {
      testPrintBtn.disabled = false;
    });
});


// ── Restart Print Spooler ───────────────────────────────────────────────────

restartSpoolerBtn?.addEventListener('click', () => {
  const currentPrinter = lastPrinterSnapshot?.name;
  const promptText = currentPrinter
    ? `Restart the Windows Print Spooler for "${currentPrinter}"? Active print jobs will pause briefly.`
    : 'Restart the Windows Print Spooler service? Active print jobs will pause briefly.';

  if (!window.confirm(promptText)) return;

  restartSpoolerBtn.disabled = true;
  setMessage('Restarting Windows Print Spooler...');

  void apiFetch('/api/admin/printer/restart-spooler', {
    method: 'POST',
    body: JSON.stringify({
      printerName: currentPrinter ?? undefined,
    }),
  })
    .then(async (res) => {
      const body = (await res.json()) as {
        ok: boolean;
        outcome?: string;
        message?: string;
        error?: string;
        spoolerState?: { isRunning: boolean; status: string };
        printerState?: string;
      };
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? body.message ?? 'Print Spooler restart failed.');
      }
      setMessage(body.message ?? 'Print Spooler restarted successfully.');
      void loadData().catch(showRefreshError);
    })
    .catch((e: unknown) =>
      setMessage(e instanceof Error ? e.message : 'Print Spooler restart failed.'),
    )
    .finally(() => {
      restartSpoolerBtn.disabled = false;
    });
});

// ── Document Conversion actions ──────────────────────────────────────────────

terminateZombiesBtn?.addEventListener('click', () => {
  if (
    !window.confirm(
      'Force-terminate all lingering LibreOffice background processes and clear lock files?',
    )
  ) {
    return;
  }

  terminateZombiesBtn.disabled = true;
  setMessage('Terminating zombie LibreOffice processes...');

  void apiFetch('/api/admin/conversion/terminate-zombies', { method: 'POST' })
    .then(async (res) => {
      const body = (await res.json()) as {
        success?: boolean;
        message?: string;
        killedCount?: number;
        status?: SummaryResponse['status']['conversion'];
        error?: string;
      };
      if (!res.ok || body.success === false) {
        throw new Error(
          body.error ?? body.message ?? 'Failed to terminate zombie processes.',
        );
      }
      setMessage(body.message ?? `Terminated ${body.killedCount ?? 0} processes.`);
      if (body.status) applyConversion(body.status);
      void loadData().catch(showRefreshError);
    })
    .catch((err: unknown) => {
      setMessage(
        err instanceof Error ? err.message : 'Failed to terminate zombie processes.',
      );
    })
    .finally(() => {
      terminateZombiesBtn.disabled = false;
    });
});

toggleZombieTerminationBtn?.addEventListener('click', () => {
  toggleZombieTerminationBtn.disabled = true;
  setMessage('Updating zombie process termination policy...');

  void apiFetch('/api/admin/conversion/toggle-zombie-termination', {
    method: 'POST',
  })
    .then(async (res) => {
      const body = (await res.json()) as {
        success?: boolean;
        enabled?: boolean;
        status?: SummaryResponse['status']['conversion'];
        error?: string;
      };
      if (!res.ok || body.success === false) {
        throw new Error(body.error ?? 'Failed to toggle zombie termination.');
      }
      setMessage(
        `Zombie termination policy is now ${body.enabled ? 'Enabled' : 'Disabled'}.`,
      );
      if (body.status) applyConversion(body.status);
      void loadData().catch(showRefreshError);
    })
    .catch((err: unknown) => {
      setMessage(
        err instanceof Error ? err.message : 'Failed to toggle zombie termination.',
      );
    })
    .finally(() => {
      toggleZombieTerminationBtn.disabled = false;
    });
});

testConversionBtn?.addEventListener('click', () => {
  testConversionBtn.disabled = true;
  setMessage('Testing document conversion engine via worker pipe...');

  void apiFetch('/api/admin/conversion/test', { method: 'POST' })
    .then(async (res) => {
      const body = (await res.json()) as {
        success?: boolean;
        message?: string;
        status?: SummaryResponse['status']['conversion'];
        error?: string;
      };
      if (!res.ok || body.success === false) {
        throw new Error(body.error ?? body.message ?? 'Conversion test failed.');
      }
      setMessage(body.message ?? 'Conversion engine test succeeded.');
      if (body.status) applyConversion(body.status);
      void loadData().catch(showRefreshError);
    })
    .catch((err: unknown) => {
      setMessage(
        err instanceof Error ? err.message : 'Conversion engine test failed.',
      );
    })
    .finally(() => {
      testConversionBtn.disabled = false;
    });
});

// ── Windows restart ──────────────────────────────────────────────────────────

restartWindowsBtn?.addEventListener('click', () => {
  if (
    !window.confirm(
      'Restart the entire Windows kiosk? Make sure no customer operation is active.',
    )
  ) {
    return;
  }

  restartWindowsBtn.disabled = true;
  setMessage('Scheduling Windows restart...');

  void apiFetch('/api/admin/system/restart', { method: 'POST' })
    .then(async (res) => {
      const body = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok || body.ok !== true) {
        throw new Error(body.error ?? 'Windows restart could not be scheduled.');
      }
      setMessage(body.message ?? 'Windows restart scheduled.');
    })
    .catch((error: unknown) => {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Windows restart could not be scheduled.',
      );
      restartWindowsBtn.disabled = false;
    });
});

// ── Windows shutdown ─────────────────────────────────────────────────────────

shutdownWindowsBtn?.addEventListener('click', () => {
  if (
    !window.confirm(
      'Shut down the entire Windows kiosk? Make sure no customer operation is active.',
    )
  ) {
    return;
  }

  shutdownWindowsBtn.disabled = true;
  setMessage('Scheduling Windows shutdown...');

  void apiFetch('/api/admin/system/shutdown', { method: 'POST' })
    .then(async (res) => {
      const body = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok || body.ok !== true) {
        throw new Error(body.error ?? 'Windows shutdown could not be scheduled.');
      }
      setMessage(body.message ?? 'Windows shutdown scheduled.');
    })
    .catch((error: unknown) => {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Windows shutdown could not be scheduled.',
      );
      shutdownWindowsBtn.disabled = false;
    });
});

// ── New: Spooler failure alert dismiss ────────────────────────────────────────

spoolerAlertDismiss?.addEventListener('click', () => {
  spoolerAlert?.classList.add('hidden');
  if (spoolerAlertMsg) spoolerAlertMsg.textContent = '';
});

// ── Error simulation actions ─────────────────────────────────────────────────

function updateSimulationBadge(activeError: string | null): void {
  if (!simStatusBadge) return;
  if (!activeError) {
    simStatusBadge.textContent = 'Normal · No Error';
    simStatusBadge.className = 'sim-status-badge sim-status-badge--idle';
    return;
  }

  const labels: Record<string, { label: string; danger?: boolean }> = {
    low_ink: { label: 'Simulated: Low Ink' },
    ink_out: { label: 'Simulated: Ink Out (Empty)', danger: true },
    out_of_paper: { label: 'Simulated: Out of Paper' },
    adf_error: { label: 'Simulated: ADF Error' },
    paper_jam: { label: 'Simulated: Paper Jam', danger: true },
    cover_open: { label: 'Simulated: Cover Open' },
    offline: { label: 'Simulated: Printer Offline', danger: true },
    service_required: { label: 'Simulated: Service Required', danger: true },
    output_tray: { label: 'Simulated: Output Tray' },
  };

  const item = labels[activeError] || { label: `Simulated: ${activeError}` };
  simStatusBadge.textContent = item.label;
  simStatusBadge.className = item.danger
    ? 'sim-status-badge sim-status-badge--danger'
    : 'sim-status-badge sim-status-badge--active';
}

async function triggerSimulation(errorType: string): Promise<void> {
  setMessage(`Simulating ${errorType.replace('_', ' ')}...`);
  try {
    const res = await apiFetch('/api/admin/printer/simulate-error', {
      method: 'POST',
      body: JSON.stringify({ errorType }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      message?: string;
      simulation?: { activeError?: string | null };
    };
    if (!res.ok || !data.ok) {
      throw new Error(data.error ?? 'Simulation failed.');
    }
    updateSimulationBadge(data.simulation?.activeError ?? errorType);
    setMessage(data.message ?? `Simulated ${errorType} successfully.`);
    void loadData().catch(showRefreshError);
  } catch (err) {
    setMessage(err instanceof Error ? err.message : 'Simulation failed.');
  }
}

async function triggerClearPrinterErrors(): Promise<void> {
  setMessage('Clearing printer error messages...');
  try {
    const res = await apiFetch('/api/admin/printer/clear-errors', {
      method: 'POST',
    });
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      message?: string;
    };
    if (!res.ok || !data.ok) {
      throw new Error(data.error ?? 'Failed to clear errors.');
    }
    updateSimulationBadge(null);
    setMessage(data.message ?? 'Printer errors cleared successfully.');
    void loadData().catch(showRefreshError);
  } catch (err) {
    setMessage(err instanceof Error ? err.message : 'Failed to clear errors.');
  }
}

async function triggerClearPaperJam(): Promise<void> {
  setMessage('Clearing Paper Jam error and redirecting kiosk to homepage...');
  try {
    const res = await apiFetch('/api/admin/printer/clear-paper-jam', {
      method: 'POST',
    });
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      message?: string;
    };
    if (!res.ok || !data.ok) {
      throw new Error(data.error ?? 'Failed to clear paper jam.');
    }
    updateSimulationBadge(null);
    setMessage(data.message ?? 'Paper jam cleared successfully. Kiosk redirected to home.');
    void loadData().catch(showRefreshError);
  } catch (err) {
    setMessage(err instanceof Error ? err.message : 'Failed to clear paper jam.');
  }
}

async function loadSimulationStatus(): Promise<void> {
  try {
    const res = await apiFetch('/api/admin/printer/simulation-status');
    if (!res.ok) return;
    const data = (await res.json()) as {
      simulation?: { activeError?: string | null };
    };
    updateSimulationBadge(data.simulation?.activeError ?? null);
  } catch {
    // Ignore fetch error
  }
}

simLowInkBtn?.addEventListener('click', () => void triggerSimulation('low_ink'));
simOutOfPaperBtn?.addEventListener('click', () => void triggerSimulation('out_of_paper'));
simAdfErrorBtn?.addEventListener('click', () => void triggerSimulation('adf_error'));
simPaperJamBtn?.addEventListener('click', () => void triggerSimulation('paper_jam'));
simInkOutBtn?.addEventListener('click', () => void triggerSimulation('ink_out'));
simCoverOpenBtn?.addEventListener('click', () => void triggerSimulation('cover_open'));
simOfflineBtn?.addEventListener('click', () => void triggerSimulation('offline'));
simServiceBtn?.addEventListener('click', () => void triggerSimulation('service_required'));
simOutputTrayBtn?.addEventListener('click', () => void triggerSimulation('output_tray'));
clearPrinterErrorsBtn?.addEventListener('click', () => void triggerClearPrinterErrors());
clearPaperJamBtn?.addEventListener('click', () => void triggerClearPaperJam());

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
  const token = sessionStorage.getItem('adminSessionToken') ?? '';
  socket = io({ auth: { token }, reconnectionDelay: 2000 });

  // Live printer card update (emitted by Phase 2 health monitor)
  socket.on('printerStatusChanged', (payload: unknown) => {
    const normalizedPatch =
      payload &&
      typeof payload === 'object' &&
      'printerName' in payload &&
      typeof (payload as { printerName: unknown }).printerName !== 'undefined'
        ? ({
            ...(payload as Record<string, unknown>),
            name:
              typeof (payload as { printerName: unknown }).printerName ===
                'string' ||
              (payload as { printerName: unknown }).printerName === null
                ? ((payload as { printerName: string | null }).printerName ??
                  null)
                : undefined,
          } as PrinterTelemetryPatch)
        : (payload as PrinterTelemetryPatch);
    const next = mergePrinterSnapshot(normalizedPatch);
    if (!next) return;

    const printerReady = isPrinterReadyForJobs(next);
    lastPrinterSnapshot = next;
    printerStatus.textContent = next.connected ? next.status : 'Not Found';
    printerBadge?.setAttribute('data-ok', String(printerReady));
    if (next.name !== undefined) printerNameEl.textContent = next.name ?? '—';
    applyPrinterExt(next);
    setMessage(`Printer: ${next.status} (${printerReady ? 'ready' : 'not ready'})`);
  });

  socket.on('printLifecycleState', (payload: unknown) => {
    const event = parsePrintLifecyclePayload(payload);
    if (!event) return;

    const reference = event.transactionId ? event.transactionId.slice(0, 8) : 'n/a';
    const printerLabel = event.printerName ?? 'printer';
    const modeLabel = event.mode === 'copy' ? 'Copy' : 'Print';
    if (event.state === 'failed' && spoolerAlertMsg) {
      spoolerAlertMsg.textContent = event.reason
        ? `${modeLabel} lifecycle marked failed on ${printerLabel} (ref ${reference}): ${event.reason}`
        : `${modeLabel} lifecycle marked failed on ${printerLabel} (ref ${reference}).`;
      spoolerAlert?.classList.remove('hidden');
    }
    setMessage(
      `${modeLabel} lifecycle: ${event.state} (${printerLabel}, ref ${reference})`,
    );
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

  socket.on('printer:simulation-state', (payload: unknown) => {
    const p = payload as { activeError?: string | null } | null;
    updateSimulationBadge(p?.activeError ?? null);
  });

  socket.on('printer:simulation-cleared', () => {
    updateSimulationBadge(null);
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function showRefreshError(error: unknown): void {
  setMessage(
    error instanceof Error ? error.message : 'Automatic refresh failed.',
  );
}

initAuth(async (signal) => {
  attachSubsystemCardToggles();
  await loadData();
  if (signal.aborted) return;
  await loadPrinterSelection();
  if (signal.aborted) return;
  await loadSimulationStatus();
  if (signal.aborted) return;
  connectSocket();

  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(
    () => void loadData().catch(showRefreshError),
    10_000,
  );
});


window.addEventListener('pagehide', () => {
  socket?.disconnect();
});
