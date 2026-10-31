import {
  getPrinterGuideSocketIo,
  handlePrinterStatusUpdate,
  printerStateProjection,
} from './printer-state-projection';
import { printerErrorStateManager } from './printer-error-state';
import { unlockOwnedCoinSlot, lockCoinSlot } from './hardware-state-projection';
import { adminPushService } from './admin-push.service';

export type SimulatedPrinterError =
  | 'low_ink'
  | 'ink_out'
  | 'out_of_paper'
  | 'adf_error'
  | 'paper_jam'
  | 'cover_open'
  | 'offline'
  | 'service_required'
  | 'output_tray';

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
        'Clear the printer ADF error or paper jam, then proceed with scanning';
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
          'Printer ADF Error Detected. Clear the printer ADF error or paper jam, then proceed with scanning.',
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
      void adminPushService.broadcastCriticalAlert({
        code: 'PAPER_JAM',
        title: '🚨 Kiosk Paper Jam Detected!',
        message: 'Paper jam detected in the printer. Check the printer and clear the jam to continue printing.',
        severity: 'critical',
      });
      break;
    }

    case 'ink_out': {
      currentSimulation.message =
        'Ink tank empty; printing locked until staff refills ink';
      handlePrinterStatusUpdate('ink empty', '5');
      io?.emit('printer:simulation-state', {
        activeError: 'ink_out',
        message: currentSimulation.message,
      });
      io?.emit('printer:ink-out-warning', { active: true });
      io?.emit('printerStatusChanged', {
        connected: true,
        status: 'Ink Empty',
        isLowOnToner: true,
        inkTelemetryAvailable: true,
        ink: [{ name: 'Black', level: 0, status: 'empty' }],
      });
      io?.emit('printerMalfunction', {
        status: 'Ink Empty',
        printError: {
          code: 'E_INK_OUT',
          severity: 'fatal',
          userMessage: 'Printer ink tank is empty.',
          hint: 'Please call staff to refill the ink.',
          canRetry: false,
          canDismiss: false,
        },
      });
      void adminPushService.broadcastCriticalAlert({
        code: 'INK_OUT',
        title: '🚨 Kiosk Ink Tank Empty!',
        message: 'Printer ink tank is empty. You need to refill the ink to continue printing.',
        severity: 'critical',
      })
      break;
    }

    case 'cover_open': {
      currentSimulation.message =
        'Printer cover is open; customer must close it';
      handlePrinterStatusUpdate('cover open', '7');
      io?.emit('printer:simulation-state', {
        activeError: 'cover_open',
        message: currentSimulation.message,
      });
      io?.emit('printerStatusChanged', {
        connected: true,
        status: 'Cover Open',
      });
      io?.emit('printerMalfunction', {
        status: 'Cover Open',
        printError: {
          code: 'E_COVER_OPEN',
          severity: 'recoverable',
          userMessage: 'The printer cover is open.',
          hint: 'Please close the printer cover, then press OK on the printer screen if prompted.',
          canRetry: true,
          canDismiss: false,
        },
      });
      break;
    }

    case 'offline': {
      currentSimulation.message =
        'Printer offline or disconnected; staff must check cables/power';
      handlePrinterStatusUpdate('printer offline', '9');
      io?.emit('printer:simulation-state', {
        activeError: 'offline',
        message: currentSimulation.message,
      });
      io?.emit('printerStatusChanged', {
        connected: false,
        status: 'Offline',
      });
      io?.emit('printerMalfunction', {
        status: 'Offline',
        printError: {
          code: 'E_OFFLINE',
          severity: 'fatal',
          userMessage: 'Printer is offline or disconnected.',
          hint: 'Please call staff to check printer power and cable connections.',
          canRetry: false,
          canDismiss: false,
        },
      });
      break;
    }

    case 'service_required': {
      currentSimulation.message =
        'Printer service required; technician must be called';
      handlePrinterStatusUpdate('service required', '10');
      io?.emit('printer:simulation-state', {
        activeError: 'service_required',
        message: currentSimulation.message,
      });
      io?.emit('printerStatusChanged', {
        connected: true,
        status: 'Service Required',
      });
      io?.emit('printerMalfunction', {
        status: 'Service Required',
        printError: {
          code: 'E_SERVICE',
          severity: 'fatal',
          userMessage: 'Printer requires service or maintenance.',
          hint: 'Please call staff for technical assistance.',
          canRetry: false,
          canDismiss: false,
        },
      });
      void adminPushService.broadcastCriticalAlert({
        code: 'PRINTER_OFFLINE',
        title: '🚨 Kiosk Printer Service Required!',
        message: 'The kiosk printer requires service or maintenance. Please call staff for technical assistance to continue printing.',
        severity: 'critical',
      });
      break;
    }

    case 'output_tray': {
      currentSimulation.message =
        'Output tray closed or full; customer must open or clear it';
      handlePrinterStatusUpdate('output bin full', '11');
      io?.emit('printer:simulation-state', {
        activeError: 'output_tray',
        message: currentSimulation.message,
      });
      io?.emit('printerStatusChanged', {
        connected: true,
        status: 'Output Tray',
      });
      io?.emit('printerMalfunction', {
        status: 'Output Tray',
        printError: {
          code: 'E_OUTPUT_TRAY',
          severity: 'recoverable',
          userMessage: 'The output tray is closed or full.',
          hint: 'Open or clear the output tray, then press OK on the printer screen if prompted.',
          canRetry: true,
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

  adminPushService.clearAlert('PAPER_JAM');
  io?.emit('printer:simulation-state', { activeError: null, message: null });
  io?.emit('printer:simulation-cleared', {});
  io?.emit('printer:low-ink-warning', { active: false });
  io?.emit('printer:ink-out-warning', { active: false });
  io?.emit('printerStatusRestored', { status: 'Ready' });
  io?.emit('printerRecovered', { connected: true, status: 'Idle' });
  io?.emit('printerStatusChanged', { connected: true, status: 'Idle' });
  io?.emit('printer:error-guide-update', { activeError: null });

  return { ...currentSimulation };
}

export function clearPaperJamSimulation(): PrinterSimulationState {
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

  adminPushService.clearAlert('PAPER_JAM');
  io?.emit('printer:simulation-state', { activeError: null, message: null });
  io?.emit('printer:simulation-cleared', { redirectHome: true });
  io?.emit('printer:paper-jam-cleared', { redirectHome: true });
  io?.emit('printer:low-ink-warning', { active: false });
  io?.emit('printer:ink-out-warning', { active: false });
  io?.emit('printerStatusRestored', { status: 'Ready' });
  io?.emit('printerRecovered', { connected: true, status: 'Idle' });
  io?.emit('printerStatusChanged', { connected: true, status: 'Idle' });
  io?.emit('printer:error-guide-update', { activeError: null });

  return { ...currentSimulation };
}
