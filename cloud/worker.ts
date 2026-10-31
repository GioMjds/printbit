export interface Env {
  PRINTBIT_STATE: KVNamespace;
  SYNC_SECRET?: string;
}

export interface KioskTelemetryPayload {
  kioskId: string;
  timestamp: string;
  status: 'healthy' | 'degraded' | string;
  uptimeSec?: number;
  hardware?: Record<string, string>;
  summary?: {
    earningsToday?: number;
    jobsToday?: number;
    owedChange?: number;
    inkGrayscale?: number;
    inkColor?: number;
    issues?: string[];
  };
}

export interface KioskStatusResponse {
  isOnline: boolean;
  ageMs: number | null;
  kioskId: string;
  timestamp?: string;
  status?: string;
  uptimeSec?: number;
  hardware: Record<string, string>;
  summary: {
    earningsToday: number;
    jobsToday: number;
    owedChange: number;
    inkGrayscale: number;
    inkColor: number;
    issues: string[];
  };
  data?: KioskTelemetryPayload;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function createEmptyStatus(kioskId: string): KioskStatusResponse {
  return {
    isOnline: false,
    ageMs: null,
    kioskId,
    hardware: {},
    summary: {
      earningsToday: 0,
      jobsToday: 0,
      owedChange: 0,
      inkGrayscale: 0,
      inkColor: 0,
      issues: ['No telemetry ingested yet'],
    },
  };
}

function formatRelativeTime(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return 'Never';
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m ago`;
}

function formatUptime(uptimeSec?: number): string {
  if (!uptimeSec || uptimeSec <= 0) return '0s';
  const hours = Math.floor(uptimeSec / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);
  const seconds = uptimeSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function renderDashboardHtml(status: KioskStatusResponse): string {
  const isOnline = status.isOnline;
  const lastSeenStr = status.timestamp ? new Date(status.timestamp).toLocaleString() : 'Never';
  const relativeAge = formatRelativeTime(status.ageMs);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PrintBit Edge Admin — ${status.kioskId}</title>
  <style>
    :root {
      --bg: #090d16;
      --card: #131b2e;
      --card-border: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --green-bg: #064e3b;
      --green-border: #059669;
      --green-text: #6ee7b7;
      --red-bg: #7f1d1d;
      --red-border: #dc2626;
      --red-text: #fca5a5;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      padding: 24px 16px;
      min-height: 100vh;
      display: flex;
      justify-content: center;
    }
    .container {
      width: 100%;
      max-width: 960px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo-badge {
      background: linear-gradient(135deg, #0284c7, #38bdf8);
      color: #fff;
      font-weight: 800;
      font-size: 14px;
      padding: 6px 12px;
      border-radius: 8px;
      letter-spacing: 0.05em;
    }
    .brand h1 {
      font-size: 20px;
      font-weight: 700;
    }
    .kiosk-tag {
      color: var(--text-muted);
      font-size: 13px;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    button.refresh-btn {
      background: var(--card);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 8px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.15s ease;
    }
    button.refresh-btn:hover {
      background: #1e293b;
      border-color: #334155;
    }
    .status-banner {
      border-radius: 12px;
      padding: 16px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border: 1px solid transparent;
      transition: all 0.3s ease;
    }
    .status-banner.online {
      background-color: var(--green-bg);
      border-color: var(--green-border);
      color: var(--green-text);
    }
    .status-banner.offline {
      background-color: var(--red-bg);
      border-color: var(--red-border);
      color: var(--red-text);
    }
    .status-indicator {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 700;
      font-size: 16px;
      letter-spacing: 0.03em;
    }
    .pulse-dot {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 10px currentColor;
      animation: pulse 2s infinite ease-in-out;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }
    .status-meta {
      font-size: 13px;
      text-align: right;
      opacity: 0.9;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .card-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .card-value {
      font-size: 26px;
      font-weight: 700;
      color: #fff;
    }
    .card-subtitle {
      font-size: 12px;
      color: var(--text-muted);
    }
    .ink-bars {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 4px;
    }
    .bar-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      gap: 8px;
    }
    .bar-outer {
      flex: 1;
      height: 8px;
      background: #1e293b;
      border-radius: 4px;
      overflow: hidden;
    }
    .bar-inner {
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s ease;
    }
    .bar-inner.black { background: #94a3b8; }
    .bar-inner.color { background: linear-gradient(90deg, #ec4899, #3b82f6, #eab308); }
    .section-title {
      font-size: 16px;
      font-weight: 600;
      margin-top: 10px;
    }
    .hw-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 12px;
    }
    .hw-badge {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 12px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .hw-name {
      font-size: 13px;
      font-weight: 500;
      text-transform: capitalize;
    }
    .hw-status {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 4px;
      text-transform: uppercase;
    }
    .hw-status.healthy { background: #064e3b; color: #6ee7b7; }
    .hw-status.degraded { background: #78350f; color: #fde68a; }
    .hw-status.error, .hw-status.unhealthy, .hw-status.offline { background: #7f1d1d; color: #fca5a5; }
    .issues-list {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px 20px;
      font-size: 14px;
    }
    .issue-item {
      color: #fca5a5;
      padding: 6px 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .issue-none {
      color: var(--text-muted);
      font-style: italic;
    }
    footer {
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--card-border);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <span class="logo-badge">PRINTBIT</span>
        <div>
          <h1>Always-On Cloud Edge</h1>
          <span class="kiosk-tag">Kiosk Target: <strong id="kiosk-id-label">${status.kioskId}</strong></span>
        </div>
      </div>
      <div class="header-actions">
        <span id="sync-timer-label" style="font-size: 12px; color: var(--text-muted);">Auto-refreshing (5s)</span>
        <button class="refresh-btn" onclick="fetchStatus()">Refresh</button>
      </div>
    </header>

    <div id="status-banner" class="status-banner ${isOnline ? 'online' : 'offline'}">
      <div class="status-indicator">
        <div class="pulse-dot"></div>
        <span id="status-text">${isOnline ? 'KIOSK ONLINE' : 'KIOSK OFFLINE'}</span>
      </div>
      <div class="status-meta">
        <div>Last Heartbeat: <strong id="last-seen-text">${relativeAge}</strong></div>
        <div style="font-size: 11px; opacity: 0.75;" id="timestamp-text">${lastSeenStr}</div>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <span class="card-title">Earnings Today</span>
        <span class="card-value" id="earnings-value">₱${status.summary.earningsToday.toFixed(2)}</span>
        <span class="card-subtitle">Local database balance</span>
      </div>
      <div class="card">
        <span class="card-title">Jobs Processed</span>
        <span class="card-value" id="jobs-value">${status.summary.jobsToday}</span>
        <span class="card-subtitle">Print / Copy / Scan total</span>
      </div>
      <div class="card">
        <span class="card-title">Ink Levels</span>
        <div class="ink-bars">
          <div class="bar-row">
            <span>Black</span>
            <div class="bar-outer"><div id="ink-black-bar" class="bar-inner black" style="width: ${status.summary.inkGrayscale}%;"></div></div>
            <span id="ink-black-val">${status.summary.inkGrayscale}%</span>
          </div>
          <div class="bar-row">
            <span>Color</span>
            <div class="bar-outer"><div id="ink-color-bar" class="bar-inner color" style="width: ${status.summary.inkColor}%;"></div></div>
            <span id="ink-color-val">${status.summary.inkColor}%</span>
          </div>
        </div>
      </div>
      <div class="card">
        <span class="card-title">Kiosk Uptime</span>
        <span class="card-value" id="uptime-value">${formatUptime(status.uptimeSec)}</span>
        <span class="card-subtitle" id="status-health-label">Health: ${status.status || 'unknown'}</span>
      </div>
    </div>

    <h2 class="section-title">Hardware Telemetry</h2>
    <div class="hw-grid" id="hw-grid">
      ${
        Object.keys(status.hardware).length === 0
          ? '<div class="hw-badge"><span class="hw-name">No hardware data</span><span class="hw-status offline">N/A</span></div>'
          : Object.entries(status.hardware)
              .map(
                ([k, v]) => `
        <div class="hw-badge">
          <span class="hw-name">${k}</span>
          <span class="hw-status ${v.toLowerCase()}">${v}</span>
        </div>`
              )
              .join('')
      }
    </div>

    <h2 class="section-title">Active Issues & Alerts</h2>
    <div class="issues-list" id="issues-list">
      ${
        status.summary.issues.length === 0
          ? '<div class="issue-none">✓ No active alerts. All components nominal.</div>'
          : status.summary.issues.map((issue) => `<div class="issue-item">⚠️ ${issue}</div>`).join('')
      }
    </div>

    <footer>
      PrintBit Cloud Edge Telemetry • Edge Worker runtime powered by Cloudflare
    </footer>
  </div>

  <script>
    const kioskId = "${status.kioskId}";

    function formatRelative(ageMs) {
      if (ageMs === null || isNaN(ageMs)) return 'Never';
      const sec = Math.floor(ageMs / 1000);
      if (sec < 60) return sec + 's ago';
      const min = Math.floor(sec / 60);
      if (min < 60) return min + 'm ago';
      const hr = Math.floor(min / 60);
      return hr + 'h ' + (min % 60) + 'm ago';
    }

    function formatUptimeSec(uptimeSec) {
      if (!uptimeSec || uptimeSec <= 0) return '0s';
      const hours = Math.floor(uptimeSec / 3600);
      const minutes = Math.floor((uptimeSec % 3600) / 60);
      const seconds = uptimeSec % 60;
      if (hours > 0) return hours + 'h ' + minutes + 'm ' + seconds + 's';
      if (minutes > 0) return minutes + 'm ' + seconds + 's';
      return seconds + 's';
    }

    async function fetchStatus() {
      try {
        const res = await fetch('/api/kiosk-status?kioskId=' + encodeURIComponent(kioskId));
        if (!res.ok) return;
        const data = await res.json();
        updateUI(data);
      } catch (err) {
        console.warn('Failed to poll status', err);
      }
    }

    function updateUI(data) {
      const banner = document.getElementById('status-banner');
      const statusText = document.getElementById('status-text');
      const lastSeenText = document.getElementById('last-seen-text');
      const timestampText = document.getElementById('timestamp-text');

      if (data.isOnline) {
        banner.className = 'status-banner online';
        statusText.textContent = 'KIOSK ONLINE';
      } else {
        banner.className = 'status-banner offline';
        statusText.textContent = 'KIOSK OFFLINE';
      }

      lastSeenText.textContent = formatRelative(data.ageMs);
      timestampText.textContent = data.timestamp ? new Date(data.timestamp).toLocaleString() : 'Never';

      if (data.summary) {
        document.getElementById('earnings-value').textContent = '₱' + (data.summary.earningsToday || 0).toFixed(2);
        document.getElementById('jobs-value').textContent = data.summary.jobsToday || 0;
        
        const inkGray = data.summary.inkGrayscale ?? 100;
        const inkColor = data.summary.inkColor ?? 100;
        document.getElementById('ink-black-bar').style.width = inkGray + '%';
        document.getElementById('ink-black-val').textContent = inkGray + '%';
        document.getElementById('ink-color-bar').style.width = inkColor + '%';
        document.getElementById('ink-color-val').textContent = inkColor + '%';

        const issuesEl = document.getElementById('issues-list');
        if (!data.summary.issues || data.summary.issues.length === 0) {
          issuesEl.innerHTML = '<div class="issue-none">✓ No active alerts. All components nominal.</div>';
        } else {
          issuesEl.innerHTML = data.summary.issues.map(i => '<div class="issue-item">⚠️ ' + i + '</div>').join('');
        }
      }

      if (data.uptimeSec !== undefined) {
        document.getElementById('uptime-value').textContent = formatUptimeSec(data.uptimeSec);
      }
      if (data.status) {
        document.getElementById('status-health-label').textContent = 'Health: ' + data.status;
      }

      if (data.hardware && Object.keys(data.hardware).length > 0) {
        const hwGrid = document.getElementById('hw-grid');
        hwGrid.innerHTML = Object.entries(data.hardware).map(([k, v]) => \`
          <div class="hw-badge">
            <span class="hw-name">\${k}</span>
            <span class="hw-status \${String(v).toLowerCase()}">\${v}</span>
          </div>
        \`).join('');
      }
    }

    setInterval(fetchStatus, 5000);
  </script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // 1. Sync telemetry endpoint: POST /api/telemetry/sync
    if (url.pathname === '/api/telemetry/sync') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      if (env.SYNC_SECRET) {
        const auth = request.headers.get('Authorization');
        if (auth !== `Bearer ${env.SYNC_SECRET}`) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }
      }

      try {
        const body = (await request.json()) as Partial<KioskTelemetryPayload>;
        const kioskId = body.kioskId || 'printbit-kiosk-01';
        const payloadStr = JSON.stringify({
          ...body,
          kioskId,
          timestamp: body.timestamp || new Date().toISOString(),
        });

        await env.PRINTBIT_STATE.put(`kiosk:${kioskId}`, payloadStr);
        await env.PRINTBIT_STATE.put('kiosk:latest', payloadStr);

        return new Response(
          JSON.stringify({
            success: true,
            kioskId,
            storedAt: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          }
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(
          JSON.stringify({ error: 'Invalid telemetry payload', details: message }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          }
        );
      }
    }

    // 2. Kiosk status endpoint: GET /api/kiosk-status
    if (url.pathname === '/api/kiosk-status') {
      if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      const kioskId = url.searchParams.get('kioskId') || 'printbit-kiosk-01';
      let raw = await env.PRINTBIT_STATE.get(`kiosk:${kioskId}`);
      if (!raw) {
        raw = await env.PRINTBIT_STATE.get('kiosk:latest');
      }

      if (!raw) {
        const fallback: KioskStatusResponse = createEmptyStatus(kioskId);
        return new Response(JSON.stringify(fallback), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      const data = JSON.parse(raw) as KioskTelemetryPayload;
      const ts = data.timestamp ? new Date(data.timestamp).getTime() : 0;
      const ageMs = ts > 0 ? Math.max(0, Date.now() - ts) : Infinity;
      const isOnline = ageMs < 90000;

      const statusResponse: KioskStatusResponse = {
        isOnline,
        ageMs,
        kioskId: data.kioskId || kioskId,
        timestamp: data.timestamp,
        status: data.status,
        uptimeSec: data.uptimeSec,
        hardware: data.hardware || {},
        summary: {
          earningsToday: data.summary?.earningsToday ?? 0,
          jobsToday: data.summary?.jobsToday ?? 0,
          owedChange: data.summary?.owedChange ?? 0,
          inkGrayscale: data.summary?.inkGrayscale ?? 100,
          inkColor: data.summary?.inkColor ?? 100,
          issues: data.summary?.issues || [],
        },
        data,
      };

      return new Response(JSON.stringify(statusResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    // 3. Fallback: GET /* serves self-contained dashboard HTML page
    const kioskId = url.searchParams.get('kioskId') || 'printbit-kiosk-01';
    let raw = await env.PRINTBIT_STATE.get(`kiosk:${kioskId}`);
    if (!raw) {
      raw = await env.PRINTBIT_STATE.get('kiosk:latest');
    }

    let initialStatus: KioskStatusResponse;
    if (raw) {
      try {
        const data = JSON.parse(raw) as KioskTelemetryPayload;
        const ts = data.timestamp ? new Date(data.timestamp).getTime() : 0;
        const ageMs = ts > 0 ? Math.max(0, Date.now() - ts) : Infinity;
        initialStatus = {
          isOnline: ageMs < 90000,
          ageMs,
          kioskId: data.kioskId || kioskId,
          timestamp: data.timestamp,
          status: data.status,
          uptimeSec: data.uptimeSec,
          hardware: data.hardware || {},
          summary: {
            earningsToday: data.summary?.earningsToday ?? 0,
            jobsToday: data.summary?.jobsToday ?? 0,
            owedChange: data.summary?.owedChange ?? 0,
            inkGrayscale: data.summary?.inkGrayscale ?? 100,
            inkColor: data.summary?.inkColor ?? 100,
            issues: data.summary?.issues || [],
          },
          data,
        };
      } catch {
        initialStatus = createEmptyStatus(kioskId);
      }
    } else {
      initialStatus = createEmptyStatus(kioskId);
    }

    const html = renderDashboardHtml(initialStatus);
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  },
};
