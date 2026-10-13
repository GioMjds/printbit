export interface ScanTroubleshootingGuide {
  title: string;
  summary: string;
  checks: string[];
  hasVisualGuide?: boolean;
}

type ScanFailureCause =
  | 'adf_error'
  | 'paper_jam'
  | 'empty_feeder'
  | 'multi_feed'
  | 'busy'
  | 'connection'
  | 'unknown';

const GUIDES = {
  adf_error: {
    title: 'Printer ADF Error Detected',
    summary:
      'Clear the printer ADF error or paper jam, then proceed with scanning.',
    checks: [
      'Open the ADF cover. (Caution: Always open the ADF cover before removing jammed paper to prevent damage.)',
      'Carefully remove any jammed paper inside the document feeder.',
      'Open the ADF input tray. (Caution: Make sure the ADF cover is open before opening the input tray.)',
      'Carefully remove any jammed paper from beneath the ADF input tray.',
      'Close the ADF input tray and ADF cover firmly, reload flat paper straight, then try again.',
    ],
    hasVisualGuide: true,
  },
  paper_jam: {
    title: 'Paper Jam in Document Feeder (ADF)',
    summary:
      'Paper is jammed in the feeder. Open the ADF cover before removing paper to avoid damage.',
    checks: [
      'Remove any loose paper from the top ADF input tray.',
      'Open the ADF cover. (Caution: Always open the ADF cover before removing jammed paper to prevent damage.)',
      'Carefully remove any jammed paper inside the document feeder.',
      'Open the ADF input tray. (Caution: Make sure the ADF cover is open before opening the input tray.)',
      'Carefully remove any jammed paper from beneath the ADF input tray.',
      'Close the ADF input tray and ADF cover firmly, reload flat paper straight, then try again.',
    ],
    hasVisualGuide: true,
  },
  empty_feeder: {
    title: 'No document detected in the feeder',
    summary: 'Load your document face-up straight into the top ADF tray, then try again.',
    checks: [
      'Remove the paper and check that all edges are lined up.',
      'Insert the document face-up into the top ADF tray, short edge first.',
      'Slide it in gently until gripped, and move side edge guides snugly against the paper.',
    ],
  },
  multi_feed: {
    title: 'Misfeed or multiple pages entered',
    summary: 'Separate pages, align edges, then reload and try again.',
    checks: [
      'Take the pages out of the top ADF tray.',
      'Ensure pages are flat, undamaged, and aligned straight.',
      'Insert the pages face-up, short edge first, and adjust side guides snugly.',
    ],
  },
  busy: {
    title: 'The scanner is still busy',
    summary: 'Wait until the scanner is quiet, then try again once.',
    checks: [
      'Wait a few seconds for the scanner to finish.',
      'Keep the paper in place in the ADF.',
      'Try again once the scanner is quiet.',
    ],
  },
  connection: {
    title: 'Scanner needs attention',
    summary: 'Make sure the scanner is switched on, then try again.',
    checks: [
      'Check that the scanner has power.',
      'Verify the scanner USB cable is firmly connected.',
      'If it still does not work, ask a staff member for help.',
    ],
  },
  unknown: {
    title: 'Let’s try that again',
    summary: 'Put the paper in straight, then try the scan again.',
    checks: [
      'Take the paper out of the top ADF tray.',
      'Check that it is flat, unfolded, and straight.',
      'Load it face-up again until gripped, then try again.',
    ],
  },
} satisfies Record<ScanFailureCause, ScanTroubleshootingGuide>;

const GLASS_GUIDES: Partial<Record<ScanFailureCause, ScanTroubleshootingGuide>> = {
  adf_error: {
    title: 'Printer ADF Error Detected',
    summary:
      'Clear the printer ADF error first, then proceed with scanning on this kiosk screen.',
    checks: [
      'Go to the printer first to clear out the printer error and jammed paper from the ADF feeder.',
      'Check that the printer screen is cleared and the printer is ready.',
      'Proceed with scanning using this kiosk screen in PrintBit.',
    ],
  },
  paper_jam: {
    title: 'Scanner check needed',
    summary: 'Check the scanner glass and lid, then try again.',
    checks: [
      'Make sure the scanner lid is completely closed.',
      'Ensure the document is lying flat on the glass.',
      'Tap Scan to try again.',
    ],
  },
  empty_feeder: {
    title: 'No document detected',
    summary: 'Place your document face-down on the glass, then try again.',
    checks: [
      'Place your document face-down on the scanner glass.',
      'Align it with the top-left corner marks.',
      'Close the scanner lid completely, then try again.',
    ],
  },
  multi_feed: {
    title: 'Scanner check needed',
    summary: 'Check the document on the glass, then try again.',
    checks: [
      'Ensure only one sheet is placed on the scanner glass.',
      'Make sure the document is flat and smooth.',
      'Tap Scan to try again.',
    ],
  },
  unknown: {
    title: 'Let’s try that again',
    summary: 'Check your document on the scanner glass, then try again.',
    checks: [
      'Place the document face-down flat on the glass.',
      'Make sure the scanner lid is closed.',
      'Tap Scan to try again.',
    ],
  },
};

function classifyScanFailure(rawMessage: string): ScanFailureCause {
  const message = rawMessage.toLowerCase();

  if (
    message.includes('adf') ||
    message.includes('feeder error') ||
    message.includes('feeder jam') ||
    message.includes('automatic document feeder')
  ) {
    return 'adf_error';
  }
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
  source: 'feeder' | 'glass' = 'feeder',
): ScanTroubleshootingGuide {
  const cause = classifyScanFailure(rawMessage);
  if (source === 'glass' && GLASS_GUIDES[cause]) {
    return GLASS_GUIDES[cause]!;
  }
  return GUIDES[cause];
}
