import {
  getPrinterGuideSocketIo,
  printerStateProjection,
} from './printer-state-projection';
import { printerErrorStateManager } from './printer-error-state';
import { unlockOwnedCoinSlot, lockCoinSlot } from './hardware-state-projection';
import { adminPushService } from './admin-push.service';
import {
  dispatchWorkerEvent,
  type WorkerPrintEventType,
} from './worker-return-pipe';

export type SimulatedPrinterError =
  | 'low_ink'
  | 'ink_out'
  | 'out_of_paper'
  | 'adf_error'
  | 'paper_jam'
  | 'cover_open'
  | 'offline'
  | 'service_required'
  | 'output_tray'
  | 'refill_a4'
  | 'refill_short'
  | 'refill_long';

export interface PrinterSimulationState {
  activeError: SimulatedPrinterError | null;
  timestamp: string | null;
  message: string | null;
}

/**
 * Feeds a synthetic worker event through the same pipeline as a real one
 * (projections, error-guide state, printerMalfunction, admin alerts and, when
 * a transactionId is supplied, the print lifecycle).
 */
function dispatchSimulatedWorkerEvent(
  type: WorkerPrintEventType,
  message: string,
  errorCode: string | null,
  transactionId?: string,
): void {
  dispatchWorkerEvent({
    type,
    message,
    errorMessage: message,
    errorCode: errorCode ?? undefined,
    printerName: printerStateProjection.getSnapshot().name ?? 'Default',
    transactionId,
    timestampUtc: new Date().toISOString(),
  });
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
  transactionId?: string,
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
      void adminPushService.broadcastCriticalAlert({
        code: 'LOW_INK',
        title: 'ℹ️ Kiosk Low Ink Warning',
        message: 'Printer ink is running low. Please refill ink soon.',
        severity: 'warning',
      });
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
      io?.emit('printer:simulation-state', {
        activeError: 'out_of_paper',
        message: currentSimulation.message,
      });
      io?.emit('printerStatusChanged', {
        connected: true,
        status: 'Out of Paper',
        isOutOfPaper: true,
      });
      dispatchSimulatedWorkerEvent('PrinterError', 'out of paper', '4', transactionId);
      break;
    }

    case 'adf_error': {
      currentSimulation.message =
        'Clear the printer ADF error or paper jam, then proceed with scanning';
      lockCoinSlot('printer-error-guide', 'simulation_adf_error');
      void adminPushService.broadcastCriticalAlert({
        code: 'ADF_ERROR',
        title: '⚠️ Kiosk ADF Scanner Error!',
        message: 'Printer ADF error or paper jam detected in document feeder.',
        severity: 'warning',
      });
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
      dispatchSimulatedWorkerEvent('PrinterError', 'paper jam', '8', transactionId);
      break;
    }

    case 'ink_out': {
      currentSimulation.message =
        'Ink tank empty; printing locked until staff refills ink';
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
      dispatchSimulatedWorkerEvent('PrinterError', 'ink empty', '5', transactionId);
      break;
    }

    case 'cover_open': {
      currentSimulation.message =
        'Printer cover is open; customer must close it';
      io?.emit('printer:simulation-state', {
        activeError: 'cover_open',
        message: currentSimulation.message,
      });
      io?.emit('printerStatusChanged', {
        connected: true,
        status: 'Cover Open',
      });
      dispatchSimulatedWorkerEvent('PrinterError', 'cover open', '7', transactionId);
      break;
    }

    case 'offline': {
      currentSimulation.message =
        'Printer offline or disconnected; staff must check cables/power';
      io?.emit('printer:simulation-state', {
        activeError: 'offline',
        message: currentSimulation.message,
      });
      io?.emit('printerStatusChanged', {
        connected: false,
        status: 'Offline',
      });
      dispatchSimulatedWorkerEvent('PrinterOffline', 'printer offline', '9', transactionId);
      break;
    }

    case 'service_required': {
      currentSimulation.message =
        'Printer service required; technician must be called';
      io?.emit('printer:simulation-state', {
        activeError: 'service_required',
        message: currentSimulation.message,
      });
      io?.emit('printerStatusChanged', {
        connected: true,
        status: 'Service Required',
      });
      dispatchSimulatedWorkerEvent('PrinterError', 'service required', '10', transactionId);
      break;
    }

    case 'output_tray': {
      currentSimulation.message =
        'Output tray closed or full; customer must open or clear it';
      io?.emit('printer:simulation-state', {
        activeError: 'output_tray',
        message: currentSimulation.message,
      });
      io?.emit('printerStatusChanged', {
        connected: true,
        status: 'Output Tray',
      });
      dispatchSimulatedWorkerEvent('PrinterError', 'output bin full', '11', transactionId);
      break;
    }

    case 'refill_a4': {
      currentSimulation.message =
        'Staff reminder: Refill A4 bond paper (Priority 1: A4)';
      void adminPushService.broadcastCriticalAlert({
        code: 'PAPER_REFILL_A4',
        title: '📄 Refill Reminder: A4 Bond Paper',
        message:
          'Staff reminder: A4 bond paper needs refill. Please prioritize loading A4 paper into the tray.',
        severity: 'warning',
      });
      io?.emit('printer:simulation-state', {
        activeError: 'refill_a4',
        message: currentSimulation.message,
      });
      io?.emit('printerStatusChanged', {
        connected: true,
        status: 'Refill A4 Bond',
        isOutOfPaper: true,
      });
      dispatchSimulatedWorkerEvent('PrinterError', 'out of paper', '4', transactionId);
      break;
    }

    case 'refill_short': {
      currentSimulation.message =
        'Staff reminder: Refill Short bond paper (Priority 2: Short Bond)';
      void adminPushService.broadcastCriticalAlert({
        code: 'PAPER_REFILL_SHORT',
        title: '📄 Refill Reminder: Short Bond Paper',
        message:
          'Staff reminder: Short bond paper (Letter) needs refill. Please prioritize loading Short bond paper into the tray.',
        severity: 'warning',
      });
      io?.emit('printer:simulation-state', {
        activeError: 'refill_short',
        message: currentSimulation.message,
      });
      io?.emit('printerStatusChanged', {
        connected: true,
        status: 'Refill Short Bond',
        isOutOfPaper: true,
      });
      dispatchSimulatedWorkerEvent('PrinterError', 'out of paper', '4', transactionId);
      break;
    }

    case 'refill_long': {
      currentSimulation.message =
        'Staff reminder: Refill Long bond paper (Priority 3: Long Bond)';
      void adminPushService.broadcastCriticalAlert({
        code: 'PAPER_REFILL_LONG',
        title: '📄 Refill Reminder: Long Bond Paper',
        message:
          'Staff reminder: Long bond paper (Legal) needs refill. Please prioritize loading Long bond paper into the tray.',
        severity: 'warning',
      });
      io?.emit('printer:simulation-state', {
        activeError: 'refill_long',
        message: currentSimulation.message,
      });
      io?.emit('printerStatusChanged', {
        connected: true,
        status: 'Refill Long Bond',
        isOutOfPaper: true,
      });
      dispatchSimulatedWorkerEvent('PrinterError', 'out of paper', '4', transactionId);
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

  dispatchSimulatedWorkerEvent('PrinterOnline', 'ready', null);

  adminPushService.clearAlert('PAPER_JAM');
  adminPushService.clearAlert('PAPER_OUT');
  adminPushService.clearAlert('PRINTER_OFFLINE');
  adminPushService.clearAlert('COVER_OPEN');
  adminPushService.clearAlert('OUTPUT_TRAY');
  adminPushService.clearAlert('SERVICE_REQUIRED');
  adminPushService.clearAlert('INK_OUT');
  adminPushService.clearAlert('ADF_ERROR');
  adminPushService.clearAlert('LOW_INK');
  adminPushService.clearAlert('PAPER_SETUP');
  adminPushService.clearAlert('PRINTER_HARDWARE_ERROR');
  adminPushService.clearAlert('PAPER_REFILL_A4');
  adminPushService.clearAlert('PAPER_REFILL_SHORT');
  adminPushService.clearAlert('PAPER_REFILL_LONG');
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

  dispatchSimulatedWorkerEvent('PrinterOnline', 'ready', null);

  adminPushService.clearAlert('PAPER_JAM');
  adminPushService.clearAlert('PAPER_OUT');
  adminPushService.clearAlert('PRINTER_OFFLINE');
  adminPushService.clearAlert('COVER_OPEN');
  adminPushService.clearAlert('OUTPUT_TRAY');
  adminPushService.clearAlert('SERVICE_REQUIRED');
  adminPushService.clearAlert('INK_OUT');
  adminPushService.clearAlert('ADF_ERROR');
  adminPushService.clearAlert('LOW_INK');
  adminPushService.clearAlert('PAPER_SETUP');
  adminPushService.clearAlert('PRINTER_HARDWARE_ERROR');
  adminPushService.clearAlert('PAPER_REFILL_A4');
  adminPushService.clearAlert('PAPER_REFILL_SHORT');
  adminPushService.clearAlert('PAPER_REFILL_LONG');
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
