# Always-On Admin Portal & Cloud Edge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a Cloudflare Worker at `admin.printbitkiosk.com` with KV storage and wire an outbound telemetry client in the kiosk backend so operators can always inspect machine status and stats even when the physical kiosk is turned off.

**Architecture:** A Cloudflare Worker edge service serves the admin portal and stores kiosk state in Cloudflare KV. The physical kiosk backend gathers local health, earnings, and consumable counts every 30 seconds and posts a signed JSON snapshot to the Worker. When the kiosk powers off, the Worker dynamically computes offline duration and displays last-known stats with live actions safely disabled.

**Tech Stack:** Cloudflare Workers (TypeScript / Wrangler), Cloudflare KV (`PRINTBIT_STATE`), Node.js 22+, Express 5, Jest.

**Spec:** `docs/superpowers/specs/2026-10-31-always-on-admin-cloud-edge-design.md`

## Global Constraints

- `PRINTBIT_CLOUD_SYNC_ENABLED` must default to `false` (opt-in).
- Outbound fetch requests must use strict `AbortSignal.timeout(5000)` to prevent blocking the Node event loop.
- Network errors during sync must be caught gracefully and logged at `warn` level; never crash the server.
- No customer PII, transaction tokens, or uploaded file data in telemetry payloads.
- Cloudflare Worker must strictly authenticate sync requests using `Bearer` token matching `SYNC_SECRET`.

---

### Task 1: Cloudflare Worker Edge Service & Telemetry Store

**Files:**

- Create: `cloud/wrangler.jsonc`
- Create: `cloud/worker.ts`
- Create: `cloud/package.json`
- Create: `cloud/tsconfig.json`

**Interfaces:**

- Produces:
  - `POST /api/telemetry/sync`: Ingests and saves snapshot to KV.
  - `GET /api/kiosk-status`: Returns calculated online status, age, and cached metrics.
  - `GET /*`: Serves the always-on status portal HTML/CSS.

- [ ] **Step 1: Create Cloudflare Worker configuration**

Create `cloud/wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "printbit-admin-edge",
  "main": "worker.ts",
  "compatibility_date": "2026-10-01",
  "kv_namespaces": [
    {
      "binding": "PRINTBIT_STATE",
      "id": "printbit_state_kv",
    },
  ],
  "observability": {
    "enabled": true,
  },
}
```

Create `cloud/package.json`:

```json
{
  "name": "printbit-admin-edge",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241022.0",
    "typescript": "^5.6.3",
    "wrangler": "^3.80.0"
  }
}
```

Create `cloud/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["worker.ts"]
}
```

- [ ] **Step 2: Implement Cloudflare Worker Edge router**

Create `cloud/worker.ts`:

```typescript
export interface Env {
  PRINTBIT_STATE: KVNamespace;
  SYNC_SECRET?: string;
}

export interface KioskTelemetryPayload {
  kioskId: string;
  timestamp: string;
  status: 'healthy' | 'degraded';
  uptimeSec: number;
  hardware: {
    printer: string;
    serial: string;
    worker: string;
    hotspot: string;
  };
  summary: {
    earningsToday: number;
    jobsToday: number;
    owedChange: number;
    inkGrayscale: number;
    inkColor: number;
    issues: string[];
  };
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PrintBit Kiosk Admin Portal</title>
  <style>
    :root {
      --bg: #0f172a; --card: #1e293b; --text: #f8fafc;
      --text-muted: #94a3b8; --green: #10b981; --red: #ef4444;
      --border: #334155;
    }
    body {
      margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg); color: var(--text);
    }
    .container { max-width: 900px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .banner { padding: 16px 20px; border-radius: 8px; margin-bottom: 24px; font-weight: 600; display: flex; align-items: center; gap: 12px; }
    .banner--online { background: rgba(16, 185, 129, 0.15); border: 1px solid var(--green); color: #34d399; }
    .banner--offline { background: rgba(239, 68, 68, 0.15); border: 1px solid var(--red); color: #f87171; }
    .dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
    .banner--online .dot { background: var(--green); box-shadow: 0 0 8px var(--green); }
    .banner--offline .dot { background: var(--red); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
    .card__title { font-size: 0.875rem; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
    .card__value { font-size: 1.75rem; font-weight: 700; }
    .hardware-list { list-style: none; padding: 0; margin: 0; }
    .hardware-list li { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .btn-disabled { opacity: 0.4; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>PrintBit Kiosk Admin</h2>
      <span id="syncTime" style="color: var(--text-muted); font-size: 0.85rem;">Checking status...</span>
    </div>

    <div id="statusBanner" class="banner banner--offline">
      <span class="dot"></span>
      <span id="bannerText">Checking physical machine connection...</span>
    </div>

    <div class="grid">
      <div class="card">
        <div class="card__title">Today's Earnings</div>
        <div class="card__value" id="valEarnings">₱0</div>
      </div>
      <div class="card">
        <div class="card__title">Jobs Completed</div>
        <div class="card__value" id="valJobs">0</div>
      </div>
      <div class="card">
        <div class="card__title">Black Ink Level</div>
        <div class="card__value" id="valBlackInk">--%</div>
      </div>
      <div class="card">
        <div class="card__title">Color Ink Level</div>
        <div class="card__value" id="valColorInk">--%</div>
      </div>
    </div>

    <div class="card">
      <div class="card__title">Subsystem Health (Last Known)</div>
      <ul class="hardware-list" id="hardwareList">
        <li><span>Printer:</span> <span id="hwPrinter">--</span></li>
        <li><span>Coin / Hopper Serial:</span> <span id="hwSerial">--</span></li>
        <li><span>Hardware Worker (.NET):</span> <span id="hwWorker">--</span></li>
        <li><span>ESP32 Upload Hotspot:</span> <span id="hwHotspot">--</span></li>
      </ul>
    </div>
  </div>

  <script>
    async function loadStatus() {
      try {
        const res = await fetch('/api/kiosk-status');
        const json = await res.json();
        const banner = document.getElementById('statusBanner');
        const bannerText = document.getElementById('bannerText');
        const syncTime = document.getElementById('syncTime');

        if (!json.data) {
          bannerText.textContent = "No kiosk telemetry received yet.";
          return;
        }

        const data = json.data;
        const lastSeen = new Date(json.lastSeenAt);

        if (json.isOnline) {
          banner.className = "banner banner--online";
          bannerText.textContent = "Kiosk is OPEN and Operational";
          syncTime.textContent = "Live status (syncing every 30s)";
        } else {
          banner.className = "banner banner--offline";
          bannerText.textContent = "Kiosk is CLOSED / POWERED OFF (Last seen " + lastSeen.toLocaleTimeString() + ")";
          syncTime.textContent = "Showing last cached snapshot";
        }

        if (data.summary) {
          document.getElementById('valEarnings').textContent = "₱" + (data.summary.earningsToday || 0);
          document.getElementById('valJobs').textContent = data.summary.jobsToday || 0;
          document.getElementById('valBlackInk').textContent = (data.summary.inkGrayscale ?? '--') + "%";
          document.getElementById('valColorInk').textContent = (data.summary.inkColor ?? '--') + "%";
        }

        if (data.hardware) {
          document.getElementById('hwPrinter').textContent = data.hardware.printer;
          document.getElementById('hwSerial').textContent = data.hardware.serial;
          document.getElementById('hwWorker').textContent = data.hardware.worker;
          document.getElementById('hwHotspot').textContent = data.hardware.hotspot;
        }
      } catch (err) {
        console.error("Failed to load status:", err);
      }
    }
    loadStatus();
    setInterval(loadStatus, 15000);
  </script>
</body>
</html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 1. Ingest telemetry from physical kiosk
    if (url.pathname === '/api/telemetry/sync' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      const expectedSecret = env.SYNC_SECRET?.trim();

      if (expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      try {
        const body = (await request.json()) as KioskTelemetryPayload;
        const kioskId = body.kioskId || 'printbit-kiosk-01';
        await env.PRINTBIT_STATE.put(`kiosk:${kioskId}`, JSON.stringify(body));
        return Response.json({
          ok: true,
          receivedAt: new Date().toISOString(),
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // 2. Query status for the dashboard
    if (url.pathname === '/api/kiosk-status' && request.method === 'GET') {
      const kioskId = url.searchParams.get('kioskId') || 'printbit-kiosk-01';
      const raw = await env.PRINTBIT_STATE.get(`kiosk:${kioskId}`);

      if (!raw) {
        return Response.json({
          isOnline: false,
          state: 'unknown',
          lastSeenAt: null,
          data: null,
        });
      }

      const data = JSON.parse(raw) as KioskTelemetryPayload;
      const lastSeenMs = Date.parse(data.timestamp);
      const ageMs = Number.isFinite(lastSeenMs)
        ? Date.now() - lastSeenMs
        : Infinity;
      const isOnline = ageMs < 90_000;

      return Response.json({
        isOnline,
        state: isOnline ? data.status : 'offline',
        lastSeenAt: data.timestamp,
        ageMs,
        data,
      });
    }

    // 3. Serve always-online Admin Portal
    return new Response(DASHBOARD_HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  },
};
```

- [ ] **Step 3: Commit edge worker code**

```bash
git add cloud/wrangler.jsonc cloud/worker.ts cloud/package.json cloud/tsconfig.json
git commit -m "feat(cloud): implement always-on Cloudflare Worker admin edge"
```

---

### Task 2: Kiosk Cloud Sync Configuration

**Files:**

- Create: `src/config/cloud-sync.config.ts`
- Modify: `src/config/index.ts`
- Test: `src/config/__tests__/cloud-sync.config.spec.ts`

**Interfaces:**

- Produces:

  ```typescript
  export interface CloudSyncConfig {
    enabled: boolean;
    syncUrl: string | null;
    secret: string | null;
    intervalSec: number;
    timeoutMs: number;
    kioskId: string;
  }
  export function getCloudSyncConfig(): CloudSyncConfig;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/config/__tests__/cloud-sync.config.spec.ts`:

```typescript
import { getCloudSyncConfig } from '../cloud-sync.config';

describe('cloud-sync.config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns defaults when env vars are unset', () => {
    delete process.env.PRINTBIT_CLOUD_SYNC_ENABLED;
    delete process.env.PRINTBIT_CLOUD_SYNC_URL;
    delete process.env.PRINTBIT_CLOUD_SYNC_SECRET;
    delete process.env.PRINTBIT_CLOUD_SYNC_INTERVAL_SEC;

    const config = getCloudSyncConfig();
    expect(config.enabled).toBe(false);
    expect(config.syncUrl).toBeNull();
    expect(config.secret).toBeNull();
    expect(config.intervalSec).toBe(30);
    expect(config.timeoutMs).toBe(5000);
    expect(config.kioskId).toBe('printbit-kiosk-01');
  });

  it('parses valid environment variables', () => {
    process.env.PRINTBIT_CLOUD_SYNC_ENABLED = 'true';
    process.env.PRINTBIT_CLOUD_SYNC_URL =
      'https://admin.printbitkiosk.com/api/telemetry/sync';
    process.env.PRINTBIT_CLOUD_SYNC_SECRET = 'secret-token-123';
    process.env.PRINTBIT_CLOUD_SYNC_INTERVAL_SEC = '45';
    process.env.PRINTBIT_CLOUD_SYNC_KIOSK_ID = 'campus-kiosk-02';

    const config = getCloudSyncConfig();
    expect(config.enabled).toBe(true);
    expect(config.syncUrl).toBe(
      'https://admin.printbitkiosk.com/api/telemetry/sync',
    );
    expect(config.secret).toBe('secret-token-123');
    expect(config.intervalSec).toBe(45);
    expect(config.kioskId).toBe('campus-kiosk-02');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest src/config/__tests__/cloud-sync.config.spec.ts`
Expected: FAIL with "Cannot find module '../cloud-sync.config'"

- [ ] **Step 3: Implement minimal configuration code**

Create `src/config/cloud-sync.config.ts`:

```typescript
export interface CloudSyncConfig {
  enabled: boolean;
  syncUrl: string | null;
  secret: string | null;
  intervalSec: number;
  timeoutMs: number;
  kioskId: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function getCloudSyncConfig(): CloudSyncConfig {
  const enabled = process.env.PRINTBIT_CLOUD_SYNC_ENABLED === 'true';
  const rawUrl = process.env.PRINTBIT_CLOUD_SYNC_URL?.trim();
  const syncUrl = rawUrl && rawUrl.length > 0 ? rawUrl : null;

  const rawSecret = process.env.PRINTBIT_CLOUD_SYNC_SECRET?.trim();
  const secret = rawSecret && rawSecret.length > 0 ? rawSecret : null;

  const rawInterval = parsePositiveInt(
    process.env.PRINTBIT_CLOUD_SYNC_INTERVAL_SEC,
    30,
  );
  const intervalSec = Math.max(10, Math.min(300, rawInterval));

  const rawTimeout = parsePositiveInt(
    process.env.PRINTBIT_CLOUD_SYNC_TIMEOUT_MS,
    5000,
  );
  const timeoutMs = Math.max(1000, Math.min(30000, rawTimeout));

  const kioskId =
    process.env.PRINTBIT_CLOUD_SYNC_KIOSK_ID?.trim() || 'printbit-kiosk-01';

  return {
    enabled,
    syncUrl,
    secret,
    intervalSec,
    timeoutMs,
    kioskId,
  };
}
```

Update `src/config/index.ts`:

```typescript
export * from './cloud-sync.config';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec jest src/config/__tests__/cloud-sync.config.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/cloud-sync.config.ts src/config/__tests__/cloud-sync.config.spec.ts src/config/index.ts
git commit -m "feat(config): add cloud-sync telemetry configuration"
```

---

### Task 3: Kiosk Outbound Telemetry Service

**Files:**

- Create: `src/services/cloud-sync.ts`
- Modify: `src/services/index.ts`
- Test: `src/services/__tests__/cloud-sync.spec.ts`

**Interfaces:**

- Consumes:
  - `getCloudSyncConfig()` from `@/config/cloud-sync.config`
  - `getWatchdogHealthSnapshot()` from `@/services/watchdog-health`
- Produces:

  ```typescript
  export interface CloudSyncResult {
    synced: boolean;
    status: 'synced' | 'skipped' | 'failed';
    statusCode?: number;
    error?: string;
  }
  export function gatherKioskSnapshot(): any;
  export function sendCloudSyncOnce(
    fetchFn?: typeof fetch,
  ): Promise<CloudSyncResult>;
  export function startCloudSync(fetchFn?: typeof fetch): void;
  export function stopCloudSync(): void;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/cloud-sync.spec.ts`:

```typescript
import {
  gatherKioskSnapshot,
  sendCloudSyncOnce,
  startCloudSync,
  stopCloudSync,
} from '../cloud-sync';
import * as watchdogHealth from '../watchdog-health';
import * as configModule from '@/config/cloud-sync.config';

jest.mock('../watchdog-health');
jest.mock('@/config/cloud-sync.config');

describe('cloud-sync service', () => {
  const mockWatchdog = watchdogHealth as jest.Mocked<typeof watchdogHealth>;
  const mockConfig = configModule as jest.Mocked<typeof configModule>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.getCloudSyncConfig.mockReturnValue({
      enabled: true,
      syncUrl: 'https://admin.printbitkiosk.com/api/telemetry/sync',
      secret: 'test-secret',
      intervalSec: 30,
      timeoutMs: 5000,
      kioskId: 'test-kiosk-01',
    });
  });

  afterEach(() => {
    stopCloudSync();
  });

  it('gathers snapshot correctly from watchdog and runtime data', () => {
    mockWatchdog.getWatchdogHealthSnapshot.mockReturnValue({
      overall: 'healthy',
      components: {
        app: {
          status: 'healthy',
          detail: 'App ok',
          lastHeartbeatAt: '',
          staleAfterMs: 20000,
          context: {},
        },
        printer: {
          status: 'healthy',
          detail: 'Printer ready',
          lastHeartbeatAt: '',
          staleAfterMs: 20000,
          context: {},
        },
        serial: {
          status: 'healthy',
          detail: 'Serial ok',
          lastHeartbeatAt: '',
          staleAfterMs: 20000,
          context: {},
        },
        hotspot: {
          status: 'healthy',
          detail: 'Hotspot ok',
          lastHeartbeatAt: '',
          staleAfterMs: 20000,
          context: {},
        },
      },
      externalWatchdog: {
        running: true,
        watchdogPid: 1234,
        consecutiveFailures: 0,
        recoveryAttempts: 0,
        backoffDelayMs: 0,
        nextRecoveryAt: null,
        lastAction: 'ok',
        lastError: null,
        lastUpdatedAt: '',
      },
    });

    const snapshot = gatherKioskSnapshot();
    expect(snapshot.kioskId).toBe('test-kiosk-01');
    expect(snapshot.status).toBe('healthy');
    expect(snapshot.hardware.printer).toBe('healthy');
  });

  it('transmits snapshot with Bearer token header', async () => {
    mockWatchdog.getWatchdogHealthSnapshot.mockReturnValue({
      overall: 'healthy',
      components: {
        app: {
          status: 'healthy',
          detail: 'ok',
          lastHeartbeatAt: '',
          staleAfterMs: 20000,
          context: {},
        },
        printer: {
          status: 'healthy',
          detail: 'ok',
          lastHeartbeatAt: '',
          staleAfterMs: 20000,
          context: {},
        },
        serial: {
          status: 'healthy',
          detail: 'ok',
          lastHeartbeatAt: '',
          staleAfterMs: 20000,
          context: {},
        },
        hotspot: {
          status: 'healthy',
          detail: 'ok',
          lastHeartbeatAt: '',
          staleAfterMs: 20000,
          context: {},
        },
      },
      externalWatchdog: {
        running: true,
        watchdogPid: null,
        consecutiveFailures: 0,
        recoveryAttempts: 0,
        backoffDelayMs: 0,
        nextRecoveryAt: null,
        lastAction: '',
        lastError: null,
        lastUpdatedAt: '',
      },
    });

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    const result = await sendCloudSyncOnce(
      mockFetch as unknown as typeof fetch,
    );
    expect(result.synced).toBe(true);
    expect(result.status).toBe('synced');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://admin.printbitkiosk.com/api/telemetry/sync',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-secret',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('skips sync when disabled', async () => {
    mockConfig.getCloudSyncConfig.mockReturnValue({
      enabled: false,
      syncUrl: null,
      secret: null,
      intervalSec: 30,
      timeoutMs: 5000,
      kioskId: 'test-kiosk-01',
    });

    const mockFetch = jest.fn();
    const result = await sendCloudSyncOnce(
      mockFetch as unknown as typeof fetch,
    );
    expect(result.synced).toBe(false);
    expect(result.status).toBe('skipped');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest src/services/__tests__/cloud-sync.spec.ts`
Expected: FAIL with "Cannot find module '../cloud-sync'"

- [ ] **Step 3: Implement minimal CloudSync service**

Create `src/services/cloud-sync.ts`:

```typescript
import { getCloudSyncConfig } from '@/config/cloud-sync.config';
import { getWatchdogHealthSnapshot } from '@/services/watchdog-health';
import { db } from '@/core/database/db';

export interface CloudSyncResult {
  synced: boolean;
  status: 'synced' | 'skipped' | 'failed';
  statusCode?: number;
  error?: string;
}

let syncTimer: NodeJS.Timeout | null = null;
let syncInFlight = false;

export function gatherKioskSnapshot() {
  const config = getCloudSyncConfig();
  const snapshot = getWatchdogHealthSnapshot();
  const issues: string[] = [];
  const hardware: Record<string, string> = {};

  for (const [key, comp] of Object.entries(snapshot.components)) {
    hardware[key] = comp.status;
    if (comp.status !== 'healthy') {
      issues.push(comp.detail);
    }
  }

  const earningsToday = db.data?.earnings || 0;
  const jobsToday =
    (db.data?.jobStats?.print || 0) +
    (db.data?.jobStats?.copy || 0) +
    (db.data?.jobStats?.scan || 0);

  return {
    kioskId: config.kioskId,
    timestamp: new Date().toISOString(),
    status: snapshot.overall === 'healthy' ? 'healthy' : 'degraded',
    uptimeSec: Math.floor(process.uptime()),
    hardware,
    summary: {
      earningsToday,
      jobsToday,
      owedChange: 0,
      inkGrayscale: 100,
      inkColor: 100,
      issues,
    },
  };
}

export async function sendCloudSyncOnce(
  customFetch: typeof fetch = fetch,
): Promise<CloudSyncResult> {
  const config = getCloudSyncConfig();
  if (!config.enabled || !config.syncUrl) {
    return { synced: false, status: 'skipped' };
  }

  const payload = gatherKioskSnapshot();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.secret) {
    headers.Authorization = `Bearer ${config.secret}`;
  }

  try {
    const res = await customFetch(config.syncUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    return {
      synced: res.ok,
      status: res.ok ? 'synced' : 'failed',
      statusCode: res.status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      '[CLOUD-SYNC] Failed to push kiosk telemetry to edge:',
      message,
    );
    return {
      synced: false,
      status: 'failed',
      error: message,
    };
  }
}

export function startCloudSync(customFetch: typeof fetch = fetch): void {
  if (syncTimer) return;

  const config = getCloudSyncConfig();
  if (!config.enabled || !config.syncUrl) {
    return;
  }

  console.info(
    `[CLOUD-SYNC] Starting cloud telemetry sync to ${config.syncUrl} (every ${config.intervalSec}s).`,
  );
  void sendCloudSyncOnce(customFetch);

  syncTimer = setInterval(async () => {
    if (syncInFlight) return;
    syncInFlight = true;
    try {
      await sendCloudSyncOnce(customFetch);
    } finally {
      syncInFlight = false;
    }
  }, config.intervalSec * 1000);

  syncTimer.unref();
}

export function stopCloudSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  syncInFlight = false;
}
```

Update `src/services/index.ts`:

```typescript
export * from './cloud-sync';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec jest src/services/__tests__/cloud-sync.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/cloud-sync.ts src/services/__tests__/cloud-sync.spec.ts src/services/index.ts
git commit -m "feat(services): implement outbound cloud telemetry sync service"
```

---

### Task 4: Server Lifecycle Wiring & Environment Documentation

**Files:**

- Modify: `src/server.ts`
- Modify: `.env.example`

- [ ] **Step 1: Wire startCloudSync and stopCloudSync into server lifecycle**

In `src/server.ts`, import functions:

```typescript
import { startCloudSync, stopCloudSync } from '@/services/cloud-sync';
```

In `initializeBackgroundSubsystems()`:

```typescript
startCloudSync();
```

In `gracefulShutdown()`:

```typescript
stopCloudSync();
```

- [ ] **Step 2: Add configuration block to `.env.example`**

In `.env.example`:

```ini
# ==========================================
# Cloud Edge Telemetry Sync (Always-On Admin)
# ==========================================
# Pushes periodic status and earnings snapshots to Cloudflare Worker edge (admin.printbitkiosk.com)
PRINTBIT_CLOUD_SYNC_ENABLED=false
PRINTBIT_CLOUD_SYNC_URL=https://admin.printbitkiosk.com/api/telemetry/sync
PRINTBIT_CLOUD_SYNC_SECRET=
PRINTBIT_CLOUD_SYNC_INTERVAL_SEC=30
PRINTBIT_CLOUD_SYNC_TIMEOUT_MS=5000
PRINTBIT_CLOUD_SYNC_KIOSK_ID=printbit-kiosk-01
```

- [ ] **Step 3: Run full type-check and test suite verification**

Run:

```bash
pnpm exec tsc --noEmit --ignoreDeprecations 6.0
pnpm test
```

Expected: PASS with 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts .env.example
git commit -m "feat(server): wire cloud telemetry sync into server lifecycle"
```
