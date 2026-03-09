import type { Request, Response, NextFunction } from "express";
import type { SessionStore } from "../services/session";
import { CAPTIVE_PORTAL_ENABLED } from "../config/http";
import { adminService } from "../services/admin";

const CAPTIVE_PATHS = new Set([
  "/hotspot-detect.html",
  "/library/test/success.html",
  "/generate_204",
  "/gen_204",
  "/connecttest.txt",
  "/ncsi.txt",
  "/success.txt",
  "/redirect",
  "/canonical.html",
  "/check_network_status.txt",
]);

// iOS-specific probe paths — redirect to /portal so the captive sheet
// shows the guided bridge page instead of silently dismissing.
const IOS_PROBE_PATHS = new Set([
  "/hotspot-detect.html",
  "/library/test/success.html",
]);

const CAPTIVE_HOSTS = new Set([
  "captive.apple.com",
  "www.apple.com",
  "connectivitycheck.gstatic.com",
  "clients3.google.com",
  "www.msftconnecttest.com",
  "www.msftncsi.com",
  "detectportal.firefox.com",
  "nmcheck.gnome.org",
  "network-test.debian.org",
]);

const APPLE_HOSTS = new Set([
  "captive.apple.com",
  "www.apple.com",
]);

export function createCaptivePortalMiddleware(_sessionStore: SessionStore) {
  return function captivePortal(req: Request, res: Response, next: NextFunction): void {
    if (!CAPTIVE_PORTAL_ENABLED) { next(); return; }

    const host = (req.hostname ?? "").toLowerCase();
    const pathname = req.path.toLowerCase();

    const isCaptiveProbe = CAPTIVE_HOSTS.has(host) || CAPTIVE_PATHS.has(pathname);
    if (!isCaptiveProbe) { next(); return; }

    // iOS probes: redirect to /portal so the captive sheet shows guided upload instructions.
    // Exclude /portal itself to prevent an infinite redirect loop when Apple hosts
    // proxy the request (common with DNS-hijack captive portals).
    if ((IOS_PROBE_PATHS.has(pathname) || APPLE_HOSTS.has(host)) && pathname !== "/portal") {
      void adminService.appendAdminLog("captive_ios_redirect", "iOS captive probe redirected to /portal.", {
        path: pathname,
        host,
      });
      res.redirect(302, "/portal");
      return;
    }

    if (pathname === "/generate_204" || pathname === "/gen_204") {
      res.status(204).end();
      return;
    }

    if (pathname === "/connecttest.txt") {
      res.status(200).type("text").send("Microsoft Connect Test");
      return;
    }

    if (pathname === "/ncsi.txt") {
      res.status(200).type("text").send("Microsoft NCSI");
      return;
    }

    if (pathname === "/success.txt") {
      res.status(200).type("text").send("success\n");
      return;
    }

    if (pathname === "/canonical.html" || pathname === "/redirect") {
      res.redirect(302, "/portal");
      return;
    }

    if (pathname === "/check_network_status.txt") {
      res.status(200).type("text").send("NetworkCheck");
      return;
    }

    if (CAPTIVE_HOSTS.has(host)) {
      res.status(204).end();
      return;
    }

    next();
  };
}
