/**
 * Per-IP limit on phone uploads. Must stay well above the per-session file cap
 * (10): failed uploads can be retried, and several phones may share one IP
 * behind the Cloudflare tunnel.
 */
export const WIRELESS_UPLOAD_RATE_LIMIT = {
  windowMs: 60_000,
  max: 30,
} as const;
