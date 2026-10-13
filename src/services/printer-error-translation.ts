import {
  PRINTER_ERROR_CATALOG,
  getPrinterErrorDefinition,
  type PrinterErrorCode,
  type PrinterErrorTier,
} from '@/shared/printer-error-catalog';

export interface TranslatedPrinterError {
  code: PrinterErrorCode | 'PAPER_JAM_PRINT';
  tier: PrinterErrorTier;
  severity: 'warning' | 'recoverable' | 'fatal';
  userMessage: string;
  canRetry: boolean;
  canDismiss: boolean;
  autoClear: boolean;
  locksCoinSlot: boolean;
  lookAtPrinterScreen: boolean;
}

/**
 * Converts the worker's printer telemetry into an actionable kiosk error.
 * Epson's monitor can supply only the WMI DetectedErrorState number, so it
 * must be considered alongside the human-readable message.
 */
export function translateHardwarePrinterError(input: {
  message?: string | null;
  errorCode?: string | null;
}): TranslatedPrinterError {
  const lower = `${input.message ?? ''} ${input.errorCode ?? ''}`.toLowerCase();
  const matchesCode = (code: number) =>
    input.errorCode?.trim() === String(code) ||
    lower.includes(`code ${code}`) ||
    lower.includes(`detectederrorstate ${code}`);

  // Paper Jam has its own flow and modal (out of scope for non-paper-jam guide)
  if (
    matchesCode(8) ||
    lower.includes('jammed') ||
    lower.includes('paper_jam') ||
    lower.includes('paper jam')
  ) {
    return {
      code: 'PAPER_JAM_PRINT',
      tier: 'Customer',
      severity: 'recoverable',
      userMessage: 'Paper jam detected in the printer.',
      canRetry: true,
      canDismiss: false,
      autoClear: true,
      locksCoinSlot: true,
      lookAtPrinterScreen: true,
    };
  }

  // Cover / Door Open (Customer Tier)
  if (
    matchesCode(7) ||
    lower.includes('door open') ||
    lower.includes('door_open') ||
    lower.includes('cover open')
  ) {
    const def = PRINTER_ERROR_CATALOG.E_COVER_OPEN;
    return {
      code: def.code,
      tier: def.tier,
      severity: 'recoverable',
      userMessage: def.what.en,
      canRetry: true,
      canDismiss: false,
      autoClear: def.autoClear,
      locksCoinSlot: def.locksCoinSlot,
      lookAtPrinterScreen: def.lookAtPrinterScreen,
    };
  }

  // Output Tray Full / Closed (Customer Tier)
  if (
    matchesCode(11) ||
    lower.includes('output_bin_full') ||
    lower.includes('output bin full') ||
    lower.includes('tray closed')
  ) {
    const def = PRINTER_ERROR_CATALOG.E_OUTPUT_TRAY;
    return {
      code: def.code,
      tier: def.tier,
      severity: 'recoverable',
      userMessage: def.what.en,
      canRetry: true,
      canDismiss: false,
      autoClear: def.autoClear,
      locksCoinSlot: def.locksCoinSlot,
      lookAtPrinterScreen: def.lookAtPrinterScreen,
    };
  }

  // Paper Empty / Loading (Staff Tier)
  if (
    matchesCode(4) ||
    lower.includes('no paper') ||
    lower.includes('low paper') ||
    lower.includes('paper_out') ||
    lower.includes('paper out')
  ) {
    const def = PRINTER_ERROR_CATALOG.E_NO_PAPER;
    return {
      code: def.code,
      tier: def.tier,
      severity: 'recoverable',
      userMessage: def.what.en,
      canRetry: true,
      canDismiss: false,
      autoClear: def.autoClear,
      locksCoinSlot: def.locksCoinSlot,
      lookAtPrinterScreen: def.lookAtPrinterScreen,
    };
  }

  // Paper Setup / Configuration Prompt (Staff Tier)
  if (
    lower.includes('paper setup') ||
    lower.includes('paper size') ||
    lower.includes('paper type')
  ) {
    const def = PRINTER_ERROR_CATALOG.E_PAPER_SETUP;
    return {
      code: def.code,
      tier: def.tier,
      severity: 'recoverable',
      userMessage: def.what.en,
      canRetry: true,
      canDismiss: false,
      autoClear: def.autoClear,
      locksCoinSlot: def.locksCoinSlot,
      lookAtPrinterScreen: def.lookAtPrinterScreen,
    };
  }

  // Ink Empty / Cartridge problem (Staff Tier)
  if (
    matchesCode(5) ||
    matchesCode(6) ||
    lower.includes('no toner') ||
    lower.includes('ink out') ||
    lower.includes('no ink')
  ) {
    const def = PRINTER_ERROR_CATALOG.E_INK_OUT;
    return {
      code: def.code,
      tier: def.tier,
      severity: 'fatal',
      userMessage: def.what.en,
      canRetry: false,
      canDismiss: false,
      autoClear: def.autoClear,
      locksCoinSlot: def.locksCoinSlot,
      lookAtPrinterScreen: def.lookAtPrinterScreen,
    };
  }

  // Offline / Disconnected (Staff Tier)
  if (
    matchesCode(9) ||
    lower.includes('offline') ||
    lower.includes('not available') ||
    lower.includes('stopped printing') ||
    lower.includes('not found')
  ) {
    const def = PRINTER_ERROR_CATALOG.E_OFFLINE;
    return {
      code: def.code,
      tier: def.tier,
      severity: 'fatal',
      userMessage: def.what.en,
      canRetry: false,
      canDismiss: false,
      autoClear: def.autoClear,
      locksCoinSlot: def.locksCoinSlot,
      lookAtPrinterScreen: def.lookAtPrinterScreen,
    };
  }

  // Service Required / Waste Ink Pad (Technician Tier)
  if (
    lower.includes('service') ||
    lower.includes('waste ink') ||
    lower.includes('ink pad')
  ) {
    const def = PRINTER_ERROR_CATALOG.E_SERVICE;
    return {
      code: def.code,
      tier: def.tier,
      severity: 'fatal',
      userMessage: def.what.en,
      canRetry: false,
      canDismiss: false,
      autoClear: def.autoClear,
      locksCoinSlot: def.locksCoinSlot,
      lookAtPrinterScreen: def.lookAtPrinterScreen,
    };
  }

  // Job stall watchdog (Staff Tier)
  if (
    lower.includes('watchdog') ||
    lower.includes('stalled') ||
    lower.includes('stall')
  ) {
    const def = PRINTER_ERROR_CATALOG.E_STALL;
    return {
      code: def.code,
      tier: def.tier,
      severity: 'fatal',
      userMessage: def.what.en,
      canRetry: false,
      canDismiss: false,
      autoClear: def.autoClear,
      locksCoinSlot: def.locksCoinSlot,
      lookAtPrinterScreen: def.lookAtPrinterScreen,
    };
  }

  // Unmapped fallback (Staff Tier)
  const def = getPrinterErrorDefinition('E_UNKNOWN');
  return {
    code: def.code,
    tier: def.tier,
    severity: 'fatal',
    userMessage: def.what.en,
    canRetry: false,
    canDismiss: false,
    autoClear: def.autoClear,
    locksCoinSlot: def.locksCoinSlot,
    lookAtPrinterScreen: def.lookAtPrinterScreen,
  };
}
