import {
  ADF_BUSY_GUIDE,
  ADF_CONNECTION_GUIDE,
  ADF_ERROR_GUIDE,
  ADF_NO_DOCUMENT_GUIDE,
  ADF_PAPER_JAM_GUIDE,
  ADF_UNKNOWN_GUIDE,
  FLATBED_FAILURE_GUIDE,
  FLATBED_NO_DOCUMENT_GUIDE,
  SCANNER_TIMEOUT_GUIDE,
  getCopyTroubleshootingGuide,
  getCopyTroubleshootingGuideForCode,
} from './troubleshooting';

describe('getCopyTroubleshootingGuideForCode', () => {
  it('picks the no-document guide for the source in use', () => {
    expect(getCopyTroubleshootingGuideForCode('NO_DOCUMENT', false)).toBe(
      FLATBED_NO_DOCUMENT_GUIDE,
    );
    expect(getCopyTroubleshootingGuideForCode('NO_DOCUMENT', true)).toBe(
      ADF_NO_DOCUMENT_GUIDE,
    );
  });

  it.each([false, true])(
    'never blames the document for a timeout (usesAdf=%s)',
    (usesAdf) => {
      expect(getCopyTroubleshootingGuideForCode('SCANNER_TIMEOUT', usesAdf)).toBe(
        SCANNER_TIMEOUT_GUIDE,
      );
    },
  );

  it.each([false, true])(
    'shows the connection guide when the scanner is offline (usesAdf=%s)',
    (usesAdf) => {
      expect(getCopyTroubleshootingGuideForCode('SCANNER_OFFLINE', usesAdf)).toBe(
        ADF_CONNECTION_GUIDE,
      );
    },
  );

  it('maps the remaining codes', () => {
    expect(getCopyTroubleshootingGuideForCode('SCANNER_BUSY', false)).toBe(
      ADF_BUSY_GUIDE,
    );
    expect(getCopyTroubleshootingGuideForCode('PAPER_JAM', true)).toBe(
      ADF_PAPER_JAM_GUIDE,
    );
    expect(getCopyTroubleshootingGuideForCode('ADF_ERROR', true)).toBe(
      ADF_ERROR_GUIDE,
    );
    expect(getCopyTroubleshootingGuideForCode('SCAN_FAILED', true)).toBe(
      ADF_UNKNOWN_GUIDE,
    );
    expect(getCopyTroubleshootingGuideForCode('SCAN_FAILED', false)).toBe(
      FLATBED_FAILURE_GUIDE,
    );
  });

  it('returns null for an unknown or missing code', () => {
    expect(getCopyTroubleshootingGuideForCode(undefined, false)).toBeNull();
    expect(getCopyTroubleshootingGuideForCode('WHATEVER', true)).toBeNull();
  });
});

describe('getCopyTroubleshootingGuide (message fallback)', () => {
  it.each([false, true])(
    'maps the copy page request timeout to the timeout guide (usesAdf=%s)',
    (usesAdf) => {
      expect(
        getCopyTroubleshootingGuide(
          'Document check timed out after 110 seconds',
          usesAdf,
        ),
      ).toBe(SCANNER_TIMEOUT_GUIDE);
    },
  );

  it('still maps a real no-document message on the glass', () => {
    expect(
      getCopyTroubleshootingGuide(
        'No document detected. Place your document face-down on the scanner glass and try again.',
        false,
      ),
    ).toBe(FLATBED_NO_DOCUMENT_GUIDE);
  });
});
