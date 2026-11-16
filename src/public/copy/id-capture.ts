/**
 * Calls the ID copy endpoints and turns every outcome into one result value.
 * The fetch is injected so each outcome is testable without a browser.
 */
import type { IdRotation, IdSide } from '../../shared/id-card-layout';
import {
  ID_SESSION_EXPIRED_CODE,
  type IdCopySheetResponse,
  type IdScanWarning,
} from '../../shared/id-copy-contract';
import type { PaperSize } from '../../shared/print-configuration';

export type FetchWithTimeout = (
  input: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
) => Promise<Response>;

export type IdCaptureResult =
  | { kind: 'sheet'; sheet: IdCopySheetResponse }
  | {
      kind: 'scan-failed';
      sessionId: string | null;
      code: string;
      error: string;
    }
  | { kind: 'expired'; error: string }
  | { kind: 'error'; code: string; error: string };

export interface IdCaptureClient {
  scanSide(input: {
    sessionId: string | null;
    side: IdSide;
    paperSize: PaperSize;
  }): Promise<IdCaptureResult>;
  compose(input: {
    sessionId: string;
    paperSize: PaperSize;
    rotations: Record<IdSide, IdRotation>;
  }): Promise<IdCaptureResult>;
}

const SCAN_FAILED_MESSAGE =
  'Could not complete scanner check. Please try again.';
const OFFLINE_MESSAGE = 'Could not reach the scanner. Please try again.';
const EXPIRED_MESSAGE =
  'Your ID scan session expired. Please scan your ID again.';
const WARNING_CODES = new Set<unknown>(['side_blank', 'sides_identical']);
const SIDES = new Set<unknown>(['front', 'back']);

function text(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readWarnings(value: unknown): IdScanWarning[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is IdScanWarning => {
    if (typeof item !== 'object' || item === null) return false;
    const record = item as Record<string, unknown>;
    return WARNING_CODES.has(record.code) && SIDES.has(record.side);
  });
}

function readResult(
  status: number,
  ok: boolean,
  payload: Record<string, unknown>,
): IdCaptureResult {
  if (status === 409 && payload.code === ID_SESSION_EXPIRED_CODE) {
    return {
      kind: 'expired',
      error: text(payload, 'error') ?? EXPIRED_MESSAGE,
    };
  }
  if (!ok) {
    return {
      kind: 'error',
      code: text(payload, 'code') ?? 'SCAN_FAILED',
      error:
        text(payload, 'error') ??
        text(payload, 'message') ??
        SCAN_FAILED_MESSAGE,
    };
  }

  const sessionId = text(payload, 'sessionId');
  const previewPath = text(payload, 'previewPath');
  const releaseToken = text(payload, 'releaseToken');
  if (payload.detected === true && sessionId && previewPath && releaseToken) {
    const sides = (payload.sides ?? {}) as Record<string, unknown>;
    return {
      kind: 'sheet',
      sheet: {
        detected: true,
        sessionId,
        sides: { front: sides.front === true, back: sides.back === true },
        complete: payload.complete === true,
        previewPath,
        releaseToken,
        warnings: readWarnings(payload.warnings),
      },
    };
  }

  return {
    kind: 'scan-failed',
    sessionId,
    code: text(payload, 'code') ?? 'SCAN_FAILED',
    error: text(payload, 'error') ?? SCAN_FAILED_MESSAGE,
  };
}

export function createIdCaptureClient(deps: {
  fetch: FetchWithTimeout;
  timeoutMs: number;
}): IdCaptureClient {
  async function post(
    url: string,
    body: unknown,
    label: string,
  ): Promise<IdCaptureResult> {
    let response: Response;
    try {
      response = await deps.fetch(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        deps.timeoutMs,
        label,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('timed out')) {
        return { kind: 'error', code: 'SCANNER_TIMEOUT', error: error.message };
      }
      return { kind: 'error', code: 'SCANNER_OFFLINE', error: OFFLINE_MESSAGE };
    }

    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (typeof parsed === 'object' && parsed !== null) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON: the status alone decides the result.
    }
    return readResult(response.status, response.ok, payload);
  }

  return {
    scanSide: (input) =>
      post(
        '/api/scan/id-copy/side',
        {
          sessionId: input.sessionId,
          side: input.side,
          paperSize: input.paperSize,
        },
        input.side === 'front' ? 'Front scan' : 'Back scan',
      ),
    compose: (input) =>
      post(
        '/api/scan/id-copy/compose',
        {
          sessionId: input.sessionId,
          paperSize: input.paperSize,
          rotations: input.rotations,
        },
        'ID sheet',
      ),
  };
}
