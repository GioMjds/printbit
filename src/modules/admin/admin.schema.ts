import type {
  LogMeta,
  TrustedTimestampMeta,
  SupportedLanguage,
  PrintMode,
  ColorMode,
  PrintQuality,
} from '@/core/database/shared.schema';

export type {
  LogMeta,
  TrustedTimestampMeta,
  SupportedLanguage,
  PrintMode,
  ColorMode,
  PrintQuality,
};

export type AdminLockout = {
  failedAttempts: number;
  lockedUntil: string | null;
};

export interface PricingSettings {
  printPerPage: number;
  copyPerPage: number;
  scanDocument: number;
  colorSurcharge: number;
  highQualitySurcharge: number;
}

export interface PricingEnginePaperProfile {
  baseBwPrice: number;
  baseColorPrice: number;
}

export interface PricingEngineBulkDiscountTier {
  minPages: number;
  maxPages?: number;
  discountPerPage: number;
}

export interface PricingEngineSettings {
  paperProfiles: {
    a4: PricingEnginePaperProfile;
    shortBond: PricingEnginePaperProfile;
    longBond: PricingEnginePaperProfile;
  };
  bulkDiscountTiers: PricingEngineBulkDiscountTier[];
  rounding: 'whole_peso_total_only';
  highQualitySurcharge: number;
}

export type InkTelemetryUnknownPolicy = 'warn_allow' | 'block';

export interface InkMonitoringSettings {
  enabled: boolean;
  targetPrinterName: string | null;
  lowThresholdPercent: number;
  criticalThresholdPercent: number;
  blockOnLow: boolean;
  blockOnEmpty: boolean;
  telemetryUnknownPolicy: InkTelemetryUnknownPolicy;
}

export interface ConsumablesForecastingSettings {
  enabled: boolean;
  rollingWindowDays: number;
  alertDaysThreshold: number;
  paperTrayCapacitySheets: number;
  paperCurrentSheets: number;
  paperRefillUpdatedAt: string | null;
}

export interface ConsumableEstimationCoefficients {
  bwBlack: number;
  colorCyan: number;
  colorMagenta: number;
  colorYellow: number;
  colorBlack: number;
}

export interface ConsumableEstimationSettings {
  defaultCoefficients: ConsumableEstimationCoefficients;
  printerOverrides: Record<string, Partial<ConsumableEstimationCoefficients>>;
}

export interface KioskPreferences {
  language: SupportedLanguage;
  highContrast: boolean;
}

export type AlertChannel = 'dashboard' | 'email';
export type AnomalySeverity = 'warning' | 'critical';
export type AnomalyStatus = 'open' | 'acknowledged' | 'resolved';
export type AnomalyCategory =
  | 'printer'
  | 'spooler'
  | 'serial'
  | 'hopper'
  | 'network'
  | 'security';

export interface AlertDashboardSettings {
  enabled: boolean;
}

export interface AlertEmailSettings {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  secure: boolean;
  username: string;
  from: string;
  to: string;
}

export interface AlertDedupeSettings {
  printerMs: number;
  spoolerMs: number;
  serialMs: number;
  hopperMs: number;
  networkMs: number;
  securityMs: number;
}

export interface AlertSettings {
  severityThreshold: AnomalySeverity;
  dashboard: AlertDashboardSettings;
  email: AlertEmailSettings;
  dedupe: AlertDedupeSettings;
}

export interface PipelineSettings {
  malwareScanningEnabled: boolean;
  documentConversionEnabled: boolean;
  colorDetectionEnabled: boolean;
}

export interface AdminSettings {
  pricing: PricingSettings;
  pricingEngine: PricingEngineSettings;
  idleTimeoutSeconds: number;
  idleScreenTimeoutSeconds: number;
  adminPin: string;
  adminLocalOnly: boolean;
  kioskPreferences: KioskPreferences;
  alerts: AlertSettings;
  inkMonitoring: InkMonitoringSettings;
  consumablesForecasting: ConsumablesForecastingSettings;
  consumableEstimation: ConsumableEstimationSettings;
  pipelineSettings?: PipelineSettings;
}

export interface AdminLogEntry {
  id: string;
  timestamp: string;
  timestampMeta?: TrustedTimestampMeta;
  type: string;
  message: string;
  meta?: LogMeta;
}
