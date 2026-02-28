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
} from "./config/http";
import { registerStaticAssets } from "./middleware/static-assets";
import { registerFinancialRoutes } from "./routes/financial-routes";
import { registerPageRoutes } from "./routes/page-routes";
import { registerAdminRoutes } from "./routes/admin-routes";
import { registerUploadPortalRoutes } from "./routes/upload-portal-routes";
import { registerWirelessSessionRoutes } from "./routes/wireless-session-routes";
import { initDB } from "./services/db";
import { detectDefaultPrinter } from "./services/printer";
import { convertToPdfPreview } from "./services/preview";
import { getSerialStatus, initSerial } from "./services/serial";
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

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }

  return null;
}

const upload = multer({ dest: UPLOAD_DIR });
const wirelessUpload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 25 * 1024 * 1024 },
});

const sessionStore = new SessionStore(UPLOAD_DIR);

app.use(express.json());

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

io.on("connection", (socket) => {
  socket.on("joinSession", (sessionId: string) => {
    socket.join(`session:${sessionId}`);
  });
});

async function start() {
  await initDB();
  await detectDefaultPrinter();
  initSerial(io);

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
