import {
  SettingsResponse,
  SummaryResponse,
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

// ── Pricing Engine settings ──────────────────
const settingA4BwPrice = document.getElementById(
  'settingA4BwPrice',
) as HTMLInputElement | null;
const settingA4ColorPrice = document.getElementById(
  'settingA4ColorPrice',
) as HTMLInputElement | null;
const settingShortBondBwPrice = document.getElementById(
  'settingShortBondBwPrice',
) as HTMLInputElement | null;
const settingShortBondColorPrice = document.getElementById(
  'settingShortBondColorPrice',
) as HTMLInputElement | null;
const settingLongBondBwPrice = document.getElementById(
  'settingLongBondBwPrice',
) as HTMLInputElement | null;
const settingLongBondColorPrice = document.getElementById(
  'settingLongBondColorPrice',
) as HTMLInputElement | null;
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
const openAlertBadge = document.getElementById(
  'openAlertBadge',
) as HTMLElement | null;
const openAlertBadgeMob = document.getElementById(
  'openAlertBadgeMob',
) as HTMLElement | null;

const refreshBtn = document.getElementById('refreshBtn') as HTMLButtonElement;
let refreshTimer: number | null = null;
let loadedAdminLocalOnly: boolean = false;
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
  const customEnabled = settingScanFilenameCustomPatternEnabled?.checked ?? false;
  const customPattern = settingScanFilenameCustomPattern?.value.trim() || '{PREFIX}_{YYYY}{MM}{DD}_{HH}{mm}{ss}';
  const dateFormat = settingScanFilenameDateFormat?.value ?? 'YYYYMMDD';
  const timeFormat = settingScanFilenameTimeFormat?.value ?? 'HHmmss';
  const includeRandom = settingScanFilenameIncludeRandom?.checked ?? false;

  let baseName = '';
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

  const finalName = (cleaned.length > 0 ? cleaned : 'PrintBit-Scan') + '.pdf';
  scanFilenamePreviewText.textContent = finalName;
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
      if (customPatternContainer) {
        customPatternContainer.classList.toggle(
          'hidden',
          !settingScanFilenameCustomPatternEnabled.checked,
        );
      }
    }
    renderScanFilenamePreview();
  };
  el.addEventListener('input', update);
  el.addEventListener('change', update);
});

document.querySelectorAll('.token-tag').forEach((tag) => {
  tag.addEventListener('click', () => {
    const token = tag.getAttribute('data-token');
    if (!token || !settingScanFilenameCustomPattern) return;
    const start = settingScanFilenameCustomPattern.selectionStart ?? settingScanFilenameCustomPattern.value.length;
    const end = settingScanFilenameCustomPattern.selectionEnd ?? settingScanFilenameCustomPattern.value.length;
    const current = settingScanFilenameCustomPattern.value;
    settingScanFilenameCustomPattern.value = current.slice(0, start) + token + current.slice(end);
    settingScanFilenameCustomPattern.focus();
    settingScanFilenameCustomPattern.setSelectionRange(start + token.length, start + token.length);
    renderScanFilenamePreview();
  });
});


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
  if (settingA4BwPrice) {
    settingA4BwPrice.value = String(
      settings.pricingEngine.paperProfiles.a4.baseBwPrice,
    );
  }
  if (settingA4ColorPrice) {
    settingA4ColorPrice.value = String(
      settings.pricingEngine.paperProfiles.a4.baseColorPrice,
    );
  }
  if (settingShortBondBwPrice) {
    settingShortBondBwPrice.value = String(
      settings.pricingEngine.paperProfiles.shortBond.baseBwPrice,
    );
  }
  if (settingShortBondColorPrice) {
    settingShortBondColorPrice.value = String(
      settings.pricingEngine.paperProfiles.shortBond.baseColorPrice,
    );
  }
  if (settingLongBondBwPrice) {
    settingLongBondBwPrice.value = String(
      settings.pricingEngine.paperProfiles.longBond.baseBwPrice,
    );
  }
  if (settingLongBondColorPrice) {
    settingLongBondColorPrice.value = String(
      settings.pricingEngine.paperProfiles.longBond.baseColorPrice,
    );
  }
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
  if (settings.scanFilenameFormat) {
    const sff = settings.scanFilenameFormat;
    if (settingScanFilenamePrefix) settingScanFilenamePrefix.value = sff.prefix ?? 'PrintBit-Scan';
    if (settingScanFilenameDateFormat) settingScanFilenameDateFormat.value = sff.dateFormat ?? 'YYYYMMDD';
    if (settingScanFilenameTimeFormat) settingScanFilenameTimeFormat.value = sff.timeFormat ?? 'HHmmss';
    if (settingScanFilenameIncludeRandom) settingScanFilenameIncludeRandom.checked = Boolean(sff.includeRandomSuffix);
    if (settingScanFilenameCustomPatternEnabled) {
      settingScanFilenameCustomPatternEnabled.checked = Boolean(sff.customPatternEnabled);
      if (customPatternContainer) {
        customPatternContainer.classList.toggle('hidden', !sff.customPatternEnabled);
      }
    }
    if (settingScanFilenameCustomPattern) {
      settingScanFilenameCustomPattern.value = sff.customPattern ?? '{PREFIX}_{YYYY}{MM}{DD}_{HH}{mm}{ss}';
    }
    renderScanFilenamePreview();
  }

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

  // Pricing configuration values
  const a4BwPrice = Number(settingA4BwPrice?.value ?? 0);
  const a4ColorPrice = Number(settingA4ColorPrice?.value ?? 0);
  const shortBondBwPrice = Number(settingShortBondBwPrice?.value ?? 0);
  const shortBondColorPrice = Number(settingShortBondColorPrice?.value ?? 0);
  const longBondBwPrice = Number(settingLongBondBwPrice?.value ?? 0);
  const longBondColorPrice = Number(settingLongBondColorPrice?.value ?? 0);
  const scanDocumentPrice = Number(settingScanDocument?.value ?? 0);
  const highQualitySurcharge = Number(settingHighQualitySurcharge?.value ?? 0);

  const isWholePeso = (n: number): boolean => Number.isInteger(n) && n >= 0;

  if (settingA4BwPrice && !isWholePeso(a4BwPrice)) {
    setMessage('A4 B&W price must be a whole peso value (no decimals).');
    return;
  }
  if (settingA4ColorPrice && !isWholePeso(a4ColorPrice)) {
    setMessage('A4 Color price must be a whole peso value (no decimals).');
    return;
  }
  if (settingA4BwPrice && settingA4ColorPrice && a4ColorPrice < a4BwPrice) {
    setMessage('A4 Color price cannot be less than B&W price.');
    return;
  }

  if (settingShortBondBwPrice && !isWholePeso(shortBondBwPrice)) {
    setMessage('Short (Letter) B&W price must be a whole peso value (no decimals).');
    return;
  }
  if (settingShortBondColorPrice && !isWholePeso(shortBondColorPrice)) {
    setMessage('Short (Letter) Color price must be a whole peso value (no decimals).');
    return;
  }
  if (
    settingShortBondBwPrice &&
    settingShortBondColorPrice &&
    shortBondColorPrice < shortBondBwPrice
  ) {
    setMessage('Short (Letter) Color price cannot be less than B&W price.');
    return;
  }

  if (settingLongBondBwPrice && !isWholePeso(longBondBwPrice)) {
    setMessage('Long (Legal) B&W price must be a whole peso value (no decimals).');
    return;
  }
  if (settingLongBondColorPrice && !isWholePeso(longBondColorPrice)) {
    setMessage('Long (Legal) Color price must be a whole peso value (no decimals).');
    return;
  }
  if (
    settingLongBondBwPrice &&
    settingLongBondColorPrice &&
    longBondColorPrice < longBondBwPrice
  ) {
    setMessage('Long (Legal) Color price cannot be less than B&W price.');
    return;
  }

  if (settingScanDocument && !isWholePeso(scanDocumentPrice)) {
    setMessage('Scan document rate must be a whole peso value (no decimals).');
    return;
  }
  if (settingHighQualitySurcharge && !isWholePeso(highQualitySurcharge)) {
    setMessage('High quality surcharge must be a whole peso value (no decimals).');
    return;
  }

  const payload: Record<string, unknown> = {
    pricing: {
      printPerPage: shortBondBwPrice,
      scanDocument: scanDocumentPrice,
      colorSurcharge: shortBondColorPrice - shortBondBwPrice,
      highQualitySurcharge,
    },
    pricingEngine: {
      paperProfiles: {
        a4: {
          baseBwPrice: a4BwPrice,
          baseColorPrice: a4ColorPrice,
        },
        shortBond: {
          baseBwPrice: shortBondBwPrice,
          baseColorPrice: shortBondColorPrice,
        },
        longBond: {
          baseBwPrice: longBondBwPrice,
          baseColorPrice: longBondColorPrice,
        },
      },
      highQualitySurcharge,
    },
    adminLocalOnly: settingAdminLocalOnly
      ? settingAdminLocalOnly.checked
      : loadedAdminLocalOnly,
    ...(newPin ? { adminPin: newPin } : {}),
  };

  if (settingScanFilenamePrefix) {
    const prefixVal = settingScanFilenamePrefix.value.trim();
    if (prefixVal.length > 50) {
      setMessage('Scan filename prefix cannot exceed 50 characters.');
      return;
    }
    const customPatternVal = settingScanFilenameCustomPattern?.value.trim() ?? '';
    if (customPatternVal.length > 100) {
      setMessage('Scan filename custom pattern cannot exceed 100 characters.');
      return;
    }

    payload.scanFilenameFormat = {
      prefix: prefixVal || 'PrintBit-Scan',
      dateFormat: settingScanFilenameDateFormat?.value || 'YYYYMMDD',
      timeFormat: settingScanFilenameTimeFormat?.value || 'HHmmss',
      includeRandomSuffix: settingScanFilenameIncludeRandom?.checked ?? false,
      customPatternEnabled: settingScanFilenameCustomPatternEnabled?.checked ?? false,
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
      setMessage('Idle timeout must be a whole number between 60 and 3600 seconds.');
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

  const alertPayload =
    alertSeverityThreshold !== null ? buildAlertPayload() : null;

  setMessage('Saving settings...');

  const settingsFetch = apiFetch('/api/admin/settings', {
    method: 'PUT',
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
            const errBody = (await settingsResponse.json()) as { error?: string };
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
