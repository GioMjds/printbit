import { randomUUID } from 'node:crypto';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 100;

interface AdminSession {
  token: string;
  lastActivityAt: number;
}

const activeSessions = new Map<string, AdminSession>();

function pruneExpiredSessions(now: number): void {
  for (const [token, session] of activeSessions.entries()) {
    if (now - session.lastActivityAt > SESSION_TTL_MS) {
      activeSessions.delete(token);
    }
  }
}

export function createAdminSession(): string {
  const now = Date.now();
  pruneExpiredSessions(now);

  if (activeSessions.size >= MAX_SESSIONS) {
    let oldestToken: string | null = null;
    let oldestTime = Infinity;
    for (const [token, session] of activeSessions.entries()) {
      if (session.lastActivityAt < oldestTime) {
        oldestTime = session.lastActivityAt;
        oldestToken = token;
      }
    }
    if (oldestToken) {
      activeSessions.delete(oldestToken);
    }
  }

  const token = randomUUID();
  activeSessions.set(token, { token, lastActivityAt: now });
  return token;
}

export function validateAdminSession(token: string): boolean {
  if (!token) return false;

  const session = activeSessions.get(token);
  if (!session) return false;

  const now = Date.now();
  const elapsed = now - session.lastActivityAt;
  if (elapsed > SESSION_TTL_MS) {
    activeSessions.delete(token);
    return false;
  }

  session.lastActivityAt = now;
  return true;
}

export function destroyAdminSession(token?: string): void {
  if (token) {
    activeSessions.delete(token);
    return;
  }
  activeSessions.clear();
}
