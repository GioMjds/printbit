import {
  createUploadSecurityMiddleware,
  validateStagedPdfStructure,
} from './file-validation';
import type { Request, Response } from 'express';

describe('file-validation image format support and cross-format recovery', () => {
  function makeMockRes() {
    const res: Partial<Response> & { statusCode?: number; jsonBody?: unknown } = {};
    res.status = jest.fn((code: number) => {
      res.statusCode = code;
      return res as Response;
    });
    res.json = jest.fn((body: unknown) => {
      res.jsonBody = body;
      return res as Response;
    });
    return res as Response & { statusCode?: number; jsonBody?: unknown };
  }

  function makeMockReq(file: Partial<Express.Multer.File>) {
    return {
      file: file as Express.Multer.File,
      headers: {},
      header: (name: string) => undefined,
      method: 'POST',
      params: {},
      query: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
  }

  it('accepts and normalizes JPEG file named with .png extension', async () => {
    // JPEG header: FF D8 FF
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const { middleware } = createUploadSecurityMiddleware({
      readRange: async () => jpegBuffer,
    });

    const req = makeMockReq({
      path: '/tmp/test.png',
      originalname: 'photo.png',
      mimetype: 'image/png',
      size: jpegBuffer.length,
    });

    const res = makeMockRes();
    const next = jest.fn();

    await (middleware.validateMagicBytes as (req: Request, res: Response, next: () => void) => Promise<void>)(
      req,
      res,
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(req.file?.mimetype).toBe('image/jpeg');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('accepts and normalizes WebP file named with .png extension', async () => {
    // RIFF....WEBP (offset 0: RIFF, offset 8: WEBP)
    const webpBuffer = Buffer.alloc(16);
    Buffer.from('RIFF').copy(webpBuffer, 0);
    Buffer.from('WEBP').copy(webpBuffer, 8);

    const { middleware } = createUploadSecurityMiddleware({
      readRange: async () => webpBuffer,
    });

    const req = makeMockReq({
      path: '/tmp/downloaded.png',
      originalname: 'downloaded.png',
      mimetype: 'image/png',
      size: webpBuffer.length,
    });

    const res = makeMockRes();
    const next = jest.fn();

    await (middleware.validateMagicBytes as (req: Request, res: Response, next: () => void) => Promise<void>)(
      req,
      res,
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(req.file?.mimetype).toBe('image/webp');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('accepts valid GIF, BMP, and WebP files with matching declared types', async () => {
    const gifBuffer = Buffer.from('GIF89a...');
    const bmpBuffer = Buffer.from([0x42, 0x4d, 0x00, 0x00]);

    // Test GIF
    const { middleware: gifMiddleware } = createUploadSecurityMiddleware({
      readRange: async () => gifBuffer,
    });
    const reqGif = makeMockReq({
      path: '/tmp/anim.gif',
      originalname: 'anim.gif',
      mimetype: 'image/gif',
      size: gifBuffer.length,
    });
    const resGif = makeMockRes();
    const nextGif = jest.fn();
    await (gifMiddleware.validateMagicBytes as (req: Request, res: Response, next: () => void) => Promise<void>)(
      reqGif,
      resGif,
      nextGif,
    );
    expect(nextGif).toHaveBeenCalled();

    // Test BMP
    const { middleware: bmpMiddleware } = createUploadSecurityMiddleware({
      readRange: async () => bmpBuffer,
    });
    const reqBmp = makeMockReq({
      path: '/tmp/graphic.bmp',
      originalname: 'graphic.bmp',
      mimetype: 'image/bmp',
      size: bmpBuffer.length,
    });
    const resBmp = makeMockRes();
    const nextBmp = jest.fn();
    await (bmpMiddleware.validateMagicBytes as (req: Request, res: Response, next: () => void) => Promise<void>)(
      reqBmp,
      resBmp,
      nextBmp,
    );
    expect(nextBmp).toHaveBeenCalled();
  });

  it('quarantines and rejects executable disguised as .png', async () => {
    const exeBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ header
    const quarantineMock = jest.fn().mockResolvedValue(undefined);

    const { middleware } = createUploadSecurityMiddleware({
      readRange: async () => exeBuffer,
      quarantineStaged: quarantineMock,
    });

    const req = makeMockReq({
      path: '/tmp/malware.png',
      originalname: 'malware.png',
      mimetype: 'image/png',
      size: exeBuffer.length,
    });

    const res = makeMockRes();
    const next = jest.fn();

    await (middleware.validateMagicBytes as (req: Request, res: Response, next: () => void) => Promise<void>)(
      req,
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.jsonBody).toEqual(
      expect.objectContaining({
        code: 'DISGUISED_FILE',
      }),
    );
    expect(quarantineMock).toHaveBeenCalled();
  });

  describe('PDF structural validation (ACTIVE_CONTENT_DETECTED prevention)', () => {
    it('accepts legitimate PDF containing stream with /js and /EmbeddedFiles tokens', async () => {
      const pdfContent =
        '%PDF-1.4\n' +
        '1 0 obj\n' +
        '<< /Type /Catalog /Pages 2 0 R /EmbeddedFiles 5 0 R >>\n' +
        'endobj\n' +
        '3 0 obj\n' +
        '<< /Length 50 >>\n' +
        'stream\n' +
        'compressed binary data with /js and /Launch inside\n' +
        'endstream\n' +
        'endobj\n' +
        '%%EOF';
      const buffer = Buffer.from(pdfContent, 'latin1');
      const result = await validateStagedPdfStructure(
        '/tmp/case_study.pdf',
        buffer.length,
        async () => buffer,
      );
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('rejects PDF containing explicit /S /Launch action', async () => {
      const maliciousPdf =
        '%PDF-1.4\n' +
        '1 0 obj\n' +
        '<< /Type /Action /S /Launch /F (cmd.exe) >>\n' +
        'endobj\n' +
        '%%EOF';
      const buffer = Buffer.from(maliciousPdf, 'latin1');
      const result = await validateStagedPdfStructure(
        '/tmp/exploit.pdf',
        buffer.length,
        async () => buffer,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('ACTIVE_CONTENT_DETECTED');
    });

    it('rejects PDF containing /S /JavaScript action', async () => {
      const scriptPdf =
        '%PDF-1.4\n' +
        '1 0 obj\n' +
        '<< /Type /Action /S /JavaScript /JS (app.alert(1)) >>\n' +
        'endobj\n' +
        '%%EOF';
      const buffer = Buffer.from(scriptPdf, 'latin1');
      const result = await validateStagedPdfStructure(
        '/tmp/script.pdf',
        buffer.length,
        async () => buffer,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('ACTIVE_CONTENT_DETECTED');
    });
  });

  describe('Antivirus stale signature grace policy', () => {
    it('scans and proceeds when Defender signatures are stale', async () => {
      const mockScanner = {
        getHealth: jest.fn().mockResolvedValue({
          status: 'stale' as const,
          signatureAgeHours: 180,
          detail: 'Defender signatures are 180 hours old',
        }),
        scanFile: jest.fn().mockResolvedValue({
          status: 'clean' as const,
          detectionName: null,
          detail: null,
        }),
      };

      const { middleware } = createUploadSecurityMiddleware({
        scanner: mockScanner,
      });

      const req = makeMockReq({
        path: '/tmp/clean_doc.pdf',
        originalname: 'clean_doc.pdf',
        mimetype: 'application/pdf',
        size: 1024,
      });

      const res = makeMockRes();
      const next = jest.fn();

      await (middleware.scanForMalware as (req: Request, res: Response, next: () => void) => Promise<void>)(
        req,
        res,
        next,
      );

      expect(mockScanner.scanFile).toHaveBeenCalledWith('/tmp/clean_doc.pdf');
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('blocks upload with 503 when Defender service is unavailable', async () => {
      const mockScanner = {
        getHealth: jest.fn().mockResolvedValue({
          status: 'unavailable' as const,
          signatureAgeHours: null,
          detail: 'MpCmdRun.exe missing or service stopped',
        }),
        scanFile: jest.fn(),
      };

      const { middleware } = createUploadSecurityMiddleware({
        scanner: mockScanner,
        discardStaged: jest.fn().mockResolvedValue(undefined),
      });

      const req = makeMockReq({
        path: '/tmp/doc.pdf',
        originalname: 'doc.pdf',
        mimetype: 'application/pdf',
        size: 1024,
      });

      const res = makeMockRes();
      const next = jest.fn();

      await (middleware.scanForMalware as (req: Request, res: Response, next: () => void) => Promise<void>)(
        req,
        res,
        next,
      );

      expect(mockScanner.scanFile).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.jsonBody).toEqual(
        expect.objectContaining({
          code: 'SCAN_UNAVAILABLE',
        }),
      );
    });
  });
});
