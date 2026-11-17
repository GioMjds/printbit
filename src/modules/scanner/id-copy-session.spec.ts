import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ID_COPY_COMPLETE_TTL_MS,
  ID_COPY_INCOMPLETE_TTL_MS,
  IdCopySessionNotFoundError,
  IdCopySessionStore,
  purgeIdCopyFiles,
} from './id-copy-session';

let dir: string;
let clock: number;
let store: IdCopySessionStore;

async function writeScan(name: string): Promise<string> {
  await fs.promises.writeFile(path.join(dir, name), 'scan');
  return name;
}

const exists = (name: string) => fs.existsSync(path.join(dir, name));

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'id-session-'));
  clock = 1_000_000;
  store = new IdCopySessionStore({ scansDir: dir, now: () => clock });
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('IdCopySessionStore', () => {
  it('renames a scanned side to an id-side file', async () => {
    const session = store.create();
    const updated = await store.setSide(
      session.id,
      'front',
      await writeScan('scan-1.pdf'),
    );
    expect(updated.front!.fileName).toMatch(/^id-side-[0-9a-f-]+\.pdf$/);
    expect(exists(updated.front!.fileName)).toBe(true);
    expect(exists('scan-1.pdf')).toBe(false);
    expect(updated.front!.rotationDeg).toBe(0);
  });

  it('retaking a side deletes the old file, resets its rotation and keeps the other side', async () => {
    const session = store.create();
    await store.setSide(session.id, 'front', await writeScan('scan-1.pdf'));
    await store.setSide(session.id, 'back', await writeScan('scan-2.pdf'));
    store.setRotation(session.id, 'front', 180);
    store.setRotation(session.id, 'back', 90);
    const before = (await store.get(session.id))!;
    const oldFront = before.front!.fileName;
    const backFile = before.back!.fileName;

    const after = await store.setSide(
      session.id,
      'front',
      await writeScan('scan-3.pdf'),
    );

    expect(exists(oldFront)).toBe(false);
    expect(after.front!.rotationDeg).toBe(0);
    expect(after.back).toEqual({
      fileName: backFile,
      rotationDeg: 90,
      cardBox: null,
    });
    expect(exists(backFile)).toBe(true);
  });

  it('replacing the merged file deletes and returns the previous one', async () => {
    const session = store.create();
    await writeScan('id-copy-a.pdf');
    await writeScan('id-copy-b.pdf');
    expect(
      await store.setMerged(session.id, 'id-copy-a.pdf', 'token-a'),
    ).toBeNull();
    expect(await store.setMerged(session.id, 'id-copy-b.pdf', 'token-b')).toBe(
      'id-copy-a.pdf',
    );
    expect(exists('id-copy-a.pdf')).toBe(false);
    expect(exists('id-copy-b.pdf')).toBe(true);
    expect(store.findByReleaseToken('token-b')!.id).toBe(session.id);
    expect(store.findByReleaseToken('token-a')).toBeNull();
  });

  it('destroy deletes every file and forgets the session', async () => {
    const session = store.create();
    const withFront = await store.setSide(
      session.id,
      'front',
      await writeScan('scan-1.pdf'),
    );
    await writeScan('id-copy-a.pdf');
    await store.setMerged(session.id, 'id-copy-a.pdf', 'token-a');

    await store.destroy(session.id);

    expect(exists(withFront.front!.fileName)).toBe(false);
    expect(exists('id-copy-a.pdf')).toBe(false);
    expect(await store.get(session.id)).toBeNull();
  });

  it('expires an incomplete session after 10 idle minutes and deletes its files', async () => {
    const session = store.create();
    const withFront = await store.setSide(
      session.id,
      'front',
      await writeScan('scan-1.pdf'),
    );

    clock += ID_COPY_INCOMPLETE_TTL_MS - 1;
    expect(await store.get(session.id)).not.toBeNull();

    clock += ID_COPY_INCOMPLETE_TTL_MS;
    expect(await store.get(session.id)).toBeNull();
    expect(exists(withFront.front!.fileName)).toBe(false);
  });

  it('keeps a complete session for 45 idle minutes so a slow payer still prints', async () => {
    const session = store.create();
    await store.setSide(session.id, 'front', await writeScan('scan-1.pdf'));
    await store.setSide(session.id, 'back', await writeScan('scan-2.pdf'));
    await writeScan('id-copy-a.pdf');
    await store.setMerged(session.id, 'id-copy-a.pdf', 'token-a');

    clock += ID_COPY_INCOMPLETE_TTL_MS * 3;
    expect(await store.purgeExpired()).toBe(0);
    expect(exists('id-copy-a.pdf')).toBe(true);

    clock += ID_COPY_COMPLETE_TTL_MS;
    expect(await store.purgeExpired()).toBe(1);
    expect(exists('id-copy-a.pdf')).toBe(false);
  });

  it('destroys a complete session whose merged sheet was deleted, well inside the TTL', async () => {
    const session = store.create();
    await store.setSide(session.id, 'front', await writeScan('scan-1.pdf'));
    await store.setSide(session.id, 'back', await writeScan('scan-2.pdf'));
    await writeScan('id-copy-a.pdf');
    await store.setMerged(session.id, 'id-copy-a.pdf', 'token-a');
    const complete = store.findByReleaseToken('token-a')!;
    const front = complete.front!.fileName;
    const back = complete.back!.fileName;

    // The paid copy job deletes the merged sheet itself after printing.
    await fs.promises.unlink(path.join(dir, 'id-copy-a.pdf'));
    clock += 1;

    expect(await store.purgeExpired()).toBe(1);
    expect(exists(front)).toBe(false);
    expect(exists(back)).toBe(false);
    expect(store.findByReleaseToken('token-a')).toBeNull();
  });

  it('keeps a complete session whose merged sheet still exists inside the TTL', async () => {
    const session = store.create();
    await store.setSide(session.id, 'front', await writeScan('scan-1.pdf'));
    await store.setSide(session.id, 'back', await writeScan('scan-2.pdf'));
    await writeScan('id-copy-a.pdf');
    await store.setMerged(session.id, 'id-copy-a.pdf', 'token-a');

    clock += 1;

    expect(await store.purgeExpired()).toBe(0);
    expect(store.findByReleaseToken('token-a')!.id).toBe(session.id);
    expect(exists('id-copy-a.pdf')).toBe(true);
  });

  it('leaves a session with no merged sheet yet to the normal TTL', async () => {
    const session = store.create();
    const withFront = await store.setSide(
      session.id,
      'front',
      await writeScan('scan-1.pdf'),
    );

    clock += 1;

    expect(await store.purgeExpired()).toBe(0);
    expect(exists(withFront.front!.fileName)).toBe(true);
    expect(await store.get(session.id)).not.toBeNull();
  });

  it('rejects writes to an unknown session', async () => {
    await expect(
      store.setSide('nope', 'front', 'scan-1.pdf'),
    ).rejects.toBeInstanceOf(IdCopySessionNotFoundError);
    expect(() => store.setRotation('nope', 'front', 90)).toThrow(
      IdCopySessionNotFoundError,
    );
    await expect(
      store.setMerged('nope', 'id-copy-a.pdf', 't'),
    ).rejects.toBeInstanceOf(IdCopySessionNotFoundError);
  });

  it('deletes the scanned file when the session id is unknown', async () => {
    await expect(
      store.setSide('nope', 'front', await writeScan('scan-1.pdf')),
    ).rejects.toBeInstanceOf(IdCopySessionNotFoundError);
    expect(exists('scan-1.pdf')).toBe(false);
  });

  it('leaves no id-side file when the session is destroyed during setSide', async () => {
    const session = store.create();
    const pending = store.setSide(
      session.id,
      'front',
      await writeScan('scan-1.pdf'),
    );
    await store.destroy(session.id);

    await expect(pending).rejects.toBeInstanceOf(IdCopySessionNotFoundError);
    expect(await fs.promises.readdir(dir)).toEqual([]);
  });

  it('deletes the raw scan and rethrows when the rename fails', async () => {
    const session = store.create();
    const failure = Object.assign(new Error('resource busy'), {
      code: 'EBUSY',
    });
    const rename = jest
      .spyOn(fs.promises, 'rename')
      .mockRejectedValueOnce(failure);
    try {
      await expect(
        store.setSide(session.id, 'front', await writeScan('scan-1.pdf')),
      ).rejects.toBe(failure);
    } finally {
      rename.mockRestore();
    }
    expect(exists('scan-1.pdf')).toBe(false);
    expect(await fs.promises.readdir(dir)).toEqual([]);
  });

  it('survives a file that is already gone', async () => {
    const session = store.create();
    const withFront = await store.setSide(
      session.id,
      'front',
      await writeScan('scan-1.pdf'),
    );
    await fs.promises.unlink(path.join(dir, withFront.front!.fileName));
    await expect(store.destroy(session.id)).resolves.toBeUndefined();
  });
});

describe('purgeIdCopyFiles', () => {
  it('deletes ID files and leaves other scans', async () => {
    await writeScan('id-side-0a1b.pdf');
    await writeScan('id-copy-2c3d.pdf');
    await writeScan('scan-123.pdf');
    expect(await purgeIdCopyFiles(dir)).toBe(2);
    expect(exists('id-side-0a1b.pdf')).toBe(false);
    expect(exists('id-copy-2c3d.pdf')).toBe(false);
    expect(exists('scan-123.pdf')).toBe(true);
  });

  it('returns 0 when the folder does not exist', async () => {
    expect(await purgeIdCopyFiles(path.join(dir, 'missing'))).toBe(0);
  });
});
