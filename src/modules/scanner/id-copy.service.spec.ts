import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { IdCopyService, parseIdRotations } from './id-copy.service';
import {
  IdCopySessionNotFoundError,
  IdCopySessionStore,
} from './id-copy-session';

let dir: string;
let sessions: IdCopySessionStore;
let service: IdCopyService;
let scanShouldFail: boolean;
let scanCount: number;
let thumbnailFor: (filePath: string) => Uint8Array;
let onRegisterToken: (() => void) | null;
const tokens = new Map<string, string>();
const invalidated: string[] = [];

/** A thumbnail with a dark block whose position depends on `seed`. */
function patterned(seed: number): Uint8Array {
  const out = new Uint8Array(1024).fill(230);
  const start = (seed % 4) * 200;
  for (let i = start; i < start + 180; i += 1) out[i] = 30;
  return out;
}

const exists = (name: string) => fs.existsSync(path.join(dir, name));

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'id-service-'));
  sessions = new IdCopySessionStore({ scansDir: dir });
  scanShouldFail = false;
  scanCount = 0;
  onRegisterToken = null;
  tokens.clear();
  invalidated.length = 0;
  const seeds = new Map<string, number>();
  thumbnailFor = (filePath) => {
    if (!seeds.has(filePath)) seeds.set(filePath, seeds.size);
    return patterned(seeds.get(filePath)!);
  };
  service = new IdCopyService({
    scansDir: dir,
    sessions,
    scanIdRegion: async () => {
      if (scanShouldFail) throw new Error('scanner busy');
      scanCount += 1;
      const doc = await PDFDocument.create();
      // pdf-lib cannot embed a page without contents, as a real scan has.
      doc.addPage([283, 283]).drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
      const outputPath = path.join(dir, `scan-${scanCount}.pdf`);
      await fs.promises.writeFile(outputPath, await doc.save());
      return { outputPath };
    },
    describeFailure: () => ({
      code: 'SCANNER_BUSY',
      error: 'The scanner is busy.',
    }),
    registerReleaseToken: (fileName) => {
      onRegisterToken?.();
      const token = `token-${tokens.size + 1}`;
      tokens.set(token, fileName);
      return token;
    },
    invalidateReleaseTokens: (fileName) => {
      invalidated.push(fileName);
    },
    thumbnail: async (filePath) => thumbnailFor(filePath),
  });
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('IdCopyService.scanSide', () => {
  it('creates a session and a front-only sheet', async () => {
    const result = await service.scanSide({ side: 'front', paperSize: 'A4' });
    if (!result.detected) throw new Error('expected a sheet');
    expect(result.sides).toEqual({ front: true, back: false });
    expect(result.complete).toBe(false);
    expect(result.previewPath).toMatch(/^id-copy-[0-9a-f-]+\.pdf$/);
    expect(exists(result.previewPath)).toBe(true);
    expect(tokens.get(result.releaseToken)).toBe(result.previewPath);
    expect(result.warnings).toEqual([]);
  });

  it('completes on the back scan and replaces the merged file', async () => {
    const first = await service.scanSide({ side: 'front', paperSize: 'A4' });
    if (!first.detected) throw new Error('expected a sheet');
    const second = await service.scanSide({
      sessionId: first.sessionId,
      side: 'back',
      paperSize: 'A4',
    });
    if (!second.detected) throw new Error('expected a sheet');
    expect(second.complete).toBe(true);
    expect(second.previewPath).not.toBe(first.previewPath);
    expect(exists(first.previewPath)).toBe(false);
    expect(invalidated).toContain(first.previewPath);
    const doc = await PDFDocument.load(
      await fs.promises.readFile(path.join(dir, second.previewPath)),
    );
    expect(doc.getPageCount()).toBe(1);
  });

  it('keeps the front and the session when the back scan fails', async () => {
    const first = await service.scanSide({ side: 'front', paperSize: 'A4' });
    if (!first.detected) throw new Error('expected a sheet');
    scanShouldFail = true;
    const failed = await service.scanSide({
      sessionId: first.sessionId,
      side: 'back',
      paperSize: 'A4',
    });
    expect(failed).toEqual({
      detected: false,
      sessionId: first.sessionId,
      code: 'SCANNER_BUSY',
      error: 'The scanner is busy.',
    });
    expect(exists(first.previewPath)).toBe(true);
    const sheet = await service.compose({
      sessionId: first.sessionId,
      paperSize: 'A4',
      rotations: {},
    });
    expect(sheet.sides).toEqual({ front: true, back: false });
  });

  it('resets only the retaken side when a rotated front is rescanned', async () => {
    const first = await service.scanSide({ side: 'front', paperSize: 'A4' });
    if (!first.detected) throw new Error('expected a sheet');
    await service.scanSide({
      sessionId: first.sessionId,
      side: 'back',
      paperSize: 'A4',
    });
    await service.compose({
      sessionId: first.sessionId,
      paperSize: 'A4',
      rotations: { front: 180, back: 90 },
    });
    await service.scanSide({
      sessionId: first.sessionId,
      side: 'front',
      paperSize: 'A4',
    });
    const session = (await sessions.get(first.sessionId))!;
    expect(session.front!.rotationDeg).toBe(0);
    expect(session.back!.rotationDeg).toBe(90);
  });

  it('rejects a session id the server does not know', async () => {
    await expect(
      service.scanSide({ sessionId: 'gone', side: 'back', paperSize: 'A4' }),
    ).rejects.toBeInstanceOf(IdCopySessionNotFoundError);
    expect(scanCount).toBe(0);
  });

  it('passes scan warnings through', async () => {
    thumbnailFor = () => new Uint8Array(1024).fill(238);
    const result = await service.scanSide({ side: 'front', paperSize: 'A4' });
    if (!result.detected) throw new Error('expected a sheet');
    expect(result.warnings).toEqual([{ code: 'side_blank', side: 'front' }]);
  });
});

describe('IdCopyService when the session is destroyed mid-rebuild', () => {
  it('deletes the new sheet and its token instead of orphaning them', async () => {
    const first = await service.scanSide({ side: 'front', paperSize: 'A4' });
    if (!first.detected) throw new Error('expected a sheet');
    let destroyed: Promise<void> = Promise.resolve();
    onRegisterToken = () => {
      destroyed = sessions.destroy(first.sessionId);
    };
    invalidated.length = 0;

    await expect(
      service.compose({
        sessionId: first.sessionId,
        paperSize: 'A4',
        rotations: {},
      }),
    ).rejects.toBeInstanceOf(IdCopySessionNotFoundError);
    await destroyed;

    expect(fs.readdirSync(dir)).toEqual([]);
    expect(invalidated).toContain([...tokens.values()].pop());
  });
});

describe('IdCopyService.compose', () => {
  it('rebuilds for another paper size without scanning', async () => {
    const first = await service.scanSide({ side: 'front', paperSize: 'A4' });
    if (!first.detected) throw new Error('expected a sheet');
    const sheet = await service.compose({
      sessionId: first.sessionId,
      paperSize: 'Long',
      rotations: {},
    });
    expect(scanCount).toBe(1);
    const doc = await PDFDocument.load(
      await fs.promises.readFile(path.join(dir, sheet.previewPath)),
    );
    expect(doc.getPage(0).getSize().height).toBeCloseTo(936, 1);
  });

  it('rejects an unknown session', async () => {
    await expect(
      service.compose({ sessionId: 'gone', paperSize: 'A4', rotations: {} }),
    ).rejects.toBeInstanceOf(IdCopySessionNotFoundError);
  });
});

describe('IdCopyService.releaseByToken', () => {
  it('deletes the sheet and both sides, once', async () => {
    const first = await service.scanSide({ side: 'front', paperSize: 'A4' });
    if (!first.detected) throw new Error('expected a sheet');
    const second = await service.scanSide({
      sessionId: first.sessionId,
      side: 'back',
      paperSize: 'A4',
    });
    if (!second.detected) throw new Error('expected a sheet');

    const released = await service.releaseByToken(second.releaseToken);

    expect(released).toEqual({ fileName: second.previewPath });
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(await service.releaseByToken(second.releaseToken)).toBeNull();
  });

  it('returns null for a token that is not an ID session', async () => {
    expect(await service.releaseByToken('other')).toBeNull();
  });
});

describe('parseIdRotations', () => {
  it('accepts quarter turns and missing sides', () => {
    expect(parseIdRotations({ front: 90, back: 270 })).toEqual({
      front: 90,
      back: 270,
    });
    expect(parseIdRotations({ back: 0 })).toEqual({ back: 0 });
    expect(parseIdRotations(undefined)).toEqual({});
    expect(parseIdRotations(null)).toEqual({});
  });

  it('rejects anything that is not a quarter turn', () => {
    expect(parseIdRotations({ front: 45 })).toBeNull();
    expect(parseIdRotations({ back: '90' })).toBeNull();
    expect(parseIdRotations('front')).toBeNull();
    expect(parseIdRotations([90])).toBeNull();
  });
});
