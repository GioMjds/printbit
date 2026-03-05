import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";

export type PrintMode = "print" | "copy";
export type ColorMode = "colored" | "grayscale";

export interface PricingSettings {
  printPerPage: number;
  copyPerPage: number;
  colorSurcharge: number;
}

export interface AdminSettings {
  pricing: PricingSettings;
  idleTimeoutSeconds: number;
  adminPin: string;
  adminLocalOnly: boolean;
}

export interface CoinStats {
  one: number;
  five: number;
  ten: number;
  twenty: number;
}

export interface JobStats {
  total: number;
  print: number;
  copy: number;
}

export type LogMeta = Record<string, string | number | boolean | null>;

export interface AdminLogEntry {
  id: string;
  timestamp: string;
  type: string;
  message: string;
  meta?: LogMeta;
}

export type Schema = {
  balance: number;
  earnings: number;
  settings: AdminSettings;
  coinStats: CoinStats;
  jobStats: JobStats;
  logs: AdminLogEntry[];
};

const DEFAULT_DATA: Schema = {
  balance: 0,
  earnings: 0,
  settings: {
    pricing: {
      printPerPage: 5,
      copyPerPage: 3,
      colorSurcharge: 2,
    },
    idleTimeoutSeconds: 120,
    adminPin: "1234",
    adminLocalOnly: true,
  },
  coinStats: {
    one: 0,
    five: 0,
    ten: 0,
    twenty: 0,
  },
  jobStats: {
    total: 0,
    print: 0,
    copy: 0,
  },
  logs: [],
};

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeSchema(data: Partial<Schema> | undefined): Schema {
  const pricing = data?.settings?.pricing;

  return {
    balance: finiteOr(data?.balance, DEFAULT_DATA.balance),
    earnings: finiteOr(data?.earnings, DEFAULT_DATA.earnings),
    settings: {
      pricing: {
        printPerPage: finiteOr(
          pricing?.printPerPage,
          DEFAULT_DATA.settings.pricing.printPerPage,
        ),
        copyPerPage: finiteOr(
          pricing?.copyPerPage,
          DEFAULT_DATA.settings.pricing.copyPerPage,
        ),
        colorSurcharge: finiteOr(
          pricing?.colorSurcharge,
          DEFAULT_DATA.settings.pricing.colorSurcharge,
        ),
      },
      idleTimeoutSeconds: finiteOr(
        data?.settings?.idleTimeoutSeconds,
        DEFAULT_DATA.settings.idleTimeoutSeconds,
      ),
      adminPin:
        typeof data?.settings?.adminPin === "string" &&
        data.settings.adminPin.trim()
          ? data.settings.adminPin
          : DEFAULT_DATA.settings.adminPin,
      adminLocalOnly:
        typeof data?.settings?.adminLocalOnly === "boolean"
          ? data.settings.adminLocalOnly
          : DEFAULT_DATA.settings.adminLocalOnly,
    },
    coinStats: {
      one: finiteOr(data?.coinStats?.one, DEFAULT_DATA.coinStats.one),
      five: finiteOr(data?.coinStats?.five, DEFAULT_DATA.coinStats.five),
      ten: finiteOr(data?.coinStats?.ten, DEFAULT_DATA.coinStats.ten),
      twenty: finiteOr(data?.coinStats?.twenty, DEFAULT_DATA.coinStats.twenty),
    },
    jobStats: {
      total: finiteOr(data?.jobStats?.total, DEFAULT_DATA.jobStats.total),
      print: finiteOr(data?.jobStats?.print, DEFAULT_DATA.jobStats.print),
      copy: finiteOr(data?.jobStats?.copy, DEFAULT_DATA.jobStats.copy),
    },
    logs: Array.isArray(data?.logs) ? data.logs : DEFAULT_DATA.logs,
  };
}

const adapter = new JSONFile<Schema>("db.json");
export const db = new Low(adapter, DEFAULT_DATA);

export async function initDB() {
  try {
    await db.read();
  } catch (err) {
    // If the file is empty or malformed, initialize with defaults
    db.data = { ...DEFAULT_DATA };
    await db.write();
    return;
  }

  db.data = normalizeSchema(db.data);
  await db.write();
}

// ── Balance mutex ─────────────────────────────────────────────────────────────
// Serialises balance/earnings mutations in the payment endpoints
// (/api/confirm-payment and /api/copy/jobs) to prevent interleaving at async
// boundaries. Other balance mutations (serial coin events, admin/test routes)
// do not currently hold this lock; those paths run at low concurrency and are
// therefore unlikely to interleave in practice.

let balanceLockPromise = Promise.resolve();

export async function withBalanceLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = balanceLockPromise;
  let release: () => void;
  balanceLockPromise = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
}

// ── Idempotency key store ────────────────────────────────────────────────────
// Prevents double-charge from retry/double-click on payment endpoints.
// Keys are namespaced by "METHOD:route" to avoid cross-endpoint collisions.
// An "in-flight" sentinel is reserved synchronously before any async work so
// that concurrent requests with the same key receive 409 instead of racing.

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface IdempotencyEntry {
  response: unknown;
  statusCode: number;
  expiresAt: number;
  inFlight: boolean;
}

const idempotencyStore = new Map<string, IdempotencyEntry>();

export function checkIdempotencyKey(
  key: string,
  namespace: string,
): IdempotencyEntry | null {
  const namespacedKey = `${namespace}:${key}`;
  const entry = idempotencyStore.get(namespacedKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    idempotencyStore.delete(namespacedKey);
    return null;
  }
  return entry;
}

/** Reserve an in-flight slot synchronously before any await. */
export function markIdempotencyKeyInFlight(
  key: string,
  namespace: string,
): void {
  const namespacedKey = `${namespace}:${key}`;
  idempotencyStore.set(namespacedKey, {
    response: null,
    statusCode: 0,
    expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    inFlight: true,
  });
}

export function storeIdempotencyKey(
  key: string,
  namespace: string,
  statusCode: number,
  response: unknown,
): void {
  const namespacedKey = `${namespace}:${key}`;
  idempotencyStore.set(namespacedKey, {
    response,
    statusCode,
    expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    inFlight: false,
  });
}

// Periodic cleanup of expired idempotency keys
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of idempotencyStore) {
    if (now > entry.expiresAt) idempotencyStore.delete(key);
  }
}, IDEMPOTENCY_TTL_MS);
