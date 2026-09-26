import {
  SettingsResponse,
  SummaryResponse,
  PaperPricingProfile,
  apiFetch,
  setMessage,
  initAuth,
  setAdminPin,
  updateSidebarBadges,
} from '../shared';

const settingsForm = document.getElementById('settingsForm') as HTMLFormElement;
const settingAdminPin = document.getElementById(
  'settingAdminPin',
) as HTMLInputElement;
const settingAdminLocalOnly = document.getElementById(
  'settingAdminLocalOnly',
) as HTMLInputElement | null;
const settingConsumablesForecastingEnabled = document.getElementById(
  'settingConsumablesForecastingEnabled',
) as HTMLInputElement | null;
const settingRollingWindowDays = document.getElementById(
  'settingRollingWindowDays',
) as HTMLInputElement | null;
const settingAlertDaysThreshold = document.getElementById(
  'settingAlertDaysThreshold',
) as HTMLInputElement | null;
const settingPaperTrayCapacitySheets = document.getElementById(
  'settingPaperTrayCapacitySheets',
) as HTMLInputElement | null;
const settingPaperCurrentSheets = document.getElementById(
  'settingPaperCurrentSheets',
) as HTMLInputElement | null;

// ── Document Processing & Upload Pipeline ────
const settingMalwareScanning = document.getElementById(
  'settingMalwareScanning',
) as HTMLInputElement | null;
const settingDocumentConversion = document.getElementById(
  'settingDocumentConversion',
) as HTMLInputElement | null;
const settingColorDetection = document.getElementById(
  'settingColorDetection',
) as HTMLInputElement | null;

// ── Pricing Engine settings ──────────────────
const settingA4PaperCost = document.getElementById('settingA4PaperCost') as HTMLInputElement | null;
const settingA4BwLow = document.getElementById('settingA4BwLow') as HTMLInputElement | null;
const settingA4BwMedium = document.getElementById('settingA4BwMedium') as HTMLInputElement | null;
const settingA4BwHigh = document.getElementById('settingA4BwHigh') as HTMLInputElement | null;
const settingA4BwVeryHigh = document.getElementById('settingA4BwVeryHigh') as HTMLInputElement | null;
const settingA4ColorLow = document.getElementById('settingA4ColorLow') as HTMLInputElement | null;
const settingA4ColorMedium = document.getElementById('settingA4ColorMedium') as HTMLInputElement | null;
const settingA4ColorHigh = document.getElementById('settingA4ColorHigh') as HTMLInputElement | null;
const settingA4ColorVeryHigh = document.getElementById('settingA4ColorVeryHigh') as HTMLInputElement | null;

const settingShortBondPaperCost = document.getElementById('settingShortBondPaperCost') as HTMLInputElement | null;
const settingShortBondBwLow = document.getElementById('settingShortBondBwLow') as HTMLInputElement | null;
const settingShortBondBwMedium = document.getElementById('settingShortBondBwMedium') as HTMLInputElement | null;
const settingShortBondBwHigh = document.getElementById('settingShortBondBwHigh') as HTMLInputElement | null;
const settingShortBondBwVeryHigh = document.getElementById('settingShortBondBwVeryHigh') as HTMLInputElement | null;
const settingShortBondColorLow = document.getElementById('settingShortBondColorLow') as HTMLInputElement | null;
const settingShortBondColorMedium = document.getElementById('settingShortBondColorMedium') as HTMLInputElement | null;
const settingShortBondColorHigh = document.getElementById('settingShortBondColorHigh') as HTMLInputElement | null;
const settingShortBondColorVeryHigh = document.getElementById('settingShortBondColorVeryHigh') as HTMLInputElement | null;

const settingLongBondPaperCost = document.getElementById('settingLongBondPaperCost') as HTMLInputElement | null;
const settingLongBondBwLow = document.getElementById('settingLongBondBwLow') as HTMLInputElement | null;
const settingLongBondBwMedium = document.getElementById('settingLongBondBwMedium') as HTMLInputElement | null;
const settingLongBondBwHigh = document.getElementById('settingLongBondBwHigh') as HTMLInputElement | null;
const settingLongBondBwVeryHigh = document.getElementById('settingLongBondBwVeryHigh') as HTMLInputElement | null;
const settingLongBondColorLow = document.getElementById('settingLongBondColorLow') as HTMLInputElement | null;
const settingLongBondColorMedium = document.getElementById('settingLongBondColorMedium') as HTMLInputElement | null;
const settingLongBondColorHigh = document.getElementById('settingLongBondColorHigh') as HTMLInputElement | null;
const settingLongBondColorVeryHigh = document.getElementById('settingLongBondColorVeryHigh') as HTMLInputElement | null;
const settingScanDocument = document.getElementById(
  'settingScanDocument',
) as HTMLInputElement | null;
const settingHighQualitySurcharge = document.getElementById(
  'settingHighQualitySurcharge',
) as HTMLInputElement | null;

// ── Scan Filename Format settings ────────────
const settingScanFilenamePrefix = document.getElementById(
  'settingScanFilenamePrefix',
) as HTMLInputElement | null;
const settingScanFilenameDateFormat = document.getElementById(
  'settingScanFilenameDateFormat',
) as HTMLSelectElement | null;
const settingScanFilenameTimeFormat = document.getElementById(
  'settingScanFilenameTimeFormat',
) as HTMLSelectElement | null;
const settingScanFilenameIncludeRandom = document.getElementById(
  'settingScanFilenameIncludeRandom',
) as HTMLInputElement | null;
const settingScanFilenameCustomPatternEnabled = document.getElementById(
  'settingScanFilenameCustomPatternEnabled',
) as HTMLInputElement | null;
const customPatternContainer = document.getElementById(
  'customPatternContainer',
) as HTMLElement | null;
const settingScanFilenameCustomPattern = document.getElementById(
  'settingScanFilenameCustomPattern',
) as HTMLInputElement | null;
const scanFilenamePreviewText = document.getElementById(
  'scanFilenamePreviewText',
) as HTMLElement | null;

// ── Print Limits Configuration ─────────────────────────────────
const settingMaxPagesPerSession = document.getElementById(
  'settingMaxPagesPerSession',
) as HTMLInputElement | null;

// ── Kiosk Availability & UI Blocking ───────────────────────────
const settingUiBlockingEnabled = document.getElementById(
  'settingUiBlockingEnabled',
) as HTMLInputElement | null;
const settingUiBlockingMode = document.getElementById(
  'settingUiBlockingMode',
) as HTMLSelectElement | null;
const settingUiBlockingMessage = document.getElementById(
  'settingUiBlockingMessage',
) as HTMLInputElement | null;

// ── Scanner & ADF Resolution Settings ──────────────────────────
const settingCopyGlassDpi = document.getElementById(
  'settingCopyGlassDpi',
) as HTMLSelectElement | null;
const settingCopyAdfDpi = document.getElementById(
  'settingCopyAdfDpi',
) as HTMLSelectElement | null;
const settingScanGlassDpi = document.getElementById(
  'settingScanGlassDpi',
) as HTMLSelectElement | null;
const settingScanAdfDpi = document.getElementById(
  'settingScanAdfDpi',
) as HTMLSelectElement | null;

// ── Developer Testing Mode ─────────────────────────────────────
const settingDeveloperModeEnabled = document.getElementById(
  'settingDeveloperModeEnabled',
) as HTMLInputElement | null;

// ── Optional sections (may be commented out in HTML) ─────────────────────────
const settingIdleTimeout = document.getElementById(
  'settingIdleTimeout',
) as HTMLInputElement | null;
const settingIdleScreenTimeout = document.getElementById(
  'settingIdleScreenTimeout',
) as HTMLInputElement | null;
const inkMonitoringEnabled = document.getElementById(
  'inkMonitoringEnabled',
) as HTMLInputElement | null;
const inkTargetPrinterName = document.getElementById(
  'inkTargetPrinterName',
) as HTMLInputElement | null;
const inkLowThresholdPercent = document.getElementById(
  'inkLowThresholdPercent',
) as HTMLInputElement | null;
const inkCriticalThresholdPercent = document.getElementById(
  'inkCriticalThresholdPercent',
) as HTMLInputElement | null;
const inkBlockOnLow = document.getElementById(
  'inkBlockOnLow',
) as HTMLInputElement | null;
const inkBlockOnEmpty = document.getElementById(
  'inkBlockOnEmpty',
) as HTMLInputElement | null;
const inkTelemetryUnknownPolicy = document.getElementById(
  'inkTelemetryUnknownPolicy',
) as HTMLSelectElement | null;
const alertSeverityThreshold = document.getElementById(
  'alertSeverityThreshold',
) as HTMLSelectElement | null;
const alertDashboardEnabled = document.getElementById(
  'alertDashboardEnabled',
) as HTMLInputElement | null;
const alertEmailEnabled = document.getElementById(
  'alertEmailEnabled',
) as HTMLInputElement | null;
const alertSmtpHost = document.getElementById(
  'alertSmtpHost',
) as HTMLInputElement | null;
const alertSmtpPort = document.getElementById(
  'alertSmtpPort',
) as HTMLInputElement | null;
const alertSmtpSecure = document.getElementById(
  'alertSmtpSecure',
) as HTMLInputElement | null;
const alertEmailUsername = document.getElementById(
  'alertEmailUsername',
) as HTMLInputElement | null;
const alertEmailFrom = document.getElementById(
  'alertEmailFrom',
) as HTMLInputElement | null;
const alertEmailTo = document.getElementById(
  'alertEmailTo',
) as HTMLInputElement | null;
const testEmailAlertBtn = document.getElementById(
  'testEmailAlertBtn',
) as HTMLButtonElement | null;

const refreshBtn = document.getElementById('refreshBtn') as HTMLButtonElement;
let refreshTimer: number | null = null;
let loadedAdminLocalOnly: boolean = false;
let currentDeveloperModeEnabled: boolean = false;
let settingsDirty: boolean = false;

function renderScanFilenamePreview(): void {
  if (!scanFilenamePreviewText) return;

  const now = new Date();
  const YYYY = String(now.getFullYear());
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const DD = String(now.getDate()).padStart(2, '0');
  const HH = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const RANDOM = 'A1B2';

  const prefix = settingScanFilenamePrefix?.value.trim() || 'PrintBit-Scan';
  const customEnabled =
    settingScanFilenameCustomPatternEnabled?.checked ?? false;
  const customPattern =
    settingScanFilenameCustomPattern?.value.trim() ||
    '{PREFIX}_{YYYY}{MM}{DD}_{HH}{mm}{ss}';
  const dateFormat = settingScanFilenameDateFormat?.value ?? 'YYYYMMDD';
  const timeFormat = settingScanFilenameTimeFormat?.value ?? 'HHmmss';
  const includeRandom = settingScanFilenameIncludeRandom?.checked ?? false;

  let baseName: string;
  if (customEnabled) {
    baseName = customPattern
      .replace(/\{PREFIX\}/gi, prefix)
      .replace(/\{YYYY\}/g, YYYY)
      .replace(/\{MM\}/g, MM)
      .replace(/\{DD\}/g, DD)
      .replace(/\{HH\}/g, HH)
      .replace(/\{mm\}/g, mm)
      .replace(/\{ss\}/g, ss)
      .replace(/\{RANDOM\}/gi, RANDOM);
  } else {
    const parts: string[] = [];
    if (prefix) parts.push(prefix);

    if (dateFormat === 'YYYY-MM-DD') parts.push(`${YYYY}-${MM}-${DD}`);
    else if (dateFormat === 'YYYYMMDD') parts.push(`${YYYY}${MM}${DD}`);
    else if (dateFormat === 'DD-MM-YYYY') parts.push(`${DD}-${MM}-${YYYY}`);

    if (timeFormat === 'HH-mm-ss') parts.push(`${HH}-${mm}-${ss}`);
    else if (timeFormat === 'HHmmss') parts.push(`${HH}${mm}${ss}`);
    else if (timeFormat === 'HHmm') parts.push(`${HH}${mm}`);

    if (includeRandom) parts.push(RANDOM);

    baseName = parts.filter(Boolean).join('-');
  }

  const cleaned = baseName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();

  let baseWithoutExt = cleaned.replace(/\.(pdf|jpe?g|png)$/i, '');
  if (!baseWithoutExt) baseWithoutExt = 'PrintBit-Scan';
  const finalName = `${baseWithoutExt}.pdf`;
  scanFilenamePreviewText.textContent = finalName;
}

function syncScanFilenameUI(): void {
  const customEnabled =
    settingScanFilenameCustomPatternEnabled?.checked ?? false;
  if (customPatternContainer) {
    customPatternContainer.classList.toggle('hidden', !customEnabled);
  }

  const presetElements = [
    settingScanFilenameDateFormat,
    settingScanFilenameTimeFormat,
    settingScanFilenameIncludeRandom,
  ] satisfies (HTMLSelectElement | HTMLInputElement | null)[];

  presetElements.forEach((el) => {
    if (!el) return;
    el.disabled = customEnabled;
    const parentField = el.closest('.field');
    if (parentField) {
      parentField.classList.toggle('field--disabled', customEnabled);
    }
  });

  if (
    customEnabled &&
    settingScanFilenameCustomPattern &&
    !settingScanFilenameCustomPattern.value.trim()
  ) {
    settingScanFilenameCustomPattern.value =
      '{PREFIX}_{YYYY}{MM}{DD}_{HH}{mm}{ss}';
  }

  renderScanFilenamePreview();
}

const scanFormatInputs = [
  settingScanFilenamePrefix,
  settingScanFilenameDateFormat,
  settingScanFilenameTimeFormat,
  settingScanFilenameIncludeRandom,
  settingScanFilenameCustomPatternEnabled,
  settingScanFilenameCustomPattern,
];

scanFormatInputs.forEach((el) => {
  if (!el) return;
  const update = () => {
    if (el === settingScanFilenameCustomPatternEnabled) {
      syncScanFilenameUI();
    } else {
      renderScanFilenamePreview();
    }
  };
  el.addEventListener('input', update);
  el.addEventListener('change', update);
});

document.querySelectorAll('.token-tag').forEach((tag) => {
  tag.addEventListener('click', () => {
    const token = tag.getAttribute('data-token');
    if (!token || !settingScanFilenameCustomPattern) return;
    const start =
      settingScanFilenameCustomPattern.selectionStart ??
      settingScanFilenameCustomPattern.value.length;
    const end =
      settingScanFilenameCustomPattern.selectionEnd ??
      settingScanFilenameCustomPattern.value.length;
    const current = settingScanFilenameCustomPattern.value;
    settingScanFilenameCustomPattern.value =
      current.slice(0, start) + token + current.slice(end);
    settingScanFilenameCustomPattern.focus();
    settingScanFilenameCustomPattern.setSelectionRange(
      start + token.length,
      start + token.length,
    );
    settingScanFilenameCustomPattern.dispatchEvent(
      new Event('input', { bubbles: true }),
    );
  });
});

syncScanFilenameUI();



function applySettings(settings: SettingsResponse): void {
  settingAdminPin.value = '';
  loadedAdminLocalOnly = settings.adminLocalOnly;
  if (settingAdminLocalOnly) {
    settingAdminLocalOnly.checked = settings.adminLocalOnly;
  }

  // Kiosk Behaviour (optional)
  if (settingIdleTimeout) {
    settingIdleTimeout.value = String(settings.idleTimeoutSeconds);
  }
  if (settingIdleScreenTimeout) {
    settingIdleScreenTimeout.value = String(settings.idleScreenTimeoutSeconds);
  }

  // Document Processing & Upload Pipeline
  if (settingMalwareScanning) {
    settingMalwareScanning.checked =
      settings.pipelineSettings?.malwareScanningEnabled ?? true;
  }
  if (settingDocumentConversion) {
    settingDocumentConversion.checked =
      settings.pipelineSettings?.documentConversionEnabled ?? true;
  }
  if (settingColorDetection) {
    settingColorDetection.checked =
      settings.pipelineSettings?.colorDetectionEnabled ?? true;
  }

  // Ink Monitoring (optional)
  if (inkMonitoringEnabled)
    inkMonitoringEnabled.checked = settings.inkMonitoring.enabled;
  if (inkTargetPrinterName)
    inkTargetPrinterName.value = settings.inkMonitoring.targetPrinterName ?? '';
  if (inkLowThresholdPercent)
    inkLowThresholdPercent.value = String(
      settings.inkMonitoring.lowThresholdPercent,
    );
  if (inkCriticalThresholdPercent)
    inkCriticalThresholdPercent.value = String(
      settings.inkMonitoring.criticalThresholdPercent,
    );
  if (inkBlockOnLow) inkBlockOnLow.checked = settings.inkMonitoring.blockOnLow;
  if (inkBlockOnEmpty)
    inkBlockOnEmpty.checked = settings.inkMonitoring.blockOnEmpty;
  if (inkTelemetryUnknownPolicy)
    inkTelemetryUnknownPolicy.value =
      settings.inkMonitoring.telemetryUnknownPolicy;

  if (settingConsumablesForecastingEnabled)
    settingConsumablesForecastingEnabled.checked =
      settings.consumablesForecasting.enabled;
  if (settingRollingWindowDays)
    settingRollingWindowDays.value = String(
      settings.consumablesForecasting.rollingWindowDays,
    );
  if (settingAlertDaysThreshold)
    settingAlertDaysThreshold.value = String(
      settings.consumablesForecasting.alertDaysThreshold,
    );
  if (settingPaperTrayCapacitySheets)
    settingPaperTrayCapacitySheets.value = String(
      settings.consumablesForecasting.paperTrayCapacitySheets,
    );
  if (settingPaperCurrentSheets)
    settingPaperCurrentSheets.value = String(
      settings.consumablesForecasting.paperCurrentSheets,
    );

  // Pricing Configuration
  const populateProfile = (
    prefix: 'A4' | 'ShortBond' | 'LongBond',
    key: 'a4' | 'shortBond' | 'longBond',
  ) => {
    const p = settings.pricingEngine?.paperProfiles?.[key];
    const costEl = document.getElementById(`setting${prefix}PaperCost`) as HTMLInputElement | null;
    const bwLowEl = document.getElementById(`setting${prefix}BwLow`) as HTMLInputElement | null;
    const bwMedEl = document.getElementById(`setting${prefix}BwMedium`) as HTMLInputElement | null;
    const bwHighEl = document.getElementById(`setting${prefix}BwHigh`) as HTMLInputElement | null;
    const bwVHighEl = document.getElementById(`setting${prefix}BwVeryHigh`) as HTMLInputElement | null;
    const colLowEl = document.getElementById(`setting${prefix}ColorLow`) as HTMLInputElement | null;
    const colMedEl = document.getElementById(`setting${prefix}ColorMedium`) as HTMLInputElement | null;
    const colHighEl = document.getElementById(`setting${prefix}ColorHigh`) as HTMLInputElement | null;
    const colVHighEl = document.getElementById(`setting${prefix}ColorVeryHigh`) as HTMLInputElement | null;

    if (costEl && p) costEl.value = String(p.paperCost ?? 1);
    if (bwLowEl && p) bwLowEl.value = String(p.bwPrint?.low ?? 2);
    if (bwMedEl && p) bwMedEl.value = String(p.bwPrint?.medium ?? 3);
    if (bwHighEl && p) bwHighEl.value = String(p.bwPrint?.high ?? 6);
    if (bwVHighEl && p) bwVHighEl.value = String(p.bwPrint?.very_high ?? 9);
    if (colLowEl && p) colLowEl.value = String(p.colorPrint?.low ?? 17);
    if (colMedEl && p) colMedEl.value = String(p.colorPrint?.medium ?? 19);
    if (colHighEl && p) colHighEl.value = String(p.colorPrint?.high ?? 24);
    if (colVHighEl && p) colVHighEl.value = String(p.colorPrint?.very_high ?? 29);
  };
  populateProfile('A4', 'a4');
  populateProfile('ShortBond', 'shortBond');
  populateProfile('LongBond', 'longBond');
  if (settingScanDocument) {
    settingScanDocument.value = String(settings.pricing.scanDocument);
  }
  if (settingHighQualitySurcharge) {
    settingHighQualitySurcharge.value = String(
      settings.pricingEngine?.highQualitySurcharge ??
        settings.pricing?.highQualitySurcharge ??
        2,
    );
  }
  const settingDuplexEnabled = document.getElementById(
    'settingDuplexEnabled',
  ) as HTMLInputElement | null;
  if (settingDuplexEnabled) {
    settingDuplexEnabled.checked = Boolean(settings.pricingEngine?.duplexEnabled);
  }

  // Admin Alerts (optional)
  if (alertSeverityThreshold)
    alertSeverityThreshold.value = settings.alerts.severityThreshold;
  if (alertDashboardEnabled)
    alertDashboardEnabled.checked = settings.alerts.dashboard.enabled;
  if (alertEmailEnabled)
    alertEmailEnabled.checked = settings.alerts.email.enabled;
  if (alertSmtpHost) alertSmtpHost.value = settings.alerts.email.smtpHost;
  if (alertSmtpPort)
    alertSmtpPort.value = String(settings.alerts.email.smtpPort);
  if (alertSmtpSecure) alertSmtpSecure.checked = settings.alerts.email.secure;
  if (alertEmailUsername)
    alertEmailUsername.value = settings.alerts.email.username;
  if (alertEmailFrom) alertEmailFrom.value = settings.alerts.email.from;
  if (alertEmailTo) alertEmailTo.value = settings.alerts.email.to;

  // Scan Filename Format
  const sff = settings.scanFilenameFormat ?? {
    prefix: 'PrintBit-Scan',
    dateFormat: 'YYYYMMDD',
    timeFormat: 'HHmmss',
    includeRandomSuffix: false,
    customPatternEnabled: false,
    customPattern: '{PREFIX}_{YYYY}{MM}{DD}_{HH}{mm}{ss}',
  };
  if (settingScanFilenamePrefix)
    settingScanFilenamePrefix.value = sff.prefix ?? 'PrintBit-Scan';
  if (settingScanFilenameDateFormat)
    settingScanFilenameDateFormat.value = sff.dateFormat ?? 'YYYYMMDD';
  if (settingScanFilenameTimeFormat)
    settingScanFilenameTimeFormat.value = sff.timeFormat ?? 'HHmmss';
  if (settingScanFilenameIncludeRandom)
    settingScanFilenameIncludeRandom.checked = Boolean(sff.includeRandomSuffix);
  if (settingScanFilenameCustomPatternEnabled) {
    settingScanFilenameCustomPatternEnabled.checked = Boolean(
      sff.customPatternEnabled,
    );
  }
  if (settingScanFilenameCustomPattern) {
    settingScanFilenameCustomPattern.value =
      sff.customPattern ?? '{PREFIX}_{YYYY}{MM}{DD}_{HH}{mm}{ss}';
  }
  syncScanFilenameUI();

  // Print Limits
  if (settingMaxPagesPerSession) {
    settingMaxPagesPerSession.value = String(
      settings.printLimits?.maxPagesPerSession ?? 30,
    );
  }

  // Kiosk Availability & UI Blocking
  if (settingUiBlockingEnabled) {
    settingUiBlockingEnabled.checked = Boolean(settings.uiBlocking?.enabled);
  }
  if (settingUiBlockingMode) {
    settingUiBlockingMode.value = settings.uiBlocking?.mode ?? 'maintenance';
  }
  if (settingUiBlockingMessage) {
    settingUiBlockingMessage.value = settings.uiBlocking?.customMessage ?? '';
  }

  // Scanner & ADF Resolution Settings
  if (settingCopyGlassDpi) {
    settingCopyGlassDpi.value = String(settings.scannerDpi?.copyGlass ?? 300);
  }
  if (settingCopyAdfDpi) {
    settingCopyAdfDpi.value = String(settings.scannerDpi?.copyAdf ?? 300);
  }
  if (settingScanGlassDpi) {
    settingScanGlassDpi.value = String(settings.scannerDpi?.scanGlass ?? 300);
  }
  if (settingScanAdfDpi) {
    settingScanAdfDpi.value = String(settings.scannerDpi?.scanAdf ?? 300);
  }

  // Developer Testing Mode
  if (settingDeveloperModeEnabled) {
    settingDeveloperModeEnabled.checked = Boolean(
      settings.developerMode?.enabled,
    );
  }
  currentDeveloperModeEnabled = Boolean(settings.developerMode?.enabled);

}

export function populateForm(settings: SettingsResponse): void {
  applySettings(settings);
}

function buildAlertPayload(): {
  severityThreshold: string;
  dashboard: { enabled: boolean };
  email: {
    enabled: boolean;
    smtpHost: string;
    smtpPort: number;
    secure: boolean;
    username: string;
    from: string;
    to: string;
  };
} {
  return {
    severityThreshold: alertSeverityThreshold?.value ?? 'warning',
    dashboard: {
      enabled: alertDashboardEnabled?.checked ?? false,
    },
    email: {
      enabled: alertEmailEnabled?.checked ?? false,
      smtpHost: alertSmtpHost?.value.trim() ?? '',
      smtpPort: Number(alertSmtpPort?.value ?? 0),
      secure: alertSmtpSecure?.checked ?? false,
      username: alertEmailUsername?.value.trim() ?? '',
      from: alertEmailFrom?.value.trim() ?? '',
      to: alertEmailTo?.value.trim() ?? '',
    },
  };
}

async function loadAlertStats(): Promise<void> {
  const res = await apiFetch('/api/admin/summary');
  if (!res.ok) return;
  const summary = (await res.json()) as SummaryResponse;
  updateSidebarBadges(summary);
}

async function loadData(
  options: { applyToForm?: boolean } = {},
): Promise<void> {
  const applyToForm = options.applyToForm ?? true;
  const res = await apiFetch('/api/admin/settings');
  if (!res.ok) {
    if (res.status === 401) throw new Error('Invalid admin PIN.');
    throw new Error('Failed to load settings.');
  }
  const settings = (await res.json()) as SettingsResponse;
  if (applyToForm) {
    applySettings(settings);
  }
}

settingsForm.addEventListener('input', () => {
  settingsDirty = true;
});

settingsForm.addEventListener('change', () => {
  settingsDirty = true;
});

settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const newPin = settingAdminPin.value.trim();

  // Ink monitoring validation — only when the section is present
  const lowThreshold = Number(inkLowThresholdPercent?.value ?? 0);
  const criticalThreshold = Number(inkCriticalThresholdPercent?.value ?? 0);

  if (inkLowThresholdPercent && inkCriticalThresholdPercent) {
    const isValidPercent = (n: number): boolean =>
      Number.isInteger(n) && n >= 0 && n <= 100;

    if (!isValidPercent(lowThreshold) || !isValidPercent(criticalThreshold)) {
      setMessage('Ink thresholds must be whole numbers from 0 to 100.');
      return;
    }
    if (criticalThreshold > lowThreshold) {
      setMessage(
        'Critical threshold must be less than or equal to low threshold.',
      );
      return;
    }
  }

  const rollingWindowDays = Number(settingRollingWindowDays?.value ?? 0);
  const alertDaysThreshold = Number(settingAlertDaysThreshold?.value ?? 0);
  const paperTrayCapacitySheets = Number(
    settingPaperTrayCapacitySheets?.value ?? 0,
  );
  const paperCurrentSheets = Number(settingPaperCurrentSheets?.value ?? 0);

  if (
    settingRollingWindowDays &&
    (!Number.isInteger(rollingWindowDays) ||
      rollingWindowDays < 1 ||
      rollingWindowDays > 90)
  ) {
    setMessage('Rolling window must be a whole number between 1 and 90.');
    return;
  }
  if (
    settingAlertDaysThreshold &&
    (!Number.isInteger(alertDaysThreshold) ||
      alertDaysThreshold < 1 ||
      alertDaysThreshold > 60)
  ) {
    setMessage('Alert threshold must be a whole number between 1 and 60.');
    return;
  }
  if (
    settingPaperTrayCapacitySheets &&
    (!Number.isInteger(paperTrayCapacitySheets) || paperTrayCapacitySheets < 1)
  ) {
    setMessage('Tray capacity must be a whole number greater than 0.');
    return;
  }
  if (
    settingPaperCurrentSheets &&
    (!Number.isInteger(paperCurrentSheets) || paperCurrentSheets < 0)
  ) {
    setMessage(
      'Current paper must be a whole number greater than or equal to 0.',
    );
    return;
  }

  const isWholePeso = (n: number): boolean => Number.isInteger(n) && n >= 0;

  const validateProfile = (
    prefix: 'A4' | 'ShortBond' | 'LongBond',
    label: string,
  ): PaperPricingProfile | null => {
    const costEl = document.getElementById(`setting${prefix}PaperCost`) as HTMLInputElement | null;
    const bwLowEl = document.getElementById(`setting${prefix}BwLow`) as HTMLInputElement | null;
    const bwMedEl = document.getElementById(`setting${prefix}BwMedium`) as HTMLInputElement | null;
    const bwHighEl = document.getElementById(`setting${prefix}BwHigh`) as HTMLInputElement | null;
    const bwVHighEl = document.getElementById(`setting${prefix}BwVeryHigh`) as HTMLInputElement | null;
    const colLowEl = document.getElementById(`setting${prefix}ColorLow`) as HTMLInputElement | null;
    const colMedEl = document.getElementById(`setting${prefix}ColorMedium`) as HTMLInputElement | null;
    const colHighEl = document.getElementById(`setting${prefix}ColorHigh`) as HTMLInputElement | null;
    const colVHighEl = document.getElementById(`setting${prefix}ColorVeryHigh`) as HTMLInputElement | null;

    const paperCost = Number(costEl?.value ?? 0);
    const bwLow = Number(bwLowEl?.value ?? 0);
    const bwMed = Number(bwMedEl?.value ?? 0);
    const bwHigh = Number(bwHighEl?.value ?? 0);
    const bwVHigh = Number(bwVHighEl?.value ?? 0);
    const colLow = Number(colLowEl?.value ?? 0);
    const colMed = Number(colMedEl?.value ?? 0);
    const colHigh = Number(colHighEl?.value ?? 0);
    const colVHigh = Number(colVHighEl?.value ?? 0);

    const values = [paperCost, bwLow, bwMed, bwHigh, bwVHigh, colLow, colMed, colHigh, colVHigh];
    if (values.some((v) => !isWholePeso(v))) {
      setMessage(`${label} prices must be whole peso values >= 0 (no decimals).`);
      return null;
    }

    if (bwMed < bwLow || bwHigh < bwMed || bwVHigh < bwHigh) {
      setMessage(`${label} B&W tier rates must be non-decreasing (Low <= Med <= High <= Max).`);
      return null;
    }

    if (colMed < colLow || colHigh < colMed || colVHigh < colHigh) {
      setMessage(`${label} Color tier rates must be non-decreasing (Low <= Med <= High <= Max).`);
      return null;
    }

    if (colLow < bwLow || colMed < bwMed || colHigh < bwHigh || colVHigh < bwVHigh) {
      setMessage(`${label} Color rates cannot be less than B&W rates for the same tier.`);
      return null;
    }

    return {
      paperCost,
      bwPrint: { low: bwLow, medium: bwMed, high: bwHigh, very_high: bwVHigh },
      colorPrint: { low: colLow, medium: colMed, high: colHigh, very_high: colVHigh },
    };
  };

  const a4Profile = validateProfile('A4', 'A4');
  if (!a4Profile) return;
  const shortBondProfile = validateProfile('ShortBond', 'Short Bond');
  if (!shortBondProfile) return;
  const longBondProfile = validateProfile('LongBond', 'Long Bond');
  if (!longBondProfile) return;

  const scanDocumentPrice = Number(settingScanDocument?.value ?? 0);
  const highQualitySurcharge = Number(settingHighQualitySurcharge?.value ?? 0);

  if (settingScanDocument && !isWholePeso(scanDocumentPrice)) {
    setMessage('Scan document rate must be a whole peso value (no decimals).');
    return;
  }
  if (settingHighQualitySurcharge && !isWholePeso(highQualitySurcharge)) {
    setMessage(
      'High quality surcharge must be a whole peso value (no decimals).',
    );
    return;
  }

  const payload: Record<string, unknown> = {
    pricing: {
      printPerPage: shortBondProfile.bwPrint.low,
      scanDocument: scanDocumentPrice,
      colorSurcharge: shortBondProfile.colorPrint.low - shortBondProfile.bwPrint.low,
      highQualitySurcharge,
    },
    pricingEngine: {
      paperProfiles: {
        a4: a4Profile,
        shortBond: shortBondProfile,
        longBond: longBondProfile,
      },
      highQualitySurcharge,
      duplexEnabled: Boolean(
        (document.getElementById('settingDuplexEnabled') as HTMLInputElement | null)?.checked,
      ),
    },
    adminLocalOnly: settingAdminLocalOnly
      ? settingAdminLocalOnly.checked
      : loadedAdminLocalOnly,
    ...(newPin ? { adminPin: newPin } : {}),
    pipelineSettings: {
      malwareScanningEnabled: settingMalwareScanning?.checked ?? true,
      documentConversionEnabled: settingDocumentConversion?.checked ?? true,
      colorDetectionEnabled: settingColorDetection?.checked ?? true,
    },
  };

  if (settingScanFilenamePrefix) {
    const prefixVal = settingScanFilenamePrefix.value.trim();
    if (prefixVal.length > 50) {
      setMessage('Scan filename prefix cannot exceed 50 characters.');
      return;
    }
    const customPatternVal =
      settingScanFilenameCustomPattern?.value.trim() ?? '';
    if (customPatternVal.length > 100) {
      setMessage('Scan filename custom pattern cannot exceed 100 characters.');
      return;
    }

    payload.scanFilenameFormat = {
      prefix: prefixVal || 'PrintBit-Scan',
      dateFormat: settingScanFilenameDateFormat?.value || 'YYYYMMDD',
      timeFormat: settingScanFilenameTimeFormat?.value || 'HHmmss',
      includeRandomSuffix: settingScanFilenameIncludeRandom?.checked ?? false,
      customPatternEnabled:
        settingScanFilenameCustomPatternEnabled?.checked ?? false,
      customPattern: customPatternVal || '{PREFIX}_{YYYY}{MM}{DD}_{HH}{mm}{ss}',
    };
  }

  if (settingIdleTimeout) {
    const idleTimeoutValue = Number(settingIdleTimeout.value);
    if (
      !Number.isInteger(idleTimeoutValue) ||
      idleTimeoutValue < 60 ||
      idleTimeoutValue > 3600
    ) {
      setMessage(
        'Idle timeout must be a whole number between 60 and 3600 seconds.',
      );
      return;
    }
    payload.idleTimeoutSeconds = idleTimeoutValue;
  }

  if (settingIdleScreenTimeout) {
    const idleScreenTimeoutValue = Number(settingIdleScreenTimeout.value);
    if (
      !Number.isInteger(idleScreenTimeoutValue) ||
      idleScreenTimeoutValue < 10 ||
      idleScreenTimeoutValue > 600
    ) {
      setMessage(
        'Idle screen timeout must be a whole number between 10 and 600 seconds.',
      );
      return;
    }
    payload.idleScreenTimeoutSeconds = idleScreenTimeoutValue;
  }

  if (inkMonitoringEnabled) {
    payload.inkMonitoring = {
      enabled: inkMonitoringEnabled.checked,
      targetPrinterName: inkTargetPrinterName?.value.trim() || null,
      lowThresholdPercent: lowThreshold,
      criticalThresholdPercent: criticalThreshold,
      blockOnLow: inkBlockOnLow?.checked ?? false,
      blockOnEmpty: inkBlockOnEmpty?.checked ?? false,
      telemetryUnknownPolicy:
        inkTelemetryUnknownPolicy?.value === 'block' ? 'block' : 'warn_allow',
    };
  }

  if (settingConsumablesForecastingEnabled) {
    payload.consumablesForecasting = {
      enabled: settingConsumablesForecastingEnabled.checked,
      rollingWindowDays,
      alertDaysThreshold,
      paperTrayCapacitySheets,
      paperCurrentSheets,
    };
  }

  // Print Limits
  if (settingMaxPagesPerSession) {
    const maxPages = Number(settingMaxPagesPerSession.value);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) {
      setMessage(
        'Max pages per session must be a whole number between 1 and 500.',
      );
      return;
    }
    payload.printLimits = {
      maxPagesPerSession: maxPages,
    };
  }

  // Kiosk Availability & UI Blocking
  if (settingUiBlockingEnabled && settingUiBlockingMode) {
    const modeVal = settingUiBlockingMode.value;
    if (
      modeVal !== 'maintenance' &&
      modeVal !== 'needs_admin' &&
      modeVal !== 'out_of_service'
    ) {
      setMessage(
        'UI blocking mode must be "maintenance", "needs_admin", or "out_of_service".',
      );
      return;
    }
    const customMessageVal = settingUiBlockingMessage?.value.trim() ?? '';
    if (customMessageVal.length > 250) {
      setMessage('UI blocking custom message cannot exceed 250 characters.');
      return;
    }
    payload.uiBlocking = {
      enabled: settingUiBlockingEnabled.checked,
      mode: modeVal as 'maintenance' | 'needs_admin' | 'out_of_service',
      customMessage: customMessageVal,
    };
  }

  // Scanner & ADF Resolution Settings
  if (
    settingCopyGlassDpi &&
    settingCopyAdfDpi &&
    settingScanGlassDpi &&
    settingScanAdfDpi
  ) {
    const copyGlass = Number(settingCopyGlassDpi.value);
    const copyAdf = Number(settingCopyAdfDpi.value);
    const scanGlass = Number(settingScanGlassDpi.value);
    const scanAdf = Number(settingScanAdfDpi.value);
    const validDpis = [150, 300, 600];
    if (
      !validDpis.includes(copyGlass) ||
      !validDpis.includes(copyAdf) ||
      !validDpis.includes(scanGlass) ||
      !validDpis.includes(scanAdf)
    ) {
      setMessage('Scanner DPI resolutions must be 150, 300, or 600.');
      return;
    }
    payload.scannerDpi = {
      copyGlass: copyGlass as 150 | 300 | 600,
      copyAdf: copyAdf as 150 | 300 | 600,
      scanGlass: scanGlass as 150 | 300 | 600,
      scanAdf: scanAdf as 150 | 300 | 600,
    };
  }

  // Developer Testing Mode
  if (settingDeveloperModeEnabled) {
    const devModeEnabled = settingDeveloperModeEnabled.checked;
    if (devModeEnabled && !currentDeveloperModeEnabled) {
      const confirmed = window.confirm(
        'Enabling Developer Testing Mode will tag transactions as test environment and isolate them from production earnings. Proceed?',
      );
      if (!confirmed) {
        return;
      }
    }
    payload.developerMode = {
      enabled: devModeEnabled,
    };
  }


  const alertPayload =
    alertSeverityThreshold !== null ? buildAlertPayload() : null;

  setMessage('Saving settings...');

  const settingsFetch = apiFetch('/api/admin/settings', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  const alertsFetch = alertPayload
    ? apiFetch('/api/admin/alert-settings', {
        method: 'PUT',
        body: JSON.stringify(alertPayload),
      })
    : Promise.resolve(null);

  void Promise.all([settingsFetch, alertsFetch])
    .then(async ([settingsResponse, alertsResponse]) => {
      if (
        !settingsResponse.ok ||
        (alertsResponse !== null && !alertsResponse.ok)
      ) {
        let serverError: string | undefined;
        if (!settingsResponse.ok) {
          try {
            const errBody = (await settingsResponse.json()) as {
              error?: string;
            };
            serverError = errBody.error;
          } catch {
            // ignore
          }
        } else if (alertsResponse !== null && !alertsResponse.ok) {
          try {
            const errBody = (await alertsResponse.json()) as { error?: string };
            serverError = errBody.error;
          } catch {
            // ignore
          }
        }
        throw new Error(serverError || 'Failed to save settings.');
      }
      settingsDirty = false;
      if (newPin) setAdminPin(newPin);
      await loadData({ applyToForm: true });
      await loadAlertStats();
      setMessage('Settings saved.');
    })
    .catch((error: unknown) => {
      const msg =
        error instanceof Error ? error.message : 'Failed to save settings.';
      setMessage(msg);
    });
});

refreshBtn.addEventListener('click', () => {
  setMessage('Refreshing...');
  settingsDirty = false;
  void Promise.all([loadData({ applyToForm: true }), loadAlertStats()])
    .then(() => setMessage('Settings refreshed.'))
    .catch((e: unknown) =>
      setMessage(e instanceof Error ? e.message : 'Refresh failed.'),
    );
});

testEmailAlertBtn?.addEventListener('click', () => {
  setMessage('Sending test email alert...');
  void apiFetch('/api/admin/alert-settings/test', {
    method: 'POST',
    body: JSON.stringify(buildAlertPayload()),
  })
    .then(async (response) => {
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? 'Failed to send test email alert.');
      }
      setMessage('Test email alert sent.');
    })
    .catch((error: unknown) => {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Failed to send test email alert.',
      );
    });
});

function showRefreshError(error: unknown): void {
  setMessage(
    error instanceof Error ? error.message : 'Automatic refresh failed.',
  );
}

initAuth(async (signal) => {
  await loadData({ applyToForm: true });
  if (signal.aborted) return;
  await loadAlertStats().catch(showRefreshError);
  if (signal.aborted) return;
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => {
    void loadData({ applyToForm: !settingsDirty }).catch(showRefreshError);
    void loadAlertStats().catch(showRefreshError);
  }, 10_000);
});
