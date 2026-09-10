import { getCopyTroubleshootingGuide } from '@/public/copy/troubleshooting';

describe('copy troubleshooting guidance', () => {
  it('explains how to clear a paper jam when the copy uses the ADF', () => {
    expect(
      getCopyTroubleshootingGuide('ADF paper jam detected', true),
    ).toEqual({
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
    });
  });

  it('does not label a flatbed copy error as a feeder paper jam', () => {
    expect(
      getCopyTroubleshootingGuide('Paper jam detected', false).summary,
    ).not.toContain('feeder');
  });
});
