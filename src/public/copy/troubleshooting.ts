export interface CopyTroubleshootingGuide {
  summary: string;
  causes: string[];
  steps: string[];
}

const ADF_PAPER_JAM_GUIDE: CopyTroubleshootingGuide = {
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
};

const NON_FEEDER_FAILURE_GUIDE: CopyTroubleshootingGuide = {
  summary: 'Could not complete scanner check. Please try again.',
  causes: [],
  steps: [],
};

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
    : NON_FEEDER_FAILURE_GUIDE;
}
