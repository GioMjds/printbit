export type SocketPrincipal =
  | { kind: 'kiosk' }
  | { kind: 'admin' }
  | { kind: 'session'; sessionId: string };

export interface SocketHandshakeInput {
  address?: string;
  auth: unknown;
  headers: { cookie?: string | string[] | undefined };
}

export interface SocketAccessDeps {
  isKioskCredential: (credential: string) => boolean;
  isLoopbackAddress?: (address?: string) => boolean;
  isAdminSession: (sessionToken: string) => boolean;
  claimSessionOwner: (
    sessionId: string,
    token: string,
    clientId: string,
  ) => boolean;
}

export interface SocketAccessMiddlewareSocket {
  handshake: SocketHandshakeInput;
  data: Record<string, unknown>;
}

export interface SocketAccessNamespace {
  use: (
    middleware: (
      socket: SocketAccessMiddlewareSocket,
      next: (error?: Error) => void,
    ) => void,
  ) => unknown;
}

const MAX_SESSION_ID_LENGTH = 128;
const MAX_TOKEN_LENGTH = 512;
const MAX_CLIENT_ID_LENGTH = 128;

function getSafeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > maxLength) return null;
  if (value.trim() !== value) return null;
  return value;
}

function getPlainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
}

function parseCookies(header: string | string[] | undefined): Record<string, string> {
  if (typeof header !== 'string') return {};

  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) continue;
    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (!name || !value) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // Ignore malformed cookies; they are not valid credentials.
    }
  }
  return cookies;
}

export function authenticateControlSocket(
  handshake: SocketHandshakeInput,
  deps: SocketAccessDeps,
): SocketPrincipal | null {
  if (
    handshake.address &&
    deps.isLoopbackAddress &&
    deps.isLoopbackAddress(handshake.address)
  ) {
    return { kind: 'kiosk' };
  }

  const cookies = parseCookies(handshake.headers.cookie);
  const kioskCredential = getSafeString(cookies.printbit_kiosk, MAX_TOKEN_LENGTH);
  if (kioskCredential && deps.isKioskCredential(kioskCredential)) {
    return { kind: 'kiosk' };
  }

  const auth = getPlainRecord(handshake.auth);
  const authToken = auth
    ? getSafeString(auth.token ?? auth.adminToken, MAX_TOKEN_LENGTH)
    : null;
  const adminToken =
    getSafeString(cookies.adminToken, MAX_TOKEN_LENGTH) || authToken;
  if (adminToken && deps.isAdminSession(adminToken)) {
    return { kind: 'admin' };
  }

  return null;
}

export function authenticateSessionSocket(
  handshake: SocketHandshakeInput,
  deps: SocketAccessDeps,
): SocketPrincipal | null {
  const auth = getPlainRecord(handshake.auth);
  if (!auth) return null;

  const sessionId = getSafeString(auth.sessionId, MAX_SESSION_ID_LENGTH);
  const token = getSafeString(auth.token, MAX_TOKEN_LENGTH);
  const clientId = getSafeString(auth.clientId, MAX_CLIENT_ID_LENGTH);
  if (!sessionId || !token || !clientId) return null;

  if (!deps.claimSessionOwner(sessionId, token, clientId)) return null;
  return { kind: 'session', sessionId };
}

export function canJoinSessionRoom(
  principal: SocketPrincipal | null,
  sessionId: string,
): boolean {
  if (!principal || !getSafeString(sessionId, MAX_SESSION_ID_LENGTH)) {
    return false;
  }
  return principal.kind !== 'session' || principal.sessionId === sessionId;
}

export function canControlCoinSlot(principal: SocketPrincipal | null): boolean {
  return principal?.kind === 'kiosk' || principal?.kind === 'admin';
}

export function installSocketAccessMiddleware(
  controlNamespace: SocketAccessNamespace,
  sessionNamespace: SocketAccessNamespace,
  deps: SocketAccessDeps,
): void {
  controlNamespace.use((socket, next) => {
    const principal = authenticateControlSocket(socket.handshake, deps);
    if (!principal) {
      next(new Error('Socket authentication required.'));
      return;
    }
    socket.data.principal = principal;
    next();
  });

  sessionNamespace.use((socket, next) => {
    const principal = authenticateSessionSocket(socket.handshake, deps);
    if (!principal) {
      next(new Error('Session authentication required.'));
      return;
    }
    socket.data.principal = principal;
    next();
  });
}
