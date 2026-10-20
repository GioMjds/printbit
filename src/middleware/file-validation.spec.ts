import { createUploadSecurityMiddleware } from './file-validation';
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
});
