import path from 'node:path';
import os from 'os';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import multer from 'multer';
import {
  PORT,
  PORTAL_ASSETS,
  PORTAL_DIR,
  PUBLIC_PAGE_ROUTES,
  UPLOAD_DIR,
  HOTSPOT_SSID,
  HOTSPOT_PASSWORD,
  CAPTIVE_PORTAL_ENABLED,
} from '@/config';
import {
  registerStaticAssets,
  createCaptivePortalMiddleware,
} from '@/middleware';
import {
  registerFinancialRoutes,
  registerPageRoutes,
  registerAdminRoutes,
  registerFeedbackRoutes,
  registerReportRoutes,
  registerUploadPortalRoutes,
  registerWirelessSessionRoutes,
  registerScanRoutes,
  registerCopyRoutes,
} from '@/routes';
import {
  initDB,
  detectDefaultPrinter,
  detectScanner,
  startScanStorageCleanup,
  convertToPdfPreview,
  getHopperStatus,
  getSerialStatus,
  initSerial,
  startHotspot,
  stopHotspot,
  isHotspotRunning,
  SessionStore,
  renderUploadPortal,
  resolvePublicBaseUrl,
  runHopperSelfTest,
  startPrinterMonitor,
} from '@/services';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

function getLocalIPv4(): string | null {
  const interfaces = os.networkInterfaces();
  let fallback: string | null = null;

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family !== 'IPv4' || iface.internal) continue;

      // Prefer hotspot adapter: MyPublicWiFi (192.168.5.x) or Windows Mobile Hotspot (192.168.137.x)
      const isHotspot =
        /Wi-Fi Direct|Local Area Connection\*/i.test(name) ||
        iface.address.startsWith('192.168.5.') ||
        iface.address.startsWith('192.168.137.');
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

const ALLOWED_REPORT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const reportIssueUpload = multer({
  dest: path.join(UPLOAD_DIR, 'report-issues'),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_REPORT_IMAGE_TYPES.has(file.mimetype));
  },
});

const sessionStore = new SessionStore(UPLOAD_DIR);

app.use(express.json());

// Captive-portal middleware — fallback for direct captive probes on port 3000
if (CAPTIVE_PORTAL_ENABLED) {
  app.use(createCaptivePortalMiddleware(sessionStore));
}

// Hotspot config API (used by print page to generate Wi-Fi QR)
app.get('/api/config/hotspot', (_req, res) => {
  res.json({ ssid: HOTSPOT_SSID, password: HOTSPOT_PASSWORD });
});

// On-demand hotspot control (called by print page when session starts)
app.post('/api/hotspot/start', async (_req, res) => {
  try {
    await startHotspot();
    res.json({ ok: true, running: isHotspotRunning() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.post('/api/hotspot/stop', (_req, res) => {
  stopHotspot();
  res.json({ ok: true });
});

// Active session API
app.get('/api/session/active', (_req, res) => {
  const token = sessionStore.getActiveSessionToken();
  if (token) {
    const localIP = getLocalIPv4() ?? '192.168.5.1';
    const uploadUrl = `http://${localIP}:${PORT}/upload/${encodeURIComponent(token)}`;
    res.json({ token, uploadUrl });
  } else {
    res.status(404).json({ error: 'No active session' });
  }
});

registerPageRoutes(app, {
  sessionStore,
  publicPageRoutes: PUBLIC_PAGE_ROUTES,
  resolvePublicBaseUrl,
});
registerStaticAssets(app);
registerAdminRoutes(app, {
  io,
  uploadDir: UPLOAD_DIR,
  getSerialStatus,
  getHopperStatus,
  runHopperSelfTest,
});
registerFeedbackRoutes(app, { resolvePublicBaseUrl });
registerReportRoutes(app, {
  resolvePublicBaseUrl,
  reportIssueUploadSingle: reportIssueUpload.single('file'),
});
registerFinancialRoutes(app, {
  io,
  sessionStore,
  uploadSingle: upload.single('file'),
  resolvePublicBaseUrl,
});
registerUploadPortalRoutes(app, {
  portalDir: PORTAL_DIR,
  portalAssets: PORTAL_ASSETS,
  renderUploadPortal,
  sessionStore,
});
registerWirelessSessionRoutes(app, {
  io,
  sessionStore,
  wirelessUploadSingle: wirelessUpload.single('file'),
  resolvePublicBaseUrl,
  convertToPdfPreview,
});
registerScanRoutes(app, { io, resolvePublicBaseUrl });
registerCopyRoutes(app, { io });

io.on('connection', (socket) => {
  socket.on('joinSession', (sessionId: string) => {
    socket.join(`session:${sessionId}`);
  });
});

async function start() {
  await initDB();
  await detectDefaultPrinter();
  await detectScanner();
  startScanStorageCleanup();
  await initSerial(io);
  await runHopperSelfTest();

  startPrinterMonitor(io);

  // Launch MyPublicWiFi hotspot on startup (idempotent — Print page can re-call safely)
  await startHotspot();

  server.listen(PORT, '0.0.0.0', () => {
    const localIP = getLocalIPv4();
    if (localIP) {
      console.log(`→ Network: http://${localIP}:${PORT}`);
    } else {
      console.log('→ Network IP not detected');
    }
  });
}

start();
