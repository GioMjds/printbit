import os from "os";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import multer from "multer";
import {
  PORT,
  PORTAL_ASSETS,
  PORTAL_DIR,
  PUBLIC_PAGE_ROUTES,
  UPLOAD_DIR,
  HOTSPOT_SSID,
  HOTSPOT_PASSWORD,
  CAPTIVE_PORTAL_ENABLED,
} from "./config/http";
import { registerStaticAssets } from "./middleware/static-assets";
import { createCaptivePortalMiddleware } from "./middleware/captive-portal";
import { registerFinancialRoutes } from "./routes/financial-routes";
import { registerPageRoutes } from "./routes/page-routes";
import { registerAdminRoutes } from "./routes/admin-routes";
import { registerUploadPortalRoutes } from "./routes/upload-portal-routes";
import { registerWirelessSessionRoutes } from "./routes/wireless-session-routes";
import { registerScanRoutes } from "./routes/scan-routes";
import { registerCopyRoutes } from "./routes/copy-routes";
import { initDB } from "./services/db";
import { detectDefaultPrinter } from "./services/printer";
import { detectScanner } from "./services/scanner";
import { convertToPdfPreview } from "./services/preview";
import { getSerialStatus, initSerial } from "./services/serial";
import {
  startHotspot,
  stopHotspot,
  isHotspotRunning,
} from "./services/hotspot";
import {
  SessionStore,
  renderUploadPortal,
  resolvePublicBaseUrl,
} from "./services/session";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

function getLocalIPv4(): string | null {
  const interfaces = os.networkInterfaces();
  let fallback: string | null = null;

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family !== "IPv4" || iface.internal) continue;

      // Prefer hotspot adapter: MyPublicWiFi (192.168.5.x) or Windows Mobile Hotspot (192.168.137.x)
      const isHotspot =
        /Wi-Fi Direct|Local Area Connection\*/i.test(name) ||
        iface.address.startsWith("192.168.5.") ||
        iface.address.startsWith("192.168.137.");
      if (isHotspot) return iface.address;

      if (!fallback) fallback = iface.address;
    }
  }

  return fallback;
}

const upload = multer({ dest: UPLOAD_DIR });
const wirelessUpload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 25 * 1024 * 1024 },
});

const sessionStore = new SessionStore(UPLOAD_DIR);

app.use(express.json());

// Captive-portal middleware — fallback for direct captive probes on port 3000
if (CAPTIVE_PORTAL_ENABLED) {
  app.use(createCaptivePortalMiddleware(sessionStore));
}

// Hotspot config API (used by print page to generate Wi-Fi QR)
app.get("/api/config/hotspot", (_req, res) => {
  res.json({ ssid: HOTSPOT_SSID, password: HOTSPOT_PASSWORD });
});

// On-demand hotspot control (called by print page when session starts)
app.post("/api/hotspot/start", async (_req, res) => {
  try {
    await startHotspot();
    res.json({ ok: true, running: isHotspotRunning() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.post("/api/hotspot/stop", (_req, res) => {
  stopHotspot();
  res.json({ ok: true });
});

// Active session API
app.get("/api/session/active", (_req, res) => {
  const token = sessionStore.getActiveSessionToken();
  if (token) {
    const localIP = getLocalIPv4() ?? "192.168.5.1";
    const uploadUrl = `http://${localIP}:${PORT}/upload/${encodeURIComponent(token)}`;
    res.json({ token, uploadUrl });
  } else {
    res.status(404).json({ error: "No active session" });
  }
});

// Portal bridge page — captive portal webviews can't handle file uploads,
// so this page guides users to open the upload URL in their real browser.
app.get("/portal", (req, res) => {
  const token = sessionStore.getActiveSessionToken();
  const localIP = getLocalIPv4() ?? "192.168.5.1";

  if (!token) {
    res
      .status(200)
      .type("html")
      .send(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PrintBit</title>` +
          `<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0f2f5;margin:0}` +
          `.c{background:#fff;border-radius:16px;padding:2rem;max-width:360px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}` +
          `h2{margin-bottom:.5rem}p{color:#666;font-size:.95rem}</style></head>` +
          `<body><div class="c"><h2>📄 PrintBit Kiosk</h2><p>Please start a Print session on the kiosk screen first, then reconnect.</p></div></body></html>`,
      );
    return;
  }

  const uploadPath = `/upload/${encodeURIComponent(token)}`;
  const uploadUrl = `http://${localIP}:${PORT}${uploadPath}`;

  const ua = (req.get("User-Agent") ?? "").toLowerCase();
  const isAndroid = ua.includes("android");
  const isIOS = /iphone|ipad|ipod/.test(ua);

  // Android: intent:// URI opens real Chrome from inside the captive portal webview
  const intentUrl = `intent://${localIP}:${PORT}${uploadPath}#Intent;scheme=http;package=com.android.chrome;end`;

  res.status(200).type("html").send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>PrintBit – Upload</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f0f2f5; display: flex; align-items: center; justify-content: center;
    min-height: 100vh; color: #333;
  }
  .card {
    background: #fff; border-radius: 16px; padding: 1.75rem; max-width: 380px;
    width: 92%; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.08);
  }
  .icon { font-size: 2rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.25rem; margin-bottom: 0.25rem; }
  .sub { color: #666; font-size: 0.9rem; margin-bottom: 1.25rem; }
  .open-btn {
    display: block; width: 100%; padding: 14px; background: #1a73e8; color: #fff;
    border: none; border-radius: 12px; font-size: 1rem; font-weight: 600;
    text-decoration: none; cursor: pointer; margin-bottom: 0.75rem;
    box-shadow: 0 2px 8px rgba(26,115,232,0.3); text-align: center;
  }
  .open-btn:active { transform: scale(0.97); opacity: 0.9; }
  .divider { display: flex; align-items: center; gap: 0.75rem; margin: 1rem 0; color: #aaa; font-size: 0.8rem; }
  .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: #e0e0e0; }
  .url-row {
    display: flex; align-items: center; gap: 8px; background: #f5f5f5;
    border-radius: 10px; padding: 10px 12px; margin-bottom: 0.5rem;
  }
  .url-text {
    flex: 1; font-family: 'SF Mono', 'Consolas', monospace; font-size: 0.8rem;
    color: #333; word-break: break-all; text-align: left; line-height: 1.3;
    user-select: all; -webkit-user-select: all;
  }
  .copy-btn {
    flex-shrink: 0; padding: 8px 14px; background: #e8e8e8; border: none;
    border-radius: 8px; font-size: 0.8rem; font-weight: 600; color: #333;
    cursor: pointer; white-space: nowrap;
  }
  .copy-btn:active { background: #d0d0d0; }
  .copy-btn.copied { background: #d4edda; color: #155724; }
  .steps { text-align: left; margin: 1rem 0 0.5rem; padding: 0; list-style: none; }
  .steps li {
    position: relative; padding: 0.4rem 0 0.4rem 2rem; font-size: 0.85rem; color: #555; line-height: 1.4;
  }
  .steps li::before {
    content: attr(data-step); position: absolute; left: 0; top: 0.35rem;
    width: 1.4rem; height: 1.4rem; background: #1a73e8; color: #fff;
    border-radius: 50%; font-size: 0.7rem; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .note { color: #999; font-size: 0.75rem; margin-top: 0.75rem; line-height: 1.4; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">✅</div>
  <h2>Connected to PrintBit!</h2>
  <p class="sub">Open the upload page in your browser to send files.</p>

  ${
    isAndroid
      ? `
  <!-- Android: intent:// opens real Chrome from captive portal webview -->
  <a class="open-btn" href="${intentUrl}">
    Open in Chrome
  </a>
  `
      : `
  <a class="open-btn" id="openBtn" href="${uploadUrl}">
    Open Upload Page
  </a>
  `
  }

  <div class="divider">or copy the link</div>

  <div class="url-row">
    <span class="url-text" id="urlText">${uploadUrl}</span>
    <button type="button" class="copy-btn" id="copyBtn">Copy</button>
  </div>

  ${
    isIOS
      ? `
  <ol class="steps">
    <li data-step="1">Tap <strong>Copy</strong> above</li>
    <li data-step="2">Tap <strong>Done</strong> (top-right corner) to close this popup</li>
    <li data-step="3">Open <strong>Safari</strong> and paste the URL</li>
  </ol>
  `
      : !isAndroid
        ? `
  <ol class="steps">
    <li data-step="1">Tap <strong>Copy</strong> above</li>
    <li data-step="2">Close this popup</li>
    <li data-step="3">Open your browser and paste the URL</li>
  </ol>
  `
        : ``
  }

  <p class="note">
    ${
      isAndroid
        ? "If Chrome does not open, copy the URL above and paste it in your browser."
        : "The upload page needs a real browser to select files from your phone."
    }
  </p>
</div>
<script>
(function() {
  var url = '${uploadUrl}';
  var copyBtn = document.getElementById('copyBtn');

  copyBtn.addEventListener('click', function() {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, fallback);
    } else {
      fallback();
    }
  });

  function done() {
    copyBtn.textContent = '✓ Copied';
    copyBtn.classList.add('copied');
    setTimeout(function() {
      copyBtn.textContent = 'Copy';
      copyBtn.classList.remove('copied');
    }, 3000);
  }

  function fallback() {
    // Fallback for restricted webviews where clipboard API is blocked
    var ta = document.createElement('textarea');
    ta.value = url;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch(e) {
      // Select the URL text so user can manually copy
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(document.getElementById('urlText'));
      sel.removeAllRanges();
      sel.addRange(range);
      copyBtn.textContent = 'Selected!';
      setTimeout(function() { copyBtn.textContent = 'Copy'; }, 3000);
    }
    document.body.removeChild(ta);
  }
})();
</script>
</body>
</html>`);
});

registerPageRoutes(app, {
  sessionStore,
  publicPageRoutes: PUBLIC_PAGE_ROUTES,
  resolvePublicBaseUrl,
});
registerStaticAssets(app);
registerAdminRoutes(app, {
  uploadDir: UPLOAD_DIR,
  getSerialStatus,
});
registerFinancialRoutes(app, {
  io,
  sessionStore,
  uploadSingle: upload.single("file"),
  resolvePublicBaseUrl,
});
registerUploadPortalRoutes(app, {
  portalDir: PORTAL_DIR,
  portalAssets: PORTAL_ASSETS,
  renderUploadPortal,
});
registerWirelessSessionRoutes(app, {
  io,
  sessionStore,
  wirelessUploadSingle: wirelessUpload.single("file"),
  resolvePublicBaseUrl,
  convertToPdfPreview,
});
registerScanRoutes(app);
registerCopyRoutes(app, { io });

io.on("connection", (socket) => {
  socket.on("joinSession", (sessionId: string) => {
    socket.join(`session:${sessionId}`);
  });
});

async function start() {
  await initDB();
  await detectDefaultPrinter();
  await detectScanner();
  initSerial(io);

  // Launch MyPublicWiFi hotspot on startup (idempotent — Print page can re-call safely)
  await startHotspot();

  server.listen(PORT, "0.0.0.0", () => {
    const localIP = getLocalIPv4();
    if (localIP) {
      console.log(`→ Network: http://${localIP}:${PORT}`);
    } else {
      console.log("→ Network IP not detected");
    }
  });
}

start();
