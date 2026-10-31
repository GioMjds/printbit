# Kiosk Operational Readiness & Dead-Man Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an outbound dead-man heartbeat reporter in PrintBit that evaluates hardware readiness and pings an external monitor (Healthchecks.io / Better Stack) to alert when the kiosk is impaired or down.

**Architecture:** A lightweight background reporter in Node.js queries local health state from `watchdog-health.ts` every 30 seconds. When all subsystems are operational, it sends an HTTP POST/GET to an external dead-man ping URL. When hardware is degraded, it sends a failure payload to `<PING_URL>/fail`. If power or network is lost, the cloud monitor's dead-man timer triggers Telegram alerts.

**Tech Stack:** Node.js 22+ (`fetch`, `AbortSignal.timeout`), TypeScript 6 (strict mode), Jest (`ts-jest`), Express 5.

**Spec:** `docs/superpowers/specs/2026-10-31-kiosk-dead-man-heartbeat-design.md`

## Global Constraints
- `PRINTBIT_HEARTBEAT_ENABLED` must default to `false` (opt-in for production).
- Strict timeout of 5,000ms (`AbortSignal.timeout(5000)`) on all outgoing HTTP requests; never block the Node event loop.
- No uncaught exceptions or server crashes on network failure (silently log at `warn` level).
- No customer PII or transaction data in diagnostic payloads.
- All code formatted in TypeScript strict mode with `@/*` path aliases.

---

### Task 1: Configuration Module for Dead-Man Heartbeat

**Files:**
- Create: `src/config/heartbeat.config.ts`
- Modify: `src/config/index.ts`
- Test: `src/config/__tests__/heartbeat.config.spec.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface HeartbeatConfig {
    enabled: boolean;
    pingUrl: string | null;
    intervalSec: number;
    timeoutMs: number;
    kioskId: string;
  }
  export function getHeartbeatConfig(): HeartbeatConfig;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/config/__tests__/heartbeat.config.spec.ts`:
```typescript
import { getHeartbeatConfig } from '../heartbeat.config';

describe('heartbeat.config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns default config when env vars are unset', () => {
    delete process.env.PRINTBIT_HEARTBEAT_ENABLED;
    delete process.env.PRINTBIT_HEARTBEAT_PING_URL;
    delete process.env.PRINTBIT_HEARTBEAT_INTERVAL_SEC;
    delete process.env.PRINTBIT_HEARTBEAT_TIMEOUT_MS;
    delete process.env.PRINTBIT_HEARTBEAT_KIOSK_ID;

    const config = getHeartbeatConfig();
    expect(config.enabled).toBe(false);
    expect(config.pingUrl).toBeNull();
    expect(config.intervalSec).toBe(30);
    expect(config.timeoutMs).toBe(5000);
    expect(config.kioskId).toBe('printbit-kiosk-01');
  });

  it('reads valid env overrides', () => {
    process.env.PRINTBIT_HEARTBEAT_ENABLED = 'true';
    process.env.PRINTBIT_HEARTBEAT_PING_URL = 'https://hc-ping.com/12345678';
    process.env.PRINTBIT_HEARTBEAT_INTERVAL_SEC = '45';
    process.env.PRINTBIT_HEARTBEAT_TIMEOUT_MS = '8000';
    process.env.PRINTBIT_HEARTBEAT_KIOSK_ID = 'campus-lib-02';

    const config = getHeartbeatConfig();
    expect(config.enabled).toBe(true);
    expect(config.pingUrl).toBe('https://hc-ping.com/12345678');
    expect(config.intervalSec).toBe(45);
    expect(config.timeoutMs).toBe(8000);
    expect(config.kioskId).toBe('campus-lib-02');
  });

  it('clamps invalid interval bounds between 10 and 300 seconds', () => {
    process.env.PRINTBIT_HEARTBEAT_INTERVAL_SEC = '2';
    expect(getHeartbeatConfig().intervalSec).toBe(10);

    process.env.PRINTBIT_HEARTBEAT_INTERVAL_SEC = '999';
    expect(getHeartbeatConfig().intervalSec).toBe(300);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest src/config/__tests__/heartbeat.config.spec.ts`
Expected: FAIL with "Cannot find module '../heartbeat.config'"

- [ ] **Step 3: Implement minimal configuration code**

Create `src/config/heartbeat.config.ts`:
```typescript
export interface HeartbeatConfig {
  enabled: boolean;
  pingUrl: string | null;
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

export function getHeartbeatConfig(): HeartbeatConfig {
  const enabled = process.env.PRINTBIT_HEARTBEAT_ENABLED === 'true';
  const rawUrl = process.env.PRINTBIT_HEARTBEAT_PING_URL?.trim();
  const pingUrl = rawUrl && rawUrl.length > 0 ? rawUrl : null;

  const rawInterval = parsePositiveInt(process.env.PRINTBIT_HEARTBEAT_INTERVAL_SEC, 30);
  const intervalSec = Math.max(10, Math.min(300, rawInterval));

  const rawTimeout = parsePositiveInt(process.env.PRINTBIT_HEARTBEAT_TIMEOUT_MS, 5000);
  const timeoutMs = Math.max(1000, Math.min(30000, rawTimeout));

  const kioskId = process.env.PRINTBIT_HEARTBEAT_KIOSK_ID?.trim() || 'printbit-kiosk-01';

  return {
    enabled,
    pingUrl,
    intervalSec,
    timeoutMs,
    kioskId,
  };
}
```

Update `src/config/index.ts` to export heartbeat config:
```typescript
export * from './heartbeat.config';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec jest src/config/__tests__/heartbeat.config.spec.ts`
Expected: PASS (3 tests passing)

- [ ] **Step 5: Commit**

```bash
git add src/config/heartbeat.config.ts src/config/__tests__/heartbeat.config.spec.ts src/config/index.ts
git commit -m "feat(config): add dead-man heartbeat configuration"
```

---

### Task 2: Heartbeat Reporter Core Service

**Files:**
- Create: `src/services/heartbeat-reporter.ts`
- Modify: `src/services/index.ts`
- Test: `src/services/__tests__/heartbeat-reporter.spec.ts`

**Interfaces:**
- Consumes:
  - `getHeartbeatConfig()` from `@/config/heartbeat.config`
  - `getWatchdogHealthSnapshot()` from `@/services/watchdog-health`
- Produces:
  ```typescript
  export interface HeartbeatDiagnosticPayload {
    kioskId: string;
    status: 'healthy' | 'degraded';
    timestamp: string;
    uptimeSec: number;
    issues: string[];
    components: Record<string, string>;
  }

  export interface HeartbeatSendResult {
    sent: boolean;
    endpoint: string | null;
    status: 'healthy' | 'degraded' | 'skipped' | 'failed';
    statusCode?: number;
    error?: string;
  }

  export function evaluateReadiness(): { isHealthy: boolean; issues: string[]; components: Record<string, string> };
  export function sendHeartbeatOnce(fetchFn?: typeof fetch): Promise<HeartbeatSendResult>;
  export function startHeartbeatReporter(fetchFn?: typeof fetch): void;
  export function stopHeartbeatReporter(): void;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/heartbeat-reporter.spec.ts`:
```typescript
import {
  evaluateReadiness,
  sendHeartbeatOnce,
  startHeartbeatReporter,
  stopHeartbeatReporter,
} from '../heartbeat-reporter';
import * as watchdogHealth from '../watchdog-health';
import * as configModule from '@/config/heartbeat.config';

jest.mock('../watchdog-health');
jest.mock('@/config/heartbeat.config');

describe('heartbeat-reporter', () => {
  const mockWatchdog = watchdogHealth as jest.Mocked<typeof watchdogHealth>;
  const mockConfig = configModule as jest.Mocked<typeof configModule>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.getHeartbeatConfig.mockReturnValue({
      enabled: true,
      pingUrl: 'https://hc-ping.com/test-uuid',
      intervalSec: 30,
      timeoutMs: 5000,
      kioskId: 'test-kiosk',
    });
  });

  afterEach(() => {
    stopHeartbeatReporter();
  });

  it('evaluates readiness as healthy when all components pass', () => {
    mockWatchdog.getWatchdogHealthSnapshot.mockReturnValue({
      overall: 'healthy',
      components: {
        app: { status: 'healthy', detail: 'App ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
        printer: { status: 'healthy', detail: 'Printer ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
        serial: { status: 'healthy', detail: 'Serial ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
        hotspot: { status: 'healthy', detail: 'Hotspot ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
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

    const readiness = evaluateReadiness();
    expect(readiness.isHealthy).toBe(true);
    expect(readiness.issues).toEqual([]);
    expect(readiness.components.printer).toBe('healthy');
  });

  it('evaluates readiness as degraded when printer or serial is impaired', () => {
    mockWatchdog.getWatchdogHealthSnapshot.mockReturnValue({
      overall: 'degraded',
      components: {
        app: { status: 'healthy', detail: 'App ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
        printer: { status: 'degraded', detail: 'Printer blocked: paper_out', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
        serial: { status: 'degraded', detail: 'Serial disconnected', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
        hotspot: { status: 'healthy', detail: 'Hotspot ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
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

    const readiness = evaluateReadiness();
    expect(readiness.isHealthy).toBe(false);
    expect(readiness.issues).toContain('Printer blocked: paper_out');
    expect(readiness.issues).toContain('Serial disconnected');
  });

  it('sends base URL ping on healthy state', async () => {
    mockWatchdog.getWatchdogHealthSnapshot.mockReturnValue({
      overall: 'healthy',
      components: {
        app: { status: 'healthy', detail: 'App ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
        printer: { status: 'healthy', detail: 'Printer ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
        serial: { status: 'healthy', detail: 'Serial ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
        hotspot: { status: 'healthy', detail: 'Hotspot ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
      },
      externalWatchdog: { running: true, watchdogPid: null, consecutiveFailures: 0, recoveryAttempts: 0, backoffDelayMs: 0, nextRecoveryAt: null, lastAction: '', lastError: null, lastUpdatedAt: '' },
    });

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    const result = await sendHeartbeatOnce(mockFetch as unknown as typeof fetch);
    expect(result.sent).toBe(true);
    expect(result.status).toBe('healthy');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hc-ping.com/test-uuid',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends /fail URL ping with diagnostic payload on degraded state', async () => {
    mockWatchdog.getWatchdogHealthSnapshot.mockReturnValue({
      overall: 'degraded',
      components: {
        app: { status: 'healthy', detail: 'App ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
        printer: { status: 'degraded', detail: 'Printer blocked: paper_out', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
        serial: { status: 'healthy', detail: 'Serial ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
        hotspot: { status: 'healthy', detail: 'Hotspot ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
      },
      externalWatchdog: { running: true, watchdogPid: null, consecutiveFailures: 0, recoveryAttempts: 0, backoffDelayMs: 0, nextRecoveryAt: null, lastAction: '', lastError: null, lastUpdatedAt: '' },
    });

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    const result = await sendHeartbeatOnce(mockFetch as unknown as typeof fetch);
    expect(result.sent).toBe(true);
    expect(result.status).toBe('degraded');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hc-ping.com/test-uuid/fail',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('skips sending when heartbeat is disabled', async () => {
    mockConfig.getHeartbeatConfig.mockReturnValue({
      enabled: false,
      pingUrl: 'https://hc-ping.com/test-uuid',
      intervalSec: 30,
      timeoutMs: 5000,
      kioskId: 'test-kiosk',
    });

    const mockFetch = jest.fn();
    const result = await sendHeartbeatOnce(mockFetch as unknown as typeof fetch);
    expect(result.sent).toBe(false);
    expect(result.status).toBe('skipped');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('catches network error gracefully without throwing', async () => {
    mockWatchdog.getWatchdogHealthSnapshot.mockReturnValue({
      overall: 'healthy',
      components: {
        app: { status: 'healthy', detail: 'App ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
        printer: { status: 'healthy', detail: 'Printer ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
        serial: { status: 'healthy', detail: 'Serial ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
        hotspot: { status: 'healthy', detail: 'Hotspot ok', lastHeartbeatAt: '', staleAfterMs: 20000, context: {} },
      },
      externalWatchdog: { running: true, watchdogPid: null, consecutiveFailures: 0, recoveryAttempts: 0, backoffDelayMs: 0, nextRecoveryAt: null, lastAction: '', lastError: null, lastUpdatedAt: '' },
    });

    const mockFetch = jest.fn().mockRejectedValue(new Error('Network timeout'));

    const result = await sendHeartbeatOnce(mockFetch as unknown as typeof fetch);
    expect(result.sent).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Network timeout');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest src/services/__tests__/heartbeat-reporter.spec.ts`
Expected: FAIL with "Cannot find module '../heartbeat-reporter'"

- [ ] **Step 3: Implement minimal HeartbeatReporter service**

Create `src/services/heartbeat-reporter.ts`:
```typescript
import { getHeartbeatConfig } from '@/config/heartbeat.config';
import { getWatchdogHealthSnapshot } from '@/services/watchdog-health';

export interface HeartbeatDiagnosticPayload {
  kioskId: string;
  status: 'healthy' | 'degraded';
  timestamp: string;
  uptimeSec: number;
  issues: string[];
  components: Record<string, string>;
}

export interface HeartbeatSendResult {
  sent: boolean;
  endpoint: string | null;
  status: 'healthy' | 'degraded' | 'skipped' | 'failed';
  statusCode?: number;
  error?: string;
}

let reporterTimer: NodeJS.Timeout | null = null;
let reporterInFlight = false;

export function evaluateReadiness(): {
  isHealthy: boolean;
  issues: string[];
  components: Record<string, string>;
} {
  const snapshot = getWatchdogHealthSnapshot();
  const issues: string[] = [];
  const components: Record<string, string> = {};

  for (const [key, comp] of Object.entries(snapshot.components)) {
    components[key] = comp.status;
    if (comp.status !== 'healthy') {
      issues.push(comp.detail);
    }
  }

  const isHealthy = issues.length === 0 && snapshot.overall === 'healthy';
  return { isHealthy, issues, components };
}

export async function sendHeartbeatOnce(
  customFetch: typeof fetch = fetch,
): Promise<HeartbeatSendResult> {
  const config = getHeartbeatConfig();
  if (!config.enabled || !config.pingUrl) {
    return { sent: false, endpoint: null, status: 'skipped' };
  }

  const readiness = evaluateReadiness();
  const targetUrl = readiness.isHealthy
    ? config.pingUrl
    : `${config.pingUrl.replace(/\/+$/, '')}/fail`;

  const payload: HeartbeatDiagnosticPayload = {
    kioskId: config.kioskId,
    status: readiness.isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    issues: readiness.issues,
    components: readiness.components,
  };

  try {
    const res = await customFetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    return {
      sent: true,
      endpoint: targetUrl,
      status: readiness.isHealthy ? 'healthy' : 'degraded',
      statusCode: res.status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[HEARTBEAT-REPORTER] Failed to dispatch heartbeat ping:', {
      endpoint: targetUrl,
      error: message,
    });
    return {
      sent: false,
      endpoint: targetUrl,
      status: 'failed',
      error: message,
    };
  }
}

export function startHeartbeatReporter(customFetch: typeof fetch = fetch): void {
  if (reporterTimer) return;

  const config = getHeartbeatConfig();
  if (!config.enabled || !config.pingUrl) {
    console.info('[HEARTBEAT-REPORTER] Outbound heartbeat reporter disabled (opt-in via PRINTBIT_HEARTBEAT_ENABLED).');
    return;
  }

  console.info(`[HEARTBEAT-REPORTER] Starting outbound heartbeat reporter (interval: ${config.intervalSec}s).`);

  void sendHeartbeatOnce(customFetch);

  reporterTimer = setInterval(async () => {
    if (reporterInFlight) return;
    reporterInFlight = true;
    try {
      await sendHeartbeatOnce(customFetch);
    } finally {
      reporterInFlight = false;
    }
  }, config.intervalSec * 1000);

  reporterTimer.unref();
}

export function stopHeartbeatReporter(): void {
  if (reporterTimer) {
    clearInterval(reporterTimer);
    reporterTimer = null;
  }
  reporterInFlight = false;
}
```

Update `src/services/index.ts` to export the reporter functions:
```typescript
export * from './heartbeat-reporter';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec jest src/services/__tests__/heartbeat-reporter.spec.ts`
Expected: PASS (6 tests passing)

- [ ] **Step 5: Commit**

```bash
git add src/services/heartbeat-reporter.ts src/services/__tests__/heartbeat-reporter.spec.ts src/services/index.ts
git commit -m "feat(services): implement outbound dead-man heartbeat reporter"
```

---

### Task 3: Admin Test Trigger Endpoint

**Files:**
- Modify: `src/modules/admin/admin.controller.ts`
- Modify: `src/modules/admin/admin.module.ts`
- Test: `src/modules/admin/__tests__/admin-heartbeat.spec.ts`

**Interfaces:**
- Consumes: `sendHeartbeatOnce` and `getHeartbeatConfig` from `@/services/heartbeat-reporter` and `@/config/heartbeat.config`
- Produces: `POST /api/admin/heartbeat/test` route (protected by admin authentication).

- [ ] **Step 1: Write the failing test**

Create `src/modules/admin/__tests__/admin-heartbeat.spec.ts`:
```typescript
import express from 'express';
import request from 'supertest';
import { AdminController } from '../admin.controller';
import * as heartbeatReporter from '@/services/heartbeat-reporter';

jest.mock('@/services/heartbeat-reporter');

describe('POST /api/admin/heartbeat/test', () => {
  const mockReporter = heartbeatReporter as jest.Mocked<typeof heartbeatReporter>;
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());

    // Minimal admin controller setup with dummy deps
    const dummyDeps: any = {
      adminService: {
        verifyPin: jest.fn().mockReturnValue(true),
        appendAdminLog: jest.fn().mockResolvedValue(undefined),
      },
      auditStore: {},
    };
    const controller = new AdminController(dummyDeps);
    app.use('/api/admin', controller.router);
  });

  it('triggers immediate heartbeat and returns result', async () => {
    mockReporter.sendHeartbeatOnce.mockResolvedValue({
      sent: true,
      endpoint: 'https://hc-ping.com/test-uuid',
      status: 'healthy',
      statusCode: 200,
    });

    const res = await request(app)
      .post('/api/admin/heartbeat/test')
      .set('x-admin-pin', '1234')
      .send();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.result.status).toBe('healthy');
    expect(mockReporter.sendHeartbeatOnce).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest src/modules/admin/__tests__/admin-heartbeat.spec.ts`
Expected: FAIL with 404 (route not found).

- [ ] **Step 3: Implement admin test route**

In `src/modules/admin/admin.controller.ts`, import `sendHeartbeatOnce`:
```typescript
import { sendHeartbeatOnce } from '@/services/heartbeat-reporter';
```

And in `setupRoutes()`:
```typescript
this.router.post(
  '/heartbeat/test',
  this.requireAdminAuth.bind(this),
  async (_req, res) => {
    try {
      const result = await sendHeartbeatOnce();
      res.json({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec jest src/modules/admin/__tests__/admin-heartbeat.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/admin.controller.ts src/modules/admin/__tests__/admin-heartbeat.spec.ts
git commit -m "feat(admin): add heartbeat test endpoint for operators"
```

---

### Task 4: Server Lifecycle Wiring & Integration Verification

**Files:**
- Modify: `src/server.ts:445-455` & `src/server.ts:810-820`
- Modify: `.env.example`
- Modify: `API_DOCUMENTATION.md`
- Test: Full type-check and test suite verification

**Interfaces:**
- Consumes: `startHeartbeatReporter` and `stopHeartbeatReporter` from `@/services/heartbeat-reporter`

- [ ] **Step 1: Wire heartbeat reporter into server startup and shutdown**

In `src/server.ts`, import functions:
```typescript
import {
  startHeartbeatReporter,
  stopHeartbeatReporter,
} from '@/services/heartbeat-reporter';
```

In the background initialization phase of `startServer()` (around line 450):
```typescript
startHeartbeatReporter();
```

In the graceful shutdown handler of `server.ts` (around line 815, alongside `stopWatchdogHealthMonitor()`):
```typescript
stopHeartbeatReporter();
```

- [ ] **Step 2: Document configuration in `.env.example`**

Add the heartbeat block to `.env.example`:
```ini
# ==========================================
# Outbound Dead-Man Heartbeat
# ==========================================
# Enables periodic operational readiness pings to an external dead-man monitor (e.g. Healthchecks.io / Better Stack)
PRINTBIT_HEARTBEAT_ENABLED=false
PRINTBIT_HEARTBEAT_PING_URL=
PRINTBIT_HEARTBEAT_INTERVAL_SEC=30
PRINTBIT_HEARTBEAT_TIMEOUT_MS=5000
PRINTBIT_HEARTBEAT_KIOSK_ID=printbit-kiosk-01
```

- [ ] **Step 3: Document API route in `API_DOCUMENTATION.md`**

Add documentation for `POST /api/admin/heartbeat/test` under Admin Endpoints.

- [ ] **Step 4: Run type-check and full tests to verify zero regressions**

Run:
```bash
pnpm exec tsc --noEmit --ignoreDeprecations 6.0
pnpm test
```
Expected: All TypeScript checks pass and Jest test suite passes.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts .env.example API_DOCUMENTATION.md
git commit -m "feat(server): wire dead-man heartbeat reporter into server lifecycle"
```
