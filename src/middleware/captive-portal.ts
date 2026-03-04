import type { Request, Response, NextFunction } from "express";
import type { SessionStore } from "../services/session";
import { CAPTIVE_PORTAL_ENABLED } from "../config/http";

const IOS_SUCCESS_HTML =
  "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>";

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

export function createCaptivePortalMiddleware(_sessionStore: SessionStore) {
  return function captivePortal(req: Request, res: Response, next: NextFunction): void {
    if (!CAPTIVE_PORTAL_ENABLED) { next(); return; }

    const host = (req.hostname ?? "").toLowerCase();
    const pathname = req.path.toLowerCase();

    const isCaptiveProbe = CAPTIVE_HOSTS.has(host) || CAPTIVE_PATHS.has(pathname);
    if (!isCaptiveProbe) { next(); return; }

    if (
      pathname === "/hotspot-detect.html" ||
      pathname === "/library/test/success.html"
    ) {
      res.status(200).type("html").send(IOS_SUCCESS_HTML);
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
      res.status(200).type("html").send(IOS_SUCCESS_HTML);
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
