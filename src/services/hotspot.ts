import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn, ChildProcess } from "node:child_process";
import {
  MYPUBLICWIFI_PATH,
  HOTSPOT_SSID,
  HOTSPOT_PASSWORD,
  PORT,
} from "../config/http";

const MPWF_EXE = path.join(MYPUBLICWIFI_PATH, "MyPublicWiFi.exe");
const MPWF_DB = path.join(MYPUBLICWIFI_PATH, "Data.db");
const MPWF_LOGIN = path.join(MYPUBLICWIFI_PATH, "Web", "login.html");
const MPWF_LOGIN_BACKUP = path.join(MYPUBLICWIFI_PATH, "Web", "login.html.bak");

function ipToInt32(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3] | 0;
}

function configureDatabase(): void {
  if (!fs.existsSync(MPWF_DB)) {
    console.warn("⚠ MyPublicWiFi Data.db not found:", MPWF_DB);
    return;
  }

  const routerIp = "192.168.5.1";
  const updates: Record<string, string | number> = {
    NetworkSSID: HOTSPOT_SSID,
    NetworkKey: HOTSPOT_PASSWORD,
    AuthenticationEnabled: "N",
    TOCGuestAuthenticationEnabled: "N",
    AutoHotspotStartEnabled: "Y",
    LocalHostAccessDisabled: "N",
    DhcpForceDNS: "N",
    DhcpRouterIP: ipToInt32(routerIp),
    DhcpNetMask: ipToInt32("255.255.255.0"),
    DhcpStartIP: ipToInt32("192.168.5.2"),
    DhcpEndIP: ipToInt32("192.168.5.254"),
  };

  const setClauses = Object.entries(updates)
    .map(([col, val]) => {
      const v = typeof val === "string" ? `'${val.replace(/'/g, "''")}'` : val;
      return `${col}=${v}`;
    })
    .join(", ");

  const sql = `UPDATE HotspotSettings SET ${setClauses} WHERE ID=1;`;

  const pyScript = path.join(os.tmpdir(), "printbit-config-mpwf.py");
  try {
    fs.writeFileSync(
      pyScript,
      [
        "import sqlite3",
        `c = sqlite3.connect(r'${MPWF_DB}')`,
        `c.execute("""${sql}""")`,
        "c.commit()",
        "c.close()",
      ].join("\n"),
    );
    execSync(`python "${pyScript}"`, { timeout: 10_000, stdio: "pipe" });
    console.log(`[HOTSPOT] ✓ MyPublicWiFi configured: SSID=${HOTSPOT_SSID}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[HOTSPOT] ⚠ Could not configure Data.db:", msg);
  } finally {
    try {
      fs.unlinkSync(pyScript);
    } catch {
      /* cleanup */
    }
  }
}

function ensureFirewallRules(): void {
  const rules = [{ name: "PrintBit-Server-3000", port: 3000, proto: "TCP" }];

  for (const { name, port, proto } of rules) {
    try {
      const check = execSync(
        `netsh advfirewall firewall show rule name="${name}"`,
        { stdio: "pipe", timeout: 5_000, encoding: "utf-8" },
      );
      if (check.includes("No rules match")) throw new Error("missing");
    } catch {
      try {
        execSync(
          `netsh advfirewall firewall add rule name="${name}" dir=in action=allow protocol=${proto} localport=${port}`,
          { stdio: "ignore", timeout: 5_000 },
        );
        console.log(`[HOTSPOT] → Firewall rule added: ${name}`);
      } catch {
        /* not admin or exists */
      }
    }
  }
}

class HotspotService {
  private running = false;
  private process: ChildProcess | null = null;

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) {
      console.log("[HOTSPOT] Already running — skipping");
      return;
    }

    if (!fs.existsSync(MPWF_EXE)) {
      console.warn("[HOTSPOT] ⚠ MyPublicWiFi not found at:", MYPUBLICWIFI_PATH, "\n[HOTSPOT]   Install from https://mypublicwifi.com or set PRINTBIT_MYPUBLICWIFI_PATH");
      return;
    }

    console.log("[HOTSPOT] ── Configuring MyPublicWiFi ──────────────────────");
    ensureFirewallRules();
    configureDatabase();

    try {
      execSync('tasklist /FI "IMAGENAME eq MyPublicWiFi.exe" /NH', { encoding: "utf-8", timeout: 5_000, stdio: "pipe" }).includes("MyPublicWiFi.exe") &&
        execSync("taskkill /F /IM MyPublicWiFi.exe", { stdio: "ignore", timeout: 5_000 });
    } catch { /* not running */ }

    this.process = spawn("cmd", ["/c", "start", "", MPWF_EXE], { cwd: MYPUBLICWIFI_PATH, detached: true, stdio: "ignore", windowsHide: false });
    this.process.unref();
    this.process.on("error", (err) => {
      console.warn("[HOTSPOT] ⚠ Failed to launch MyPublicWiFi:", err.message);
      this.running = false;
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    this.running = true;
    console.log("[HOTSPOT] ✓ MyPublicWiFi launched — hotspot starting");
  }

  stop(): void {
    if (!this.running) return;
    try {
      execSync("taskkill /F /IM MyPublicWiFi.exe", { stdio: "ignore", timeout: 5_000 });
    } catch { /* not running */ }
    this.process = null;
    this.running = false;
    console.log("[HOTSPOT] ✗ MyPublicWiFi stopped");
  }
}

export const hotspotService = new HotspotService();

export async function startHotspot(): Promise<void> { return hotspotService.start(); }
export function stopHotspot(): void { hotspotService.stop(); }
export function isHotspotRunning(): boolean { return hotspotService.isRunning(); }
