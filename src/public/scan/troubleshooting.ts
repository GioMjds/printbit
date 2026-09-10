export interface ScanTroubleshootingGuide {
  title: string;
  summary: string;
  checks: string[];
}

type ScanFailureCause =
  | 'paper_jam'
  | 'empty_feeder'
  | 'multi_feed'
  | 'busy'
  | 'connection'
  | 'unknown';

const GUIDES: Record<ScanFailureCause, ScanTroubleshootingGuide> = {
  paper_jam: {
    title: 'Paper jam in the feeder',
    summary: 'Remove the paper, clear the feeder, then try again.',
    checks: [
      'Remove the paper from the top feeder tray.',
      'Make sure no torn paper is left inside the feeder.',
      'Load the paper straight, then try again.',
    ],
  },
  empty_feeder: {
    title: 'We could not find your paper',
    summary: 'Load your document straight into the top tray, then try again.',
    checks: [
      'Remove the paper and line up its edges.',
      'Slide it straight into the top tray.',
      'Move the side guides gently against the paper.',
    ],
  },
  multi_feed: {
    title: 'More than one page went in',
    summary: 'Separate the pages, then load a smaller stack and try again.',
    checks: [
      'Take the stack out of the top tray.',
      'Separate the pages and line up the edges.',
      'Load fewer pages, then try again.',
    ],
  },
  busy: {
    title: 'The scanner is still busy',
    summary: 'Wait until the scanner is quiet, then try again once.',
    checks: [
      'Wait a few seconds for the scanner to finish.',
      'Keep the paper in place.',
      'Try again once the scanner is quiet.',
    ],
  },
  connection: {
    title: 'Scanner needs attention',
    summary: 'Make sure the scanner is switched on, then try again.',
    checks: [
      'Check that the scanner has power.',
      'Wait a moment for it to wake up.',
      'If it still does not work, ask a staff member for help.',
    ],
  },
  unknown: {
    title: 'Let’s try that again',
    summary: 'Put the paper in straight, then try the scan again.',
    checks: [
      'Take the paper out of the top tray.',
      'Check that it is flat and straight.',
      'Load it again, then try again.',
    ],
  },
};

function classifyScanFailure(rawMessage: string): ScanFailureCause {
  const message = rawMessage.toLowerCase();

  if (message.includes('jam') || message.includes('stuck')) return 'paper_jam';
  if (
    message.includes('multi-feed') ||
    message.includes('multifeed') ||
    message.includes('double feed') ||
    message.includes('misfeed') ||
    message.includes('skew')
  ) {
    return 'multi_feed';
  }
  if (
    message.includes('no document') ||
    message.includes('no pages') ||
    message.includes('empty feeder') ||
    message.includes('insert document') ||
    message.includes('load paper')
  ) {
    return 'empty_feeder';
  }
  if (
    message.includes('busy') ||
    message.includes('in use') ||
    message.includes('another scan') ||
    message.includes('already scanning')
  ) {
    return 'busy';
  }
  if (
    message.includes('no scanner') ||
    message.includes('not connected') ||
    message.includes('unavailable') ||
    message.includes('connection') ||
    message.includes('usb') ||
    message.includes('driver') ||
    message.includes('cannot communicate') ||
    message.includes('offline')
  ) {
    return 'connection';
  }

  return 'unknown';
}

export function getScanTroubleshootingGuide(
  rawMessage: string,
): ScanTroubleshootingGuide {
  return GUIDES[classifyScanFailure(rawMessage)];
}
