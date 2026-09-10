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
        'The printer detected that the paper tray is empty or the paper was not loaded properly into the feed.',
      actionSteps: [
        'Keep this screen open and inform kiosk staff.',
        'Staff will load paper into the rear feed and check printer settings.',
        'Scan your transaction receipt QR code to save verification proof.',
      ],
      hint: 'Show your transaction ID and receipt to staff for assistance or a refund.',
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
        'Scan your transaction receipt QR code for staff verification.',
      ],
      hint: 'Show your transaction ID and receipt to staff for assistance or a refund.',
      technicalDetails: raw.includes('|') || raw.length > 70 ? raw : null,
    };
  }

  // Check for cover / door open
  if (
    code === 'PRINTER_DOOR_OPEN' ||
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
        'Ask kiosk staff to firmly close the printer cover.',
        'Keep this screen open and scan your receipt QR code below.',
      ],
      hint: 'Show your transaction ID and receipt to staff for assistance.',
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
