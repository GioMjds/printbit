/**
 * Hopper serial protocol contract between Node.js and Arduino Uno.
 *
 * All communication uses newline-delimited, space-separated tokens over a
 * shared 9600-baud serial line. Lines that start with "HOPPER" belong to the
 * hopper subsystem; all other lines are handled by the coin-acceptor parser.
 *
 * ── Commands (Node → Arduino) ────────────────────────────────────────────────
 *   HOPPER DISPENSE <requestId> <coinCount>
 *   HOPPER SELFTEST <requestId>
 *
 * ── Responses (Arduino → Node) ───────────────────────────────────────────────
 *   HOPPER ACK <requestId>
 *   HOPPER PROGRESS <requestId> <dispensed> <total>
 *   HOPPER DONE <requestId> <dispensedCount>
 *   HOPPER ERR <requestId> <errorCode> [<detail …>]
 *
 * Request IDs are short hex strings (4 chars) to stay within Arduino memory
 * constraints. They correlate a response back to its originating command so
 * unsolicited or stale lines can be safely discarded.
 */

// ── Protocol prefix ──────────────────────────────────────────────────────────

export const HOPPER_PREFIX = 'HOPPER';

// ── Command verbs ────────────────────────────────────────────────────────────

export const HopperCommand = {
  DISPENSE: 'DISPENSE',
  SELFTEST: 'SELFTEST',
} as const;

export type HopperCommandVerb =
  (typeof HopperCommand)[keyof typeof HopperCommand];

// ── Response types ───────────────────────────────────────────────────────────

export const HopperResponseKind = {
  ACK: 'ACK',
  PROGRESS: 'PROGRESS',
  DONE: 'DONE',
  ERR: 'ERR',
} as const;

export type HopperResponseKindValue =
  (typeof HopperResponseKind)[keyof typeof HopperResponseKind];

// ── Error codes ──────────────────────────────────────────────────────────────

export const HopperErrorCode = {
  /** Coin hopper mechanism is jammed */
  JAM: 'JAM',
  /** Hopper coin reservoir is empty */
  EMPTY: 'EMPTY',
  /** Motor did not complete within expected time */
  MOTOR_TIMEOUT: 'MOTOR_TIMEOUT',
  /** Only some coins were dispensed before failure */
  PARTIAL: 'PARTIAL',
  /** Optical/mechanical sensor fault */
  SENSOR: 'SENSOR',
  /** Catch-all for unrecognised errors */
  UNKNOWN: 'UNKNOWN',
} as const;

export type HopperErrorCodeValue =
  (typeof HopperErrorCode)[keyof typeof HopperErrorCode];

// ── Parsed response types ────────────────────────────────────────────────────

export interface HopperAckResponse {
  kind: 'ACK';
  requestId: string;
}

export interface HopperProgressResponse {
  kind: 'PROGRESS';
  requestId: string;
  dispensed: number;
  total: number;
}

export interface HopperDoneResponse {
  kind: 'DONE';
  requestId: string;
  dispensedCount: number;
}

export interface HopperErrorResponse {
  kind: 'ERR';
  requestId: string;
  code: HopperErrorCodeValue;
  detail: string;
}

export type HopperResponse =
  | HopperAckResponse
  | HopperProgressResponse
  | HopperDoneResponse
  | HopperErrorResponse;

// ── Retryable error codes ────────────────────────────────────────────────────
// Hopper failures where a subsequent attempt may succeed (e.g. a transient jam
// that clears itself, or a motor that was momentarily stalled).

const RETRYABLE_CODES = new Set<HopperErrorCodeValue>([
  HopperErrorCode.JAM,
  HopperErrorCode.MOTOR_TIMEOUT,
  HopperErrorCode.PARTIAL,
]);

export function isRetryableError(code: HopperErrorCodeValue): boolean {
  return RETRYABLE_CODES.has(code);
}

// ── Request-ID generation ────────────────────────────────────────────────────
// 4-char lowercase hex — 65 536 unique IDs, cheap on Arduino memory.
//
// Compatibility note:
// Some legacy firmware still uses Serial.parseInt() and will consume the first
// numeric sequence from the line. Keeping request IDs alpha-only ensures that
// if a structured command is sent to such firmware, parseInt reads the final
// coin-count token rather than digits from the request ID.

const REQUEST_ID_ALPHABET = 'abcdef';

export function generateRequestId(): string {
  let id = '';
  for (let i = 0; i < 4; i += 1) {
    const idx = Math.floor(Math.random() * REQUEST_ID_ALPHABET.length);
    id += REQUEST_ID_ALPHABET[idx];
  }
  return id;
}

// ── Command builders ─────────────────────────────────────────────────────────

export function buildDispenseCommand(
  requestId: string,
  coinCount: number,
): string {
  const count = Math.max(0, Math.floor(coinCount));
  return `${HOPPER_PREFIX} ${HopperCommand.DISPENSE} ${requestId} ${count}`;
}

export function buildSelfTestCommand(requestId: string): string {
  return `${HOPPER_PREFIX} ${HopperCommand.SELFTEST} ${requestId}`;
}

// ── Response parser ──────────────────────────────────────────────────────────
// Parses a raw newline-stripped serial line into a typed response, or returns
// `null` when the line is not a valid hopper protocol message.

function normalizeErrorCode(raw: string): HopperErrorCodeValue {
  const upper = raw.toUpperCase();
  for (const code of Object.values(HopperErrorCode)) {
    if (upper === code) return code;
  }
  return HopperErrorCode.UNKNOWN;
}

export function parseHopperResponse(rawLine: string): HopperResponse | null {
  const line = rawLine.trim();
  if (!line) return null;

  const tokens = line.split(/\s+/);
  if (tokens.length < 2) return null;

  // First token must be the protocol prefix (case-insensitive)
  if (tokens[0].toUpperCase() !== HOPPER_PREFIX) return null;

  const verb = tokens[1].toUpperCase();
  const requestId = tokens[2] ?? '';

  if (!requestId) return null;

  switch (verb) {
    case HopperResponseKind.ACK:
      return { kind: 'ACK', requestId };

    case HopperResponseKind.PROGRESS: {
      const dispensed = parseInt(tokens[3] ?? '', 10);
      const total = parseInt(tokens[4] ?? '', 10);
      if (!Number.isFinite(dispensed) || !Number.isFinite(total)) return null;
      return { kind: 'PROGRESS', requestId, dispensed, total };
    }

    case HopperResponseKind.DONE: {
      const dispensedCount = parseInt(tokens[3] ?? '', 10);
      if (!Number.isFinite(dispensedCount)) return null;
      return { kind: 'DONE', requestId, dispensedCount };
    }

    case HopperResponseKind.ERR: {
      const code = normalizeErrorCode(tokens[3] ?? 'UNKNOWN');
      const detail = tokens.slice(4).join(' ') || code;
      return { kind: 'ERR', requestId, code, detail };
    }

    default:
      return null;
  }
}

// ── Legacy response detection ────────────────────────────────────────────────
// During firmware transition the Arduino may still respond with the old format
// ("HOPPER OK", "HOPPER ERROR …"). This helper classifies such lines so the
// serial layer can fall back gracefully.

export interface LegacyHopperResponse {
  ok: boolean;
  message: string;
}

export function parseLegacyHopperResponse(
  rawLine: string,
): LegacyHopperResponse | null {
  const line = rawLine.trim();
  if (!line) return null;

  const upper = line.toUpperCase();
  if (!upper.includes(HOPPER_PREFIX)) return null;

  // Already structured protocol — let the primary parser handle it
  const tokens = upper.split(/\s+/);
  if (
    tokens.length >= 3 &&
    tokens[0] === HOPPER_PREFIX &&
    (tokens[1] === 'ACK' ||
      tokens[1] === 'PROGRESS' ||
      tokens[1] === 'DONE' ||
      tokens[1] === 'ERR')
  ) {
    return null;
  }

  // Legacy: match loose keywords
  if (
    upper.includes('ERR') ||
    upper.includes('FAIL') ||
    upper.includes('ERROR')
  ) {
    return { ok: false, message: line };
  }

  if (
    upper.includes('OK') ||
    upper.includes('DONE') ||
    upper.includes('SUCCESS')
  ) {
    return { ok: true, message: line };
  }

  // Line mentions HOPPER but has no recognisable outcome — treat as noise
  return null;
}

// ── Change computation ───────────────────────────────────────────────────────
// The hopper dispenses **1-peso coins only** and there is no centavo hardware.
// This helper converts a peso change amount into an integer coin count and
// flags whether the amount was whole (expected) or fractional (indicates a
// configuration or pricing bug).

export interface ChangeComputation {
  /** Number of 1-peso coins to dispense */
  coins: number;
  /** True when changeAmount is an exact whole-peso value */
  isWholeAmount: boolean;
  /** The effective change that will actually be dispensed (coins × 1) */
  effectiveChange: number;
  /** Any fractional remainder that cannot be dispensed (should be 0 in normal operation) */
  remainder: number;
}

export function computeDispenseCoins(changeAmount: number): ChangeComputation {
  if (!Number.isFinite(changeAmount) || changeAmount <= 0) {
    return { coins: 0, isWholeAmount: true, effectiveChange: 0, remainder: 0 };
  }

  const coins = Math.floor(changeAmount);
  const remainder = Number((changeAmount - coins).toFixed(2));

  return {
    coins,
    isWholeAmount: remainder === 0,
    effectiveChange: coins,
    remainder,
  };
}
