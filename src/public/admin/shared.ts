export type SummaryResponse = {
  balance: number;
  earnings: {
    today: number;
    week: number;
    allTime: number;
  };
  coinStats: {
    one: number;
    five: number;
    ten: number;
    twenty: number;
  };
  jobStats: {
    total: number;
    print: number;
    copy: number;
    scan: number;
  };
  hopperStats: {
    dispenseAttempts: number;
    dispenseSuccess: number;
    dispenseFailures: number;
    totalDispensed: number;
    lastDispensedAt: string | null;
    lastError: string | null;
    selfTestPassed: boolean | null;
    lastSelfTestAt: string | null;
  };
  owedChangeOpenCount: number;
  storage: {
    fileCount: number;
    bytes: number;
  };
  status: {
    serverRunning: boolean;
    uptimeSeconds: number;
    host: string;
    wifiActive: boolean;
    serial: {
      connected: boolean;
      portPath: string | null;
      lastError: string | null;
    };
    hopper: {
      connected: boolean;
      pending: boolean;
      portPath: string | null;
      lastError: string | null;
      lastSuccessAt: string | null;
    };
    printer: {
      connected: boolean;
      name: string | null;
      driverName: string | null;
      portName: string | null;
      status: string;
      ink: Array<{
        name: string;
        level: number | null;
        status: 'ok' | 'low' | 'empty' | 'unknown';
      }>;
      lastCheckedAt: string;
      lastError: string | null;
    };
  };
};

export type SettingsResponse = {
  pricing: {
    printPerPage: number;
    copyPerPage: number;
    scanDocument: number;
    colorSurcharge: number;
  };
  idleTimeoutSeconds: number;
  adminPin: string;
  adminLocalOnly: boolean;
};

export type LogsResponse = {
  logs: Array<{
    id: string;
    timestamp: string;
    type: string;
    message: string;
  }>;
};

// ── PIN state via sessionStorage ─────────────────────────────────

const PIN_KEY = 'printbit.adminPin';
const TOKEN_KEY = 'adminSessionToken';

export function getAdminPin(): string {
  return sessionStorage.getItem(PIN_KEY) ?? '';
}

export function setAdminPin(pin: string): void {
  sessionStorage.setItem(PIN_KEY, pin);
}

export function clearAdminPin(): void {
  sessionStorage.removeItem(PIN_KEY);
}

export function getAdminToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

export function setAdminToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

// ── Utilities ────────────────────────────────────────────────────

export function peso(value: number): string {
  return `₱ ${value.toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  const token = getAdminToken();
  if (token) headers.set('x-admin-token', token);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(path, { ...init, headers });
}

// ── Auth helpers ─────────────────────────────────────────────────

export async function ensureAuth(): Promise<boolean> {
  const token = getAdminToken();
  if (!token) return false;

  const response = await fetch('/api/admin/verify', {
    method: 'POST',
  });

  return response.ok;
}

let messageEl: HTMLElement | null = null;

export function setMessage(text: string): void {
  if (!messageEl) messageEl = document.getElementById('adminMessage');
  if (messageEl) messageEl.textContent = text;
}

/**
 * Initialises the auth gate UI. Call once from each admin sub-page.
 *
 * @param onSuccess – called after a successful unlock; the page should
 *                    start loading its own data inside this callback.
 * @returns a cleanup function that stops the auto-refresh timer.
 */
export function initAuth(onSuccess: () => void | Promise<void>): () => void {
  const authView = document.getElementById('adminAuthView') as HTMLElement;
  const dashboard = document.getElementById('adminDashboard') as HTMLElement;
  const authForm = document.getElementById('adminAuthForm') as HTMLFormElement;
  const pinInput = document.getElementById('adminPinInput') as HTMLInputElement;
  const logoutBtn = document.getElementById('logoutBtn') as HTMLButtonElement;

  function showDashboard(visible: boolean): void {
    authView.classList.toggle('hidden', visible);
    dashboard.classList.toggle('hidden', !visible);
  }

  async function unlock(pin: string): Promise<void> {
    const response = await fetch('/api/admin/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (!response.ok) {
      let errorMessage = 'Invalid admin PIN.';
      try {
        const errorBody = (await response.json()) as unknown;
        if (
          errorBody &&
          typeof errorBody === 'object' &&
          'error' in errorBody &&
          typeof (errorBody as { error: unknown }).error === 'string' &&
          (errorBody as { error: string }).error.trim()
        ) {
          errorMessage = (errorBody as { error: string }).error;
        }
      } catch {
        // Ignore JSON parse errors and fall back to default message
      }
      throw new Error(errorMessage);
    }

    const data = (await response.json()) as {
      ok: boolean;
      sessionToken?: string;
    };
    if (data.sessionToken) setAdminToken(data.sessionToken);

    showDashboard(true);
    await onSuccess();
  }

  authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pin = pinInput.value.trim();
    if (!pin) {
      setMessage('Please enter admin PIN.');
      return;
    }
    setMessage('Unlocking admin panel...');
    void unlock(pin)
      .then(() => setMessage('Admin panel unlocked.'))
      .catch((err: unknown) => {
        const msg =
          err instanceof Error ? err.message : 'Failed to unlock admin panel.';
        setMessage(msg);
        showDashboard(false);
      });
  });

  logoutBtn.addEventListener('click', () => {
    const token = getAdminToken();
    void fetch('/api/admin/logout', {
      method: 'POST',
      headers: { 'x-admin-token': token },
      credentials: 'include',
    }).finally(() => {
      clearAdminToken();
      showDashboard(false);
      setMessage('Admin panel locked.');
    });
  });

  // Initialize in locked state; rely on server-side session/token for auth
  showDashboard(false);

  // Return no-op cleanup (pages manage their own timers)
  return () => {};
}
