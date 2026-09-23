/**
 * In-memory idempotency key store used to prevent duplicate processing of the
 * same logical request. Keys are namespaced (typically by route or operation)
 * to avoid collisions between different endpoints that may reuse the same
 * client-provided key.
 *
 * Notes:
 * - This is an in-memory convenience implementation intended for single-node
 *   deployments or short-lived processes. For multi-instance setups use a
 *   shared store (Redis, database) implementing the same semantics.
 */

/** 5 minutes - expiry for cached responses */
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

/**
 * Stored idempotency payload: the response body (opaque) and HTTP status
 * that should be replayed to duplicate callers, plus an expiry timestamp.
 */
export interface IdempotencyEntry {
  /** The original response value to replay to later callers. */
  response: unknown;
  /** The HTTP status code that accompanied `response`. */
  statusCode: number;
  /** Epoch ms when this entry becomes stale and may be evicted. */
  expiresAt: number;
}

/**
 * Internal representation for an in-flight claim. A deferred promise is used
 * so concurrent requests that race to the same idempotency key can await the
 * result instead of re-processing the request.
 */
interface InFlightEntry {
  promise: Promise<IdempotencyEntry | null>;
  resolve: (entry: IdempotencyEntry | null) => void;
}

// Primary maps. Keys are produced by `namespacedKey`.
const idempotencyStore = new Map<string, IdempotencyEntry>();
const idempotencyInFlight = new Map<string, InFlightEntry>();

/**
 * Produce a deterministic map key for a given namespace and client-supplied
 * key. A NUL character is used as a separator to avoid accidental
 * ambiguity when composing strings.
 */
function namespacedKey(key: string, namespace: string): string {
  return `${namespace}\x00${key}`;
}

/**
 * Create a deferred promise along with its resolver. This pattern lets one
 * caller perform work and resolve the promise for other waiters.
 */
function makeDeferred(): {
  promise: Promise<IdempotencyEntry | null>;
  resolve: (entry: IdempotencyEntry | null) => void;
} {
  let resolve!: (entry: IdempotencyEntry | null) => void;
  const promise = new Promise<IdempotencyEntry | null>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Try to claim an idempotency key for the given `namespace`.
 *
 * Return values:
 * - `{ type: 'hit', entry }` — a previously completed response exists and is
 *   still fresh. The caller should short-circuit and replay `entry`.
 * - `{ type: 'inflight', promise }` — another request is currently handling
 *   this key; the caller should await `promise`. If the promise resolves to
 *   `null` the original request failed and callers should treat it as a 503.
 * - `{ type: 'claimed' }` — the caller has successfully reserved the slot
 *   and is responsible for performing the work. After completion call
 *   `storeIdempotencyKey` (on success) or `releaseIdempotencyKey` (on failure).
 */
export function acquireIdempotencyKey(
  key: string,
  namespace: string,
):
  | { type: 'hit'; entry: IdempotencyEntry }
  | { type: 'inflight'; promise: Promise<IdempotencyEntry | null> }
  | { type: 'claimed' } {
  const nk = namespacedKey(key, namespace);

  // If a completed entry exists and hasn't expired, return it as a hit.
  const completed = idempotencyStore.get(nk);
  if (completed) {
    if (Date.now() <= completed.expiresAt)
      return { type: 'hit', entry: completed };
    idempotencyStore.delete(nk);
  }

  // If another request is currently processing this key, return its promise
  // so callers can await the final result.
  const inFlight = idempotencyInFlight.get(nk);
  if (inFlight) return { type: 'inflight', promise: inFlight.promise };

  // Reserve the slot for this caller using a deferred promise so concurrent
  // callers will wait instead of duplicating work.
  const deferred = makeDeferred();
  idempotencyInFlight.set(nk, deferred);
  return { type: 'claimed' };
}

/**
 * Finalise a claimed slot by storing the response and resolving any waiters.
 *
 * Call this after successfully producing the response for the original
 * request. Waiting duplicates will receive the stored entry and can replay
 * the response without reprocessing.
 */
export function storeIdempotencyKey(
  key: string,
  namespace: string,
  statusCode: number,
  response: unknown,
): void {
  const nk = namespacedKey(key, namespace);
  const entry: IdempotencyEntry = {
    response,
    statusCode,
    expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
  };
  idempotencyStore.set(nk, entry);
  const inFlight = idempotencyInFlight.get(nk);
  if (inFlight) {
    inFlight.resolve(entry);
    idempotencyInFlight.delete(nk);
  }
}

/**
 * Release a claimed slot without caching a response (e.g. on server error).
 *
 * Waiting duplicates will receive `null` from the deferred promise and
 * should typically translate that into a 503 Service Unavailable response.
 */
export function releaseIdempotencyKey(key: string, namespace: string): void {
  const nk = namespacedKey(key, namespace);
  const inFlight = idempotencyInFlight.get(nk);
  if (inFlight) {
    inFlight.resolve(null);
    idempotencyInFlight.delete(nk);
  }
}

// Periodic cleanup of expired idempotency keys to avoid unbounded memory use.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of idempotencyStore) {
    if (now > entry.expiresAt) idempotencyStore.delete(key);
  }
}, IDEMPOTENCY_TTL_MS);
