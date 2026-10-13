import {
  getPrinterGuideSocketIo,
  handlePrinterStatusUpdate,
  printerStateProjection,
} from './printer-state-projection';
import { printerErrorStateManager } from './printer-error-state';
import { unlockOwnedCoinSlot, lockCoinSlot } from './hardware-state-projection';

export type SimulatedPrinterError =
  | 'low_ink'
  | 'out_of_paper'
  | 'adf_error'
  | 'paper_jam';

export interface PrinterSimulationState {
  activeError: SimulatedPrinterError | null;
  timestamp: string | null;
  message: string | null;
}

let currentSimulation: PrinterSimulationState = {
  activeError: null,
  timestamp: null,
  message: null,
};

export function getPrinterSimulationState(): PrinterSimulationState {
  return { ...currentSimulation };
}

export function simulatePrinterError(
  errorType: SimulatedPrinterError,
): PrinterSimulationState {
  const io = getPrinterGuideSocketIo();
  const now = new Date().toISOString();

  currentSimulation = {
    activeError: errorType,
    timestamp: now,
    message: null,
  };

  switch (errorType) {
    case 'low_ink': {
      currentSimulation.message = 'Low Ink warning active on Homepage';
      io?.emit('printer:simulation-state', {
        activeError: 'low_ink',
        message: currentSimulation.message,
      });
      io?.emit('printer:low-ink-warning', { active: true });
      io?.emit('printerStatusChanged', {
        connected: true,
        status: 'Low Ink',
        isLowOnToner: true,
        inkTelemetryAvailable: true,
        ink: [{ name: 'Black', level: 10, status: 'low' }],
      });
      break;
    }

    case 'out_of_paper': {
      currentSimulation.message =
        'Printer is out of paper in confirm / printing';
      handlePrinterStatusUpdate('out of paper', '4');
      io?.emit('printer:simulation-state', {
        activeError: 'out_of_paper',
        message: currentSimulation.message,
      });
      io?.emit('printerStatusChanged', {
        connected: true,
        status: 'Out of Paper',
        isOutOfPaper: true,
      });
      io?.emit('printerMalfunction', {
        status: 'Out of Paper',
        printError: {
          code: 'PAPER_TRAY_EMPTY',
          severity: 'recoverable',
          userMessage: 'Printer is out of paper. Please load paper to continue.',
          hint: 'Please call staff to load paper into the tray.',
          canRetry: true,
          canDismiss: false,
        },
      });
      break;
    }

    case 'adf_error': {
      currentSimulation.message =
        'ADF feeder error on printer; clear printer first';
      io?.emit('printer:simulation-state', {
        activeError: 'adf_error',
        message: currentSimulation.message,
      });
      io?.emit('printerStatusChanged', {
        connected: true,
        status: 'ADF Error',
      });
      io?.emit('scan:adf-error', {
        error:
          'ADF feeder error on printer. Go to the printer first to clear the feeder error, then proceed with scanning using the kiosk screen.',
        title: 'Printer ADF Error Detected',
      });
      break;
    }

    case 'paper_jam': {
      currentSimulation.message =
        'Paper jam during printing; no buttons, admin control clear only';
      lockCoinSlot('printer-error-guide', 'paper_jam_simulation');
      io?.emit('printer:simulation-state', {
        activeError: 'paper_jam',
        message: currentSimulation.message,
      });
      io?.emit('printerStatusChanged', {
        connected: true,
        status: 'Paper Jam',
        isPaperJam: true,
      });
      io?.emit('printerMalfunction', {
        status: 'Paper Jam',
        printError: {
          code: 'PAPER_JAM_PRINT',
          severity: 'fatal',
          userMessage: 'Paper jam detected in the printer.',
          hint: 'A sheet of paper got stuck inside the printer during printing. Removable via admin control only.',
          canRetry: false,
          canDismiss: false,
        },
      });
      break;
    }
  }

  return { ...currentSimulation };
}

export function clearPrinterSimulation(): PrinterSimulationState {
  const io = getPrinterGuideSocketIo();

  currentSimulation = {
    activeError: null,
    timestamp: null,
    message: null,
  };

  printerErrorStateManager.clearStaffResolution();
  unlockOwnedCoinSlot('printer-error-guide');

  printerStateProjection.applyEvent({
    type: 'PrinterOnline',
    printerName: printerStateProjection.getSnapshot().name ?? 'Default',
    timestampUtc: new Date().toISOString(),
  });

  io?.emit('printer:simulation-state', { activeError: null, message: null });
  io?.emit('printer:simulation-cleared', {});
  io?.emit('printer:low-ink-warning', { active: false });
  io?.emit('printerStatusRestored', { status: 'Ready' });
  io?.emit('printerRecovered', { connected: true, status: 'Idle' });
  io?.emit('printerStatusChanged', { connected: true, status: 'Idle' });
  io?.emit('printer:error-guide-update', { activeError: null });

  return { ...currentSimulation };
}
