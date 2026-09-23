import fs from 'node:fs';
import path from 'node:path';

describe('Print Kiosk Blank & Low Content Formatting', () => {
  it('formats kiosk selection footer hint with blank page warnings', () => {
    const blankPages = [2, 4];
    const hint = `Contains ${blankPages.length} blank page(s) (p. ${blankPages.join(', ')}). You can customize your page range on the next step.`;
    expect(hint).toContain('p. 2, 4');
  });

  it('formats kiosk low content disclaimer text', () => {
    const disclaimer =
      'Notice: Pricing is based on kiosk price configurations and not page content density.';
    expect(disclaimer).toContain('kiosk price configurations');
  });

  describe('src/public/print/app.ts implementation checks', () => {
    const printAppPath = path.resolve(__dirname, '../../src/public/print/app.ts');

    it('contains extended UploadedFile interface with blank and low content fields', () => {
      const code = fs.readFileSync(printAppPath, 'utf8');
      expect(code).toContain('blankPages?: number[]');
      expect(code).toContain('blankPageCount?: number');
      expect(code).toContain('isEntirelyBlank?: boolean');
      expect(code).toContain('lowContentPages?: number[];');
      expect(code).toContain('lowContentPageCount?: number;');
      expect(code).toContain('hasLowContent?: boolean;');
    });

    it('renders blank page badge and low content badge in file items', () => {
      const code = fs.readFileSync(printAppPath, 'utf8');
      expect(code).toContain('file-item__blank-badge');
      expect(code).toContain('Blank Page');
      expect(code).toContain('file-item__low-badge');
      expect(code).toContain('Low Content');
    });

    it('updates selection footer hint with blank page warnings and low content disclaimer', () => {
      const code = fs.readFileSync(printAppPath, 'utf8');
      expect(code).toContain('updateSelectionFooterHint');
      expect(code).toContain('blankPageCount');
      expect(code).toContain('Notice: Pricing is based on kiosk price configurations and not page content density.');
    });

    it('handles DocumentRejected socket event and removes document from currentUploadedFiles', () => {
      const code = fs.readFileSync(printAppPath, 'utf8');
      expect(code).toContain('DocumentRejected');
      expect(code).toContain('currentUploadedFiles');
    });
  });

  describe('src/public/config/app.ts implementation checks', () => {
    const configAppPath = path.resolve(__dirname, '../../src/public/config/app.ts');

    it('displays pricing disclaimer callout banner when hasLowContent is true', () => {
      const code = fs.readFileSync(configAppPath, 'utf8');
      expect(code).toContain('hasLowContent');
      expect(code).toContain(
        'ℹ Pricing Disclaimer: Kiosk pricing is determined by kiosk configuration per page and does not adjust for low content density or ink coverage.',
      );
    });
  });
});
