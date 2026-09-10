export interface MaintenanceReceiptViewInput {
  transactionId?: string | null;
  receiptUrl?: string | null;
  receiptExpiresAt?: string | null;
}

export interface MaintenanceReceiptView {
  transactionId: string;
  receipt: {
    url: string;
    expiresAt: string | null;
  } | null;
}

const MAINTENANCE_PRINT_FAILURE_CODES = new Set([
  'PAPER_INSUFFICIENT_PRE_DISPATCH',
  'PAPER_INSUFFICIENT_MID_JOB',
  'PAPER_TRAY_EMPTY',
  'PAPER_JAM_PRINT',
  'PRINTER_DOOR_OPEN',
  'PRINTER_HARDWARE_ERROR',
  'WORKER_HARDWARE_ERROR',
  'WORKER_PRINT_FAILED',
]);

function normalizeOptionalValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function isMaintenancePrintFailure(
  code?: string | null,
  message?: string | null,
): boolean {
  if (code && MAINTENANCE_PRINT_FAILURE_CODES.has(code)) return true;
  if (!code && !message) return false;
  if (code === 'PRINTER_LOW_INK' && !message) return false;
  const combined = `${code ?? ''} ${message ?? ''}`.toLowerCase();
  return (
    combined.includes('hardware error') ||
    combined.includes('post-clear') ||
    combined.includes('paper out') ||
    combined.includes('paper_out') ||
    combined.includes('incorrect loading') ||
    combined.includes('paper jam') ||
    combined.includes('paper_jam') ||
    combined.includes('door open') ||
    combined.includes('cover open')
  );
}

export function buildMaintenanceReceiptView(
  input: MaintenanceReceiptViewInput,
): MaintenanceReceiptView {
  const receiptUrl = normalizeOptionalValue(input.receiptUrl);

  return {
    transactionId:
      normalizeOptionalValue(input.transactionId) ?? 'Pending verification',
    receipt: receiptUrl
      ? {
          url: receiptUrl,
          expiresAt: normalizeOptionalValue(input.receiptExpiresAt),
        }
      : null,
  };
}
