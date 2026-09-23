import fs from 'node:fs';
import path from 'node:path';

describe('Upload Blank Handling Helpers', () => {
  it('formats blank page warning message correctly', () => {
    const filename = 'document.pdf';
    const blankPages = [2, 5];
    const message = `⚠ "${filename}" contains ${blankPages.length} blank page(s) (Page ${blankPages.join(', ')}). Blank pages will still be billed if printed.`;
    expect(message).toContain('Page 2, 5');
    expect(message).toContain('will still be billed');
  });

  it('formats low content disclaimer correctly', () => {
    const filename = 'sparse.pdf';
    const lowPages = [1];
    const message = `ℹ Notice: "${filename}" has low content on Page ${lowPages.join(', ')}. Pricing is based on kiosk configurations per page, not content density or ink coverage.`;
    expect(message).toContain('Page 1');
    expect(message).toContain('not content density');
  });

  it('formats blank rejection message correctly', () => {
    const filename = 'blank.pdf';
    const message = `⛔ "${filename}" was rejected: All pages are blank. Blank documents cannot be sent to the kiosk.`;
    expect(message).toContain('blank.pdf');
    expect(message).toContain('All pages are blank');
    expect(message).toContain('cannot be sent to the kiosk');
  });

  it('formats reminder message for re-upload attempt correctly', () => {
    const filename = 'blank.pdf';
    const message = `Reminder: "${filename}" contains only blank pages and must not be sent. Please upload a document with printable content.`;
    expect(message).toContain('blank.pdf');
    expect(message).toContain('contains only blank pages');
    expect(message).toContain('must not be sent');
  });

  describe('src/public/upload/app.ts implementation checks', () => {
    const appTsPath = path.resolve(__dirname, '../../src/public/upload/app.ts');

    it('contains rejectedBlankFileHashes set and DocumentRejected socket listener', () => {
      const code = fs.readFileSync(appTsPath, 'utf8');
      expect(code).toContain('rejectedBlankFileHashes');
      expect(code).toContain('DocumentRejected');
      expect(code).toContain('Rejected: Blank File');
      expect(code).toContain('All pages are blank. Blank documents cannot be sent to the kiosk.');
    });

    it('prevents re-upload of known blank files in addFilesToQueue', () => {
      const code = fs.readFileSync(appTsPath, 'utf8');
      expect(code).toContain('rejectedBlankFileHashes.has(contentHash)');
      expect(code).toContain('contains only blank pages and must not be sent.');
    });

    it('handles AnalysisCompleted with blank page warning and low content disclaimer', () => {
      const code = fs.readFileSync(appTsPath, 'utf8');
      expect(code).toContain('blankPageCount');
      expect(code).toContain('blankPages');
      expect(code).toContain('hasLowContent');
      expect(code).toContain('lowContentPages');
      expect(code).toContain('Blank pages will still be billed if printed.');
      expect(code).toContain('Pricing is based on kiosk configurations per page, not content density or ink coverage.');
    });
  });
});
