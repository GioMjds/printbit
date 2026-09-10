import { getScanTroubleshootingGuide } from '@/public/scan/troubleshooting';

describe('scan troubleshooting guidance', () => {
  it('identifies a feeder paper jam and gives safe recovery steps', () => {
    expect(getScanTroubleshootingGuide('ADF paper jam detected')).toEqual({
      title: 'Paper jam in the feeder',
      summary: 'Remove the paper, clear the feeder, then try again.',
      checks: [
        'Remove the paper from the top feeder tray.',
        'Make sure no torn paper is left inside the feeder.',
        'Load the paper straight, then try again.',
      ],
    });
  });

  it('uses short, plain-language checks for a scanner connection problem', () => {
    expect(getScanTroubleshootingGuide('Scanner connection issue')).toEqual({
      title: 'Scanner needs attention',
      summary: 'Make sure the scanner is switched on, then try again.',
      checks: [
        'Check that the scanner has power.',
        'Wait a moment for it to wake up.',
        'If it still does not work, ask a staff member for help.',
      ],
    });
  });
});
