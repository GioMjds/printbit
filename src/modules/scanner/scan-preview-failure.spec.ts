import { ScannerError } from '@/services/scanner';
import { describeScanPreviewFailure } from './scan-preview-failure';

describe('describeScanPreviewFailure', () => {
  // The two messages below are the only pre-scan failures in the audited logs
  // (32 and 17 of 49). Both used to be shown as "No document detected".
  it('reports a worker that never answered as a timeout, not a missing document', () => {
    const failure = describeScanPreviewFailure(
      new ScannerError(
        'Scan failed: No response received from C# Worker (IPC timeout or disconnected).',
        'WORKER_NO_RESPONSE',
      ),
      'flatbed',
    );

    expect(failure.code).toBe('SCANNER_TIMEOUT');
    expect(failure.error.toLowerCase()).not.toContain('no document');
  });

  it('reports "The selected scanner is offline." as offline', () => {
    const failure = describeScanPreviewFailure(
      new ScannerError(
        'Scan failed: The selected scanner is offline.',
        'PROCESS_FAILED',
      ),
      'flatbed',
    );

    expect(failure.code).toBe('SCANNER_OFFLINE');
    expect(failure.error.toLowerCase()).not.toContain('no document');
  });

  it('keeps the glass wording only for a real empty glass', () => {
    const failure = describeScanPreviewFailure(
      new ScannerError(
        'Scan failed: No pages received from scanner',
        'OUTPUT_FILE_MISSING',
      ),
      'flatbed',
    );

    expect(failure.code).toBe('NO_DOCUMENT');
    expect(failure.error).toContain('scanner glass');
  });

  it('does not mention the glass when the feeder is empty', () => {
    const failure = describeScanPreviewFailure(
      new ScannerError(
        'Scan failed: ADF feeder is empty or paper feed not detected',
        'FEEDER_EMPTY',
      ),
      'adf',
    );

    expect(failure.code).toBe('NO_DOCUMENT');
    expect(failure.error).not.toContain('glass');
    expect(failure.error.toLowerCase()).toContain('feeder');
  });

  it.each([
    ['SCAN_TIMEOUT', 'Scan failed: Scan timed out after 90 seconds'],
    [
      'SCAN_PAGE_TIMEOUT',
      'Scan failed: Scan timed out: no page received for 45 seconds (page 1)',
    ],
  ])('maps worker code %s to a timeout', (workerCode, message) => {
    expect(
      describeScanPreviewFailure(new ScannerError(message, workerCode), 'adf')
        .code,
    ).toBe('SCANNER_TIMEOUT');
  });

  it.each(['SCANNER_BUSY', 'DEVICE_BUSY'])(
    'maps worker code %s to busy',
    (workerCode) => {
      expect(
        describeScanPreviewFailure(
          new ScannerError(
            'Scan failed: Another scan is already in progress',
            workerCode,
          ),
          'flatbed',
        ).code,
      ).toBe('SCANNER_BUSY');
    },
  );

  it('maps SCANNER_UNAVAILABLE to offline', () => {
    expect(
      describeScanPreviewFailure(
        new ScannerError(
          'Scan failed: Scanner is unavailable',
          'SCANNER_UNAVAILABLE',
        ),
        'adf',
      ).code,
    ).toBe('SCANNER_OFFLINE');
  });

  it('maps a jam to PAPER_JAM even though the worker text mentions the feeder', () => {
    expect(
      describeScanPreviewFailure(
        new ScannerError('Scan failed: Paper jam in feeder', 'PAPER_JAM'),
        'adf',
      ).code,
    ).toBe('PAPER_JAM');
  });

  it('keeps the simulated ADF error message', () => {
    const message =
      'Printer ADF Error Detected. Clear the printer ADF error or paper jam, then proceed with scanning.';
    const failure = describeScanPreviewFailure(new Error(message), 'adf');

    expect(failure.code).toBe('ADF_ERROR');
    expect(failure.error).toBe(message);
  });

  it('falls back to a generic failure, never to "No document detected"', () => {
    const failure = describeScanPreviewFailure(
      new ScannerError('Scan failed: Something odd', 'PROCESS_FAILED'),
      'flatbed',
    );

    expect(failure.code).toBe('SCAN_FAILED');
    expect(failure.error.toLowerCase()).not.toContain('no document');
  });

  it('handles a non-Error value', () => {
    expect(describeScanPreviewFailure('boom', 'flatbed').code).toBe(
      'SCAN_FAILED',
    );
  });
});
