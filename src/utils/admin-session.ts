import { randomUUID } from 'node:crypto';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface AdminSession {
  token: string;
  lastActivityAt: number;
}

let activeSession: AdminSession | null = null;

export function createAdminSession(): string {
  const token = randomUUID();
  activeSession = { token, lastActivityAt: Date.now() };
  return token;
}

export function validateAdminSession(token: string): boolean {
  if (!activeSession || activeSession.token !== token) return false;

  const elapsed = Date.now() - activeSession.lastActivityAt;
  if (elapsed > SESSION_TTL_MS) {
    activeSession = null;
    return false;
  }

  activeSession.lastActivityAt = Date.now();
  return true;
}

export function destroyAdminSession(): void {
  activeSession = null;
}
