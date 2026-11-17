import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IdRotation, IdSide } from '@/shared/id-card-layout';

/** An abandoned capture is removed quickly: the files are ID images. */
export const ID_COPY_INCOMPLETE_TTL_MS = 10 * 60 * 1000;
/** A finished sheet lives as long as a normal copy preview's release token. */
export const ID_COPY_COMPLETE_TTL_MS = 45 * 60 * 1000;

const ID_FILE_PATTERN = /^id-(side|copy)-[0-9a-f-]+\.pdf$/i;

export class IdCopySessionNotFoundError extends Error {
  constructor() {
    super('ID copy session not found.');
    this.name = 'IdCopySessionNotFoundError';
  }
}

export interface IdCopySideRecord {
  fileName: string;
  rotationDeg: IdRotation;
}

export interface IdCopySession {
  id: string;
  front: IdCopySideRecord | null;
  back: IdCopySideRecord | null;
  mergedFileName: string | null;
  releaseToken: string | null;
  touchedAt: number;
}

async function removeFile(dir: string, fileName: string): Promise<void> {
  try {
    await fs.promises.unlink(path.join(dir, fileName));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Leave it for the startup purge; never fail the customer's flow.
      console.warn(`[ID-COPY] Could not delete a session file (${code}).`);
    }
  }
}

export class IdCopySessionStore {
  private readonly sessions = new Map<string, IdCopySession>();
  private readonly scansDir: string;
  private readonly now: () => number;

  constructor(options: { scansDir: string; now?: () => number }) {
    this.scansDir = options.scansDir;
    this.now = options.now ?? Date.now;
  }

  create(): IdCopySession {
    const session: IdCopySession = {
      id: randomUUID(),
      front: null,
      back: null,
      mergedFileName: null,
      releaseToken: null,
      touchedAt: this.now(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async get(id: string): Promise<IdCopySession | null> {
    await this.purgeExpired();
    const session = this.sessions.get(id);
    if (!session) return null;
    session.touchedAt = this.now();
    return session;
  }

  async setSide(
    id: string,
    side: IdSide,
    scannedFileName: string,
  ): Promise<IdCopySession> {
    const session = this.sessions.get(id);
    if (!session) {
      // The raw scan is an ID image the startup purge would not match.
      await removeFile(this.scansDir, path.basename(scannedFileName));
      throw new IdCopySessionNotFoundError();
    }
    const fileName = `id-side-${randomUUID()}.pdf`;
    await fs.promises.rename(
      path.join(this.scansDir, path.basename(scannedFileName)),
      path.join(this.scansDir, fileName),
    );
    if (this.sessions.get(id) !== session) {
      // Destroyed while the rename was in flight: nothing else owns this file.
      await removeFile(this.scansDir, fileName);
      throw new IdCopySessionNotFoundError();
    }
    const previous = session[side];
    session[side] = { fileName, rotationDeg: 0 };
    session.touchedAt = this.now();
    if (previous) await removeFile(this.scansDir, previous.fileName);
    return session;
  }

  setRotation(
    id: string,
    side: IdSide,
    rotationDeg: IdRotation,
  ): IdCopySession {
    const session = this.require(id);
    const record = session[side];
    if (record) record.rotationDeg = rotationDeg;
    session.touchedAt = this.now();
    return session;
  }

  async setMerged(
    id: string,
    fileName: string,
    releaseToken: string,
  ): Promise<string | null> {
    const session = this.require(id);
    const previous = session.mergedFileName;
    session.mergedFileName = fileName;
    session.releaseToken = releaseToken;
    session.touchedAt = this.now();
    if (previous && previous !== fileName) {
      await removeFile(this.scansDir, previous);
      return previous;
    }
    return null;
  }

  findByReleaseToken(token: string): IdCopySession | null {
    for (const session of this.sessions.values()) {
      if (session.releaseToken === token) return session;
    }
    return null;
  }

  async destroy(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    const files = [
      session.front?.fileName,
      session.back?.fileName,
      session.mergedFileName,
    ].filter((name): name is string => Boolean(name));
    for (const name of files) await removeFile(this.scansDir, name);
  }

  async purgeExpired(): Promise<number> {
    const now = this.now();
    const expired = [...this.sessions.values()].filter((session) => {
      const ttl =
        session.front && session.back
          ? ID_COPY_COMPLETE_TTL_MS
          : ID_COPY_INCOMPLETE_TTL_MS;
      return now - session.touchedAt >= ttl;
    });
    for (const session of expired) await this.destroy(session.id);
    return expired.length + (await this.destroySessionsWithMissingSheet());
  }

  /**
   * Frees sessions whose merged sheet is gone from disk (the paid copy job
   * deletes it after printing). A rebuild writes the new sheet before
   * `setMerged` records its name, so a live session's sheet always exists.
   */
  private async destroySessionsWithMissingSheet(): Promise<number> {
    let destroyed = 0;
    for (const session of [...this.sessions.values()]) {
      const merged = session.mergedFileName;
      if (!merged) continue;
      try {
        await fs.promises.access(path.join(this.scansDir, merged));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
        // Skip a session rebuilt or destroyed while the check was in flight.
        if (this.sessions.get(session.id) !== session) continue;
        if (session.mergedFileName !== merged) continue;
        await this.destroy(session.id);
        destroyed += 1;
      }
    }
    return destroyed;
  }

  /** Deletes expired sessions on a timer. Returns a stop function. */
  startSweeper(intervalMs = 60_000): () => void {
    const timer = setInterval(() => {
      void this.purgeExpired();
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private require(id: string): IdCopySession {
    const session = this.sessions.get(id);
    if (!session) throw new IdCopySessionNotFoundError();
    return session;
  }
}

/** Removes ID side scans and merged sheets left by an earlier process. */
export async function purgeIdCopyFiles(scansDir: string): Promise<number> {
  let names: string[];
  try {
    names = await fs.promises.readdir(scansDir);
  } catch {
    return 0;
  }
  const targets = names.filter((name) => ID_FILE_PATTERN.test(name));
  for (const name of targets) await removeFile(scansDir, name);
  return targets.length;
}
