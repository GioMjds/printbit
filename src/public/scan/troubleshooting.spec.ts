import { getScanTroubleshootingGuide } from './troubleshooting';

describe('getScanTroubleshootingGuide', () => {
  it('does not blame the printer for a worker IPC timeout', () => {
    const guide = getScanTroubleshootingGuide(
      'Scan failed: No response received from C# Worker (IPC timeout or disconnected).',
      'feeder',
    );
    expect(guide.title).toBe('The scanner took too long to respond');
  });

  it('treats the new per-page and client timeouts as timeouts', () => {
    for (const msg of [
      'Scan failed: Scan timed out: no page received for 45 seconds (page 2)',
      'Scan timed out after 110 seconds',
    ]) {
      expect(getScanTroubleshootingGuide(msg, 'feeder').title).toBe(
        'The scanner took too long to respond',
      );
      expect(getScanTroubleshootingGuide(msg, 'glass').title).toBe(
        'The scanner took too long to respond',
      );
    }
  });

  it('shows the busy guide when another scan is in progress', () => {
    const guide = getScanTroubleshootingGuide(
      'Scan failed: Another scan is already in progress',
      'feeder',
    );
    expect(guide.title).toBe('The scanner is still busy');
  });

  it('keeps ADF errors classified as ADF errors', () => {
    expect(
      getScanTroubleshootingGuide('ADF paper jam detected', 'feeder').title,
    ).toBe('Printer ADF Error Detected');
  });

  it('keeps unknown messages on the generic guide', () => {
    expect(getScanTroubleshootingGuide('something odd', 'feeder').title).toBe(
      'Let’s try that again',
    );
  });
});
