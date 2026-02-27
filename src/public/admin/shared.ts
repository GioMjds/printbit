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
  };
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
  };
};

export type SettingsResponse = {
  pricing: {
    printPerPage: number;
    copyPerPage: number;
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

const PIN_KEY = "printbit.adminPin";

export function getAdminPin(): string {
  return sessionStorage.getItem(PIN_KEY) ?? "";
}

export function setAdminPin(pin: string): void {
  sessionStorage.setItem(PIN_KEY, pin);
}

export function clearAdminPin(): void {
  sessionStorage.removeItem(PIN_KEY);
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

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("x-admin-pin", getAdminPin());
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(path, { ...init, headers });
}

// ── Auth helpers ─────────────────────────────────────────────────

export async function ensureAuth(): Promise<boolean> {
  const pin = getAdminPin();
  if (!pin) return false;

  const response = await fetch("/api/admin/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });

  return response.ok;
}

let messageEl: HTMLElement | null = null;

export function setMessage(text: string): void {
  if (!messageEl) messageEl = document.getElementById("adminMessage");
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
  const authView = document.getElementById("adminAuthView") as HTMLElement;
  const dashboard = document.getElementById("adminDashboard") as HTMLElement;
  const authForm = document.getElementById("adminAuthForm") as HTMLFormElement;
  const pinInput = document.getElementById("adminPinInput") as HTMLInputElement;
  const logoutBtn = document.getElementById("logoutBtn") as HTMLButtonElement;

  function showDashboard(visible: boolean): void {
    authView.classList.toggle("hidden", visible);
    dashboard.classList.toggle("hidden", !visible);
  }

  async function unlock(pin: string): Promise<void> {
    setAdminPin(pin);
    const ok = await ensureAuth();
    if (!ok) throw new Error("Invalid admin PIN.");

    showDashboard(true);
    await onSuccess();
  }

  authForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const pin = pinInput.value.trim();
    if (!pin) {
      setMessage("Please enter admin PIN.");
      return;
    }
    setMessage("Unlocking admin panel...");
    void unlock(pin)
      .then(() => setMessage("Admin panel unlocked."))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to unlock admin panel.";
        setMessage(msg);
        showDashboard(false);
      });
  });

  logoutBtn.addEventListener("click", () => {
    clearAdminPin();
    showDashboard(false);
    setMessage("Admin panel locked.");
  });

  // Auto-unlock from stored PIN
  const storedPin = getAdminPin();
  if (storedPin) {
    void unlock(storedPin)
      .then(() => setMessage("Admin panel unlocked."))
      .catch(() => {
        clearAdminPin();
        showDashboard(false);
      });
  } else {
    showDashboard(false);
  }

  // Return no-op cleanup (pages manage their own timers)
  return () => {};
}
