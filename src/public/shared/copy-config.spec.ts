import { buildCopyConfig } from './copy-config';

const input = {
  previewPath: 'id-copy-1.pdf',
  releaseToken: 'token-1',
  paperSize: 'Short' as const,
  orientation: 'portrait' as const,
  colorMode: 'grayscale' as const,
  quality: 'high' as const,
  copies: 3,
};

describe('buildCopyConfig', () => {
  it('builds the object /confirm reads for a copy job', () => {
    expect(buildCopyConfig(input)).toEqual({
      scaling: 'fit',
      mode: 'copy',
      sessionId: null,
      documentId: null,
      filename: null,
      scanFilename: null,
      scanReleaseToken: null,
      copyPreviewPath: 'id-copy-1.pdf',
      copyPreviewReleaseToken: 'token-1',
      detectedColorMode: null,
      colorMode: 'grayscale',
      quality: 'high',
      duplex: false,
      copies: 3,
      orientation: 'portrait',
      rotationDeg: 0,
      paperSize: 'Short',
      pageRange: { type: 'all' },
      totalPages: 1,
    });
  });

  it.each([
    [0, 1],
    [-4, 1],
    [2.9, 2],
    [Number.NaN, 1],
    [500, 30],
  ])('clamps copies %p to %p', (copies, expected) => {
    expect(buildCopyConfig({ ...input, copies }).copies).toBe(expected);
  });
});
