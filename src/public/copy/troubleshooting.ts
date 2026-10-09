export interface CopyTroubleshootingGuide {
  summary: string;
  causes: string[];
  steps: string[];
}

const ADF_PAPER_JAM_GUIDE = {
  summary: 'Paper may be stuck in the feeder. Clear it, then try again.',
  causes: [
    'Paper is stuck or torn inside the document feeder.',
    'Pages entered the feeder crooked or with folded edges.',
  ],
  steps: [
    'Remove the paper from the top feeder tray.',
    'Open the feeder and gently remove any stuck or torn paper.',
    'Load flat, undamaged pages straight, then tap Retry.',
  ],
} satisfies CopyTroubleshootingGuide;

const FLATBED_FAILURE_GUIDE = {
  summary: 'Could not detect or scan document on the glass.',
  causes: [
    'Document is not placed flat on the scanner glass.',
    'Scanner lid may be open or scanner is busy.',
  ],
  steps: [
    'Place your document face-down flat against the top-left corner of the glass.',
    'Close the scanner lid completely.',
    'Tap Retry.',
  ],
} satisfies CopyTroubleshootingGuide;

export function isAdfPaperJam(rawMessage: string, usesAdf: boolean): boolean {
  if (!usesAdf) return false;
  const message = rawMessage.toLowerCase();
  return message.includes('jam') || message.includes('stuck');
}

export function getCopyTroubleshootingGuide(
  rawMessage: string,
  usesAdf: boolean,
): CopyTroubleshootingGuide {
  return isAdfPaperJam(rawMessage, usesAdf)
    ? ADF_PAPER_JAM_GUIDE
    : FLATBED_FAILURE_GUIDE;
}
