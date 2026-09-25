import path from 'node:path';
import fs from 'node:fs';

describe('Deferred Conversion Pre-Print Gate', () => {
  it('ensures convertedPdfPath exists before spooling', async () => {
    const mockTarget = {
      documentId: 'doc-test-123',
      filePath: 'uploads/photo.jpg',
      convertedPdfPath: null as string | null,
    };

    const ensurePdfBeforePrint = async (
      target: typeof mockTarget,
      convertFn: () => Promise<string>,
    ) => {
      if (!target.convertedPdfPath) {
        target.convertedPdfPath = await convertFn();
      }
      return target.convertedPdfPath;
    };

    const converted = await ensurePdfBeforePrint(
      mockTarget,
      async () => 'uploads/doc-test-123.pdf',
    );
    expect(converted).toBe('uploads/doc-test-123.pdf');
    expect(mockTarget.convertedPdfPath).toBe('uploads/doc-test-123.pdf');
  });
});
