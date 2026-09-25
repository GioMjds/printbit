import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  EXTENSION_MIME_MAP,
  MAGIC_SIGNATURES,
} from '../../src/utils/file-types';

describe('File Type Validation - GIF Support', () => {
  it('allows .gif extension and image/gif MIME type', () => {
    expect(ALLOWED_EXTENSIONS.has('.gif')).toBe(true);
    expect(ALLOWED_MIME_TYPES.has('image/gif')).toBe(true);
    expect(EXTENSION_MIME_MAP['.gif']).toBe('image/gif');
  });

  it('contains valid magic signatures for GIF87a and GIF89a', () => {
    const signatures = MAGIC_SIGNATURES['image/gif'];
    expect(signatures).toBeDefined();
    expect(signatures.length).toBeGreaterThanOrEqual(2);
    // GIF87a: 0x47, 0x49, 0x46, 0x38, 0x37, 0x61
    expect(signatures[0].bytes).toEqual([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
    // GIF89a: 0x47, 0x49, 0x46, 0x38, 0x39, 0x61
    expect(signatures[1].bytes).toEqual([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  });
});
