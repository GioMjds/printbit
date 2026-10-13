export interface CopyTroubleshootingGuide {
  title?: string;
  summary: string;
  causes: string[];
  steps: string[];
  hasVisualGuide?: boolean;
}

export const ADF_PAPER_JAM_GUIDE = {
  title: 'Paper Jam in Document Feeder (ADF)',
  summary:
    'Paper is jammed in the feeder. Open the ADF cover before removing paper to avoid damage.',
  causes: [
    'Paper is stuck or caught inside the document feeder (ADF).',
    'Pages entered the feeder crooked or with folded edges.',
    'Jammed paper was pulled without opening the ADF cover first.',
  ],
  steps: [
    'Remove any loose paper from the top ADF input tray.',
    'Open the ADF cover. (Caution: Always open the ADF cover before removing jammed paper to avoid damage.)',
    'Carefully remove any jammed paper inside the feeder.',
    'Open the ADF input tray. (Caution: Make sure the ADF cover is open before opening the input tray.)',
    'Carefully remove any jammed paper from beneath the ADF input tray.',
    'Close the ADF input tray and ADF cover firmly, then tap Retry.',
  ],
  hasVisualGuide: true,
} satisfies CopyTroubleshootingGuide;

export const ADF_ERROR_GUIDE = {
  title: 'Printer ADF Error Detected',
  summary:
    'Clear the printer ADF error or paper jam, then proceed with scanning.',
  causes: [
    'Printer detected a document feeder (ADF) paper jam or cover error.',
    'The ADF cover or ADF input tray was left unlatched or open.',
    'Feeder sensor requires error clearance on the printer before continuing.',
  ],
  steps: [
    'Check the printer ADF: open the ADF cover and clear any trapped paper.',
    'Open the ADF input tray and remove any paper trapped underneath.',
    'Close the ADF input tray and ADF cover completely until securely latched.',
    'Verify that the printer screen or error light is cleared and ready.',
    'Reload flat paper straight into the feeder, then tap Retry.',
  ],
  hasVisualGuide: true,
} satisfies CopyTroubleshootingGuide;

export const ADF_NO_DOCUMENT_GUIDE = {
  title: 'No Document Detected in Feeder',
  summary: 'No document detected in the document feeder (ADF).',
  causes: [
    'No paper is currently inserted in the top ADF feeder tray.',
    'Long Bond paper was placed face-down instead of face-up in the feeder.',
    'Paper was not pushed in far enough for the feeder rollers to detect it.',
  ],
  steps: [
    'Place your Long Bond paper face-up in the top ADF feeder tray, short edge first.',
    'Slide it in until the feeder grips the page.',
    'Adjust the side edge guides snugly against both edges of the paper.',
    'Tap Check Document again.',
  ],
} satisfies CopyTroubleshootingGuide;

export const ADF_PLACEMENT_GUIDE = {
  title: 'Feeder Alignment or Misfeed Issue',
  summary: 'Pages entered the feeder crooked or multiple pages were fed.',
  causes: [
    'Pages entered the document feeder tilted or unevenly.',
    'Side edge guides on the feeder tray are not adjusted against the paper.',
    'Multiple pages or wrinkled sheets fed together.',
  ],
  steps: [
    'Remove the paper from the top ADF tray.',
    'Check that pages are flat, undamaged, and aligned straight.',
    'Insert the document face-up, short edge first, into the feeder.',
    'Slide both side edge guides snugly against the paper edges, then tap Retry.',
  ],
} satisfies CopyTroubleshootingGuide;

export const ADF_DIRTY_GLASS_GUIDE = {
  title: 'ADF Glass Strip Needs Cleaning',
  summary: 'Dust, smudges, or streaks detected on the scanner.',
  causes: [
    'Dust, smudges, or correction fluid marks on the narrow ADF glass strip (left side).',
    'Debris or paper dust on the ADF feed rollers.',
  ],
  steps: [
    'Open the scanner lid and locate the narrow glass strip on the left.',
    'Gently wipe the glass strip with a clean, dry, soft microfiber cloth.',
    'Close the scanner lid completely.',
    'Reload your document face-up in the ADF and tap Retry.',
  ],
} satisfies CopyTroubleshootingGuide;

export const ADF_BUSY_GUIDE = {
  title: 'Scanner is Busy',
  summary: 'The document feeder or scanner is still busy processing.',
  causes: [
    'Scanner feeder is still completing or resetting a previous operation.',
    'Another scan or copy job is currently running.',
  ],
  steps: [
    'Wait a few seconds for the feeder mechanism to settle.',
    'Keep your document in place in the ADF.',
    'Tap Retry once.',
  ],
} satisfies CopyTroubleshootingGuide;

export const ADF_CONNECTION_GUIDE = {
  title: 'Scanner Connection Issue',
  summary: 'Scanner connection is unavailable or interrupted.',
  causes: [
    'Scanner USB cable is loose or disconnected.',
    'Scanner is powered off or not ready.',
    'Scanner service on the kiosk is temporarily offline.',
  ],
  steps: [
    'Confirm the printer/scanner power is turned on.',
    'Check that the scanner USB cable is firmly connected.',
    'Tap Retry; if it still fails, ask staff for assistance.',
  ],
} satisfies CopyTroubleshootingGuide;

export const ADF_UNKNOWN_GUIDE = {
  title: 'Document Feeder Check Needed',
  summary: 'Feeder could not complete document detection.',
  causes: [
    'Document feeder could not grab or advance the paper.',
    'Paper is curled, torn, stapled, or outside supported thickness.',
    'Temporary scanner feed issue occurred.',
  ],
  steps: [
    'Remove the paper from the ADF feeder tray.',
    'Make sure the document is flat and free of staples, paperclips, or creases.',
    'Insert the document face-up straight into the ADF until seated.',
    'Ensure the ADF cover is completely closed, then tap Retry.',
  ],
} satisfies CopyTroubleshootingGuide;

export const FLATBED_NO_DOCUMENT_GUIDE = {
  title: 'No Document Detected on Glass',
  summary: 'Could not detect or scan document on the glass.',
  causes: [
    'No page is currently placed on the scanner glass.',
    'Page is face-up instead of face-down on the glass.',
    'Only part of the page is inside the scan area.',
  ],
  steps: [
    'Place one page face-down flat against the top-left corner of the scanner glass.',
    'Align the page with the corner frame markings.',
    'Close the scanner lid completely, then tap Check Document again.',
  ],
} satisfies CopyTroubleshootingGuide;

export const FLATBED_PLACEMENT_GUIDE = {
  title: 'Document Placement Check Needed',
  summary: 'Document on the glass is skewed or misaligned.',
  causes: [
    'Page is tilted so edges are outside the scan area.',
    'Paper shifted while the scanner lid was being closed.',
    'Document is not aligned with the corner mark.',
  ],
  steps: [
    'Open the lid and reposition the page flat and straight on the glass.',
    'Keep page corners inside the top-left frame markings.',
    'Close the scanner lid gently, then tap Retry.',
  ],
} satisfies CopyTroubleshootingGuide;

export const FLATBED_DIRTY_GLASS_GUIDE = {
  title: 'Scanner Glass Needs Cleaning',
  summary: 'Dust, smudges, or streaks detected on the scanner glass.',
  causes: [
    'Dust, fingerprints, or smudges on the flatbed scanner glass.',
    'Dirt on the white backing pad causes false detection issues.',
    'Debris in the scan area.',
  ],
  steps: [
    'Open the lid and clean the scanner glass with a soft, dry microfiber cloth.',
    'If needed, lightly dampen cloth with glass cleaner (do not spray directly on scanner).',
    'Dry completely, replace the document, and tap Retry.',
  ],
} satisfies CopyTroubleshootingGuide;

export const FLATBED_FAILURE_GUIDE = {
  title: 'Scanner Check Needed',
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
  return (
    message.includes('jam') ||
    message.includes('stuck') ||
    message.includes('feeder jam') ||
    message.includes('paper jam')
  );
}

export function getCopyTroubleshootingGuide(
  rawMessage: string,
  usesAdf: boolean,
): CopyTroubleshootingGuide {
  const message = rawMessage.toLowerCase();

  if (usesAdf) {
    if (
      message.includes('jam') ||
      message.includes('stuck') ||
      message.includes('paper jam') ||
      message.includes('feeder jam')
    ) {
      return ADF_PAPER_JAM_GUIDE;
    }

    if (
      message.includes('adf') ||
      message.includes('feeder error') ||
      message.includes('automatic document feeder')
    ) {
      return ADF_ERROR_GUIDE;
    }

    if (
      message.includes('no document') ||
      message.includes('no pages') ||
      message.includes('empty feeder') ||
      message.includes('insert document') ||
      message.includes('load paper') ||
      message.includes('not detected')
    ) {
      return ADF_NO_DOCUMENT_GUIDE;
    }

    if (
      message.includes('align') ||
      message.includes('alignment') ||
      message.includes('skew') ||
      message.includes('crop') ||
      message.includes('position') ||
      message.includes('misfeed') ||
      message.includes('multi-feed') ||
      message.includes('multifeed') ||
      message.includes('double feed')
    ) {
      return ADF_PLACEMENT_GUIDE;
    }

    if (
      message.includes('dirty') ||
      message.includes('smudge') ||
      message.includes('streak') ||
      message.includes('dust')
    ) {
      return ADF_DIRTY_GLASS_GUIDE;
    }

    if (
      message.includes('busy') ||
      message.includes('in use') ||
      message.includes('another scan') ||
      message.includes('already scanning')
    ) {
      return ADF_BUSY_GUIDE;
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
      return ADF_CONNECTION_GUIDE;
    }

    return ADF_UNKNOWN_GUIDE;
  }

  // Flatbed (glass scanner)
  if (
    message.includes('no document') ||
    message.includes('no pages') ||
    message.includes('not detected')
  ) {
    return FLATBED_NO_DOCUMENT_GUIDE;
  }

  if (
    message.includes('align') ||
    message.includes('alignment') ||
    message.includes('skew') ||
    message.includes('crop') ||
    message.includes('position')
  ) {
    return FLATBED_PLACEMENT_GUIDE;
  }

  if (
    message.includes('dirty') ||
    message.includes('smudge') ||
    message.includes('streak') ||
    message.includes('dust') ||
    message.includes('glass')
  ) {
    return FLATBED_DIRTY_GLASS_GUIDE;
  }

  if (
    message.includes('busy') ||
    message.includes('in use') ||
    message.includes('another scan') ||
    message.includes('already scanning')
  ) {
    return ADF_BUSY_GUIDE;
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
    return ADF_CONNECTION_GUIDE;
  }

  return FLATBED_FAILURE_GUIDE;
}
