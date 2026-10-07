
export interface PrintConsumptionEvent {
  transactionId: string;
  idempotencyFingerprint: string;
  mode: 'print' | 'copy';
  printerName: string | null;
  outcome: 'success' | 'retryable_failure' | 'non_retryable_failure';
  copies: number;
  colorPages: number;
  bwPages: number;
  equivalentBwPages: number;
  recordedAt: string;
}

export interface PerPrinterThresholdConfig {
  printerName: string;
  thresholdPercentage: number | null;
  supplyOverrides?: {
    [supplyName: string]: number;
  };
  updatedAt: string;
}

export interface ThresholdIncident {
  id: string;
  printerName: string;
  supplyName: string | null;
  type: 'threshold_triggered' | 'threshold_recovered';
  levelPercentage: number;
  thresholdPercentage: number;
  fingerprint: string;
  recordedAt: string;
  notes?: string;
}

export function buildConsumptionFingerprint(
  transactionId: string,
  spoolerCorrelationKey: string,
): string {
  const combined = `${transactionId}:${spoolerCorrelationKey}`;
  return combined;
}

export function buildThresholdFingerprint(
  printerName: string,
  supplyName: string | null,
  levelPercentage: number,
  incidentType: 'threshold_triggered' | 'threshold_recovered',
): string {
  const roundedLevel = Math.round(levelPercentage);
  const supply = supplyName ?? 'paper';
  return `${printerName}:${supply}:${roundedLevel}:${incidentType}`;
}

export function isTerminalConsumptionOutcome(
  outcome: 'success' | 'retryable_failure' | 'non_retryable_failure',
): boolean {
  return outcome === 'success' || outcome === 'non_retryable_failure';
}
