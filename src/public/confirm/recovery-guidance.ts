export interface MaintenanceGuidance {
  title: string;
  subtitle?: string;
  badge?: string;
  message: string;
  actionSteps: string[];
  hint: string;
  technicalDetails?: string | null;
}

const TECHNICAL_FAILURE_CODES = new Set([
  'PAPER_INSUFFICIENT_PRE_DISPATCH',
  'PAPER_INSUFFICIENT_MID_JOB',
  'PAPER_TRAY_EMPTY',
  'PAPER_JAM_PRINT',
  'PRINTER_DOOR_OPEN',
  'PRINTER_HARDWARE_ERROR',
  'WORKER_HARDWARE_ERROR',
  'WORKER_PRINT_FAILED',
]);

export function getMaintenanceGuidance(
  code: string,
  message: string,
): MaintenanceGuidance {
  const raw = (message || '').trim();
  const lower = `${code} ${raw}`.toLowerCase();

  // Check for paper out / loading errors (e.g. Epson popup: Paper out or incorrect loading)
  if (
    code === 'PAPER_TRAY_EMPTY' ||
    code === 'E_NO_PAPER' ||
    lower.includes('paper out') ||
    lower.includes('paper_out') ||
    lower.includes('incorrect loading') ||
    lower.includes('out of paper') ||
    lower.includes('no paper') ||
    lower.includes('load the paper')
  ) {
    return {
      title: 'Paper Out or Incorrect Loading',
      subtitle: 'The printer ran out of paper or paper was loaded incorrectly.',
      badge: 'Paper Issue',
      message:
        'The printer detected that the paper tray is empty. Load paper to continue printing.',
      actionSteps: [
        'Load paper into the printer paper tray.',
        'Press Resume on the printer to continue printing, or cancel your print job.',
        'Scan your transaction receipt QR code for verification proof if needed.',
      ],
      hint: 'You can resume interactively on the printer or cancel your print job.',
      technicalDetails: raw.includes('|') || raw.length > 70 ? raw : null,
    };
  }

  // Check for output tray closed or full
  if (
    code === 'E_OUTPUT_TRAY' ||
    lower.includes('output tray') ||
    lower.includes('output bin') ||
    lower.includes('tray closed')
  ) {
    return {
      title: 'Output Tray Needs Attention',
      subtitle: 'The output tray is closed or full.',
      badge: 'Output Tray',
      message:
        'Printing paused because the output tray is closed or full.',
      actionSteps: [
        'Pull out the output tray on the printer.',
        'Press OK on the printer screen if prompted to continue.',
      ],
      hint: 'The printer will resume automatically once the tray is opened.',
      technicalDetails: raw.includes('|') || raw.length > 70 ? raw : null,
    };
  }

  // Check for paper jam
  if (
    code === 'PAPER_JAM_PRINT' ||
    lower.includes('paper jam') ||
    lower.includes('paper_jam') ||
    lower.includes('jammed')
  ) {
    return {
      title: 'Paper Jam Detected',
      subtitle: 'Paper is caught inside the printer mechanism.',
      badge: 'Paper Jam',
      message:
        'A sheet of paper got stuck inside the printer during printing.',
      actionSteps: [
        'Keep this screen open and notify kiosk staff.',
        'Staff will clear any jammed sheets from the printer feed.',
        'This screen will automatically unlock once staff clears the error in Admin Control.',
      ],
      hint: 'Admin control unlock required. No dismissal buttons available on this screen.',
      technicalDetails: raw.includes('|') || raw.length > 70 ? raw : null,
    };
  }

  // Check for cover / door open
  if (
    code === 'PRINTER_DOOR_OPEN' ||
    code === 'E_COVER_OPEN' ||
    lower.includes('door open') ||
    lower.includes('door_open') ||
    lower.includes('cover open')
  ) {
    return {
      title: 'Printer Cover Open',
      subtitle: 'The printer access cover is currently open.',
      badge: 'Cover Open',
      message:
        'Printing paused because the printer cover or access door is open.',
      actionSteps: [
        'Close the printer cover or door firmly on the printer.',
        'Check the printer screen to resume.',
      ],
      hint: 'Closing the cover will resume printing automatically.',
      technicalDetails: raw.includes('|') || raw.length > 70 ? raw : null,
    };
  }

  // Check for ink / consumables
  if (
    lower.includes('ink levels') ||
    lower.includes('ink') ||
    lower.includes('toner') ||
    lower.includes('consumables')
  ) {
    return {
      title: 'Ink Attention Required',
      subtitle: 'The printer ink tanks require maintenance.',
      badge: 'Ink Attention',
      message:
        'The printer ink level is below the required threshold to complete this job.',
      actionSteps: [
        'Keep this screen open and alert kiosk staff.',
        'Scan your transaction receipt QR code below for verification or refund.',
      ],
      hint: 'Show your transaction ID and receipt to staff for refund assistance.',
      technicalDetails: raw.includes('|') || raw.length > 70 ? raw : null,
    };
  }

  // Generic technical or hardware failure
  const isTechCode = TECHNICAL_FAILURE_CODES.has(code);
  const isHw =
    lower.includes('hardware error') ||
    lower.includes('post-clear') ||
    lower.includes('hardwareerror');

  const cleanMsg =
    raw.includes('|') || raw.length > 90 || isHw
      ? 'The printer encountered an unexpected hardware issue and could not complete your document.'
      : raw || 'The printer could not complete this print job.';

  return {
    title: isHw ? 'Printer Hardware Issue' : 'Printing Needs Staff Assistance',
    subtitle: 'Printing was stopped before completion.',
    badge: 'Staff Assistance',
    message:
      isTechCode && !isHw
        ? 'Your document may not have printed completely. Please keep this screen open and ask a staff member for help.'
        : cleanMsg,
    actionSteps: [
      'Keep this screen open and notify kiosk staff.',
      'Scan your transaction receipt QR code with your phone.',
      'Provide your Transaction ID for verification or refund.',
    ],
    hint: 'Show the transaction ID and receipt below to the kiosk staff.',
    technicalDetails: raw.includes('|') || raw.length > 70 ? raw : null,
  };
}
