import { db } from '@/services/db';

const MAX_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 10 * 60 * 1000; // 10 minutes

export function checkLockout(): { locked: boolean; remainingMs?: number } {
  const { lockedUntil } = db.data!.adminLockout;
  if (!lockedUntil) return { locked: false };

  const expiry = new Date(lockedUntil).getTime();
  const now = Date.now();

  if (now < expiry) {
    return { locked: true, remainingMs: expiry - now };
  }

  // Lock expired — auto-clear
  db.data!.adminLockout.failedAttempts = 0;
  db.data!.adminLockout.lockedUntil = null;
  return { locked: false };
}

export async function recordFailedAttempt(): Promise<number> {
  db.data!.adminLockout.failedAttempts += 1;
  const attempts = db.data!.adminLockout.failedAttempts;

  if (attempts >= MAX_ATTEMPTS) {
    db.data!.adminLockout.lockedUntil = new Date(
      Date.now() + LOCKOUT_DURATION_MS,
    ).toISOString();
  }

  await db.write();
  return attempts;
}

export async function clearLockout(): Promise<void> {
  db.data!.adminLockout.failedAttempts = 0;
  db.data!.adminLockout.lockedUntil = null;
  await db.write();
}

export function formatRemainingTime(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
}