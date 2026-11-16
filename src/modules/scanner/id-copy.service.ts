import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IdRotation, IdSide } from '@/shared/id-card-layout';
import type {
  IdCopyFailureResponse,
  IdCopySheetResponse,
} from '@/shared/id-copy-contract';
import type { PaperSize } from '@/shared/print-configuration';
import { composeIdSheet } from './id-copy-compose';
import { checkIdScan } from './id-copy-scan-checks';
import {
  IdCopySessionNotFoundError,
  type IdCopySession,
  type IdCopySessionStore,
  type IdCopySideRecord,
} from './id-copy-session';

export interface IdCopyServiceDeps {
  scansDir: string;
  sessions: IdCopySessionStore;
  /** Scans the ID region on the glass. Throws when the scan fails. */
  scanIdRegion(): Promise<{ outputPath: string }>;
  describeFailure(error: unknown): { code: string; error: string };
  registerReleaseToken(fileName: string): string;
  invalidateReleaseTokens(fileName: string): void;
  thumbnail(filePath: string): Promise<Uint8Array>;
}

const QUARTER_TURNS = new Set<unknown>([0, 90, 180, 270]);

/** Rotations from a request body. Null when a given value is not a quarter turn. */
export function parseIdRotations(
  raw: unknown,
): Partial<Record<IdSide, IdRotation>> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const parsed: Partial<Record<IdSide, IdRotation>> = {};
  for (const side of ['front', 'back'] as const) {
    const value = source[side];
    if (value === undefined) continue;
    if (!QUARTER_TURNS.has(value)) return null;
    parsed[side] = value as IdRotation;
  }
  return parsed;
}

export class IdCopyService {
  constructor(private readonly deps: IdCopyServiceDeps) {}

  async scanSide(input: {
    sessionId?: string | null;
    side: IdSide;
    paperSize: PaperSize;
  }): Promise<IdCopySheetResponse | IdCopyFailureResponse> {
    const session = input.sessionId
      ? await this.requireSession(input.sessionId)
      : this.deps.sessions.create();

    let scanned: { outputPath: string };
    try {
      scanned = await this.deps.scanIdRegion();
    } catch (error) {
      const failure = this.deps.describeFailure(error);
      return {
        detected: false,
        sessionId: session.id,
        code: failure.code,
        error: failure.error,
      };
    }

    await this.deps.sessions.setSide(
      session.id,
      input.side,
      path.basename(scanned.outputPath),
    );
    const sheet = await this.rebuild(session, input.paperSize);
    const warnings = await checkIdScan(
      {
        scannedSide: input.side,
        frontPath: this.sidePath(session.front),
        backPath: this.sidePath(session.back),
      },
      { thumbnail: this.deps.thumbnail },
    );
    return { ...sheet, warnings };
  }

  async compose(input: {
    sessionId: string;
    paperSize: PaperSize;
    rotations: Partial<Record<IdSide, IdRotation>>;
  }): Promise<IdCopySheetResponse> {
    const session = await this.requireSession(input.sessionId);
    for (const side of ['front', 'back'] as const) {
      const rotation = input.rotations[side];
      if (rotation !== undefined) {
        this.deps.sessions.setRotation(session.id, side, rotation);
      }
    }
    return this.rebuild(session, input.paperSize);
  }

  /** Frees a whole ID session. Null when the token is not an ID session's. */
  async releaseByToken(token: string): Promise<{ fileName: string } | null> {
    const session = this.deps.sessions.findByReleaseToken(token);
    if (!session) return null;
    const merged = session.mergedFileName;
    await this.deps.sessions.destroy(session.id);
    if (merged) this.deps.invalidateReleaseTokens(merged);
    return { fileName: merged ?? '' };
  }

  private async requireSession(sessionId: string): Promise<IdCopySession> {
    const session = await this.deps.sessions.get(sessionId);
    if (!session) throw new IdCopySessionNotFoundError();
    return session;
  }

  private sidePath(record: IdCopySideRecord | null): string | null {
    return record ? path.join(this.deps.scansDir, record.fileName) : null;
  }

  private async rebuild(
    session: IdCopySession,
    paperSize: PaperSize,
  ): Promise<IdCopySheetResponse> {
    const side = (record: IdCopySideRecord | null) =>
      record
        ? {
            filePath: path.join(this.deps.scansDir, record.fileName),
            rotationDeg: record.rotationDeg,
          }
        : null;
    const bytes = await composeIdSheet({
      paperSize,
      front: side(session.front),
      back: side(session.back),
    });
    const fileName = `id-copy-${randomUUID()}.pdf`;
    await fs.promises.writeFile(path.join(this.deps.scansDir, fileName), bytes);
    const releaseToken = this.deps.registerReleaseToken(fileName);
    const previous = await this.deps.sessions.setMerged(
      session.id,
      fileName,
      releaseToken,
    );
    if (previous) this.deps.invalidateReleaseTokens(previous);
    return {
      detected: true,
      sessionId: session.id,
      sides: { front: Boolean(session.front), back: Boolean(session.back) },
      complete: Boolean(session.front && session.back),
      previewPath: fileName,
      releaseToken,
      warnings: [],
    };
  }
}
