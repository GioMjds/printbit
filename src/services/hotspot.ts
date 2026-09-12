import os from 'node:os';
import { exec } from 'node:child_process';
import {
  HOTSPOT_SSID,
  HOTSPOT_PASSWORD,
  HOTSPOT_AUTH_TYPE,
  ESP32_CAPTIVE_PORTAL_PATH,
  ESP32_AP_BASE_URL,
  ESP32_REGISTER_TOKEN,
  ESP32_KIOSK_SUBNET_PREFIX,
  ESP32_KIOSK_IP,
  PORT,
} from '@/config/http.config';
import { findMatchingIpv4ForSubnet, getLocalIPv4 } from '@/utils/network';
import { sendKioskIpAnnouncement } from './hardware-state-projection';
import {
  markWatchdogHeartbeat,
  setWatchdogComponentState,
} from './watchdog-health';
import { getPlatformWorkerFlags } from '@/config/platform-worker.config';
import {
  platformWorkerClient,
  type PlatformWorkerClient,
} from './platform-worker-client';
import { platformNetworkStateProjection } from './platform-network-state-projection';

const ESP32_REGISTER_ROUTE = '/kiosk/register';
const ESP32_REGISTER_INTERVAL_MS = 15_000;
const ESP32_REGISTER_TIMEOUT_MS = 2_500;

function isValidIpv4Address(value: string): boolean {
  const trimmed = value.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return false;
    const numeric = Number(part);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 255)
      return false;
  }
  return true;
}

function extractEsp32SubnetPrefix(): string | null {
  try {
    const baseUrl = new URL(ESP32_AP_BASE_URL);
    const host = baseUrl.hostname.trim();
    if (!isValidIpv4Address(host)) return null;
    const octets = host.split('.');
    return `${octets[0]}.${octets[1]}.${octets[2]}.`;
  } catch {
    return null;
  }
}

function ensureFirewallRules(): void {
  const rules = [{ name: 'PrintBit-Server-3000', port: 3000, proto: 'TCP' }];

  for (const { name, port, proto } of rules) {
    exec(
      `netsh advfirewall firewall show rule name="${name}"`,
      { timeout: 5_000, windowsHide: true },
      (checkErr, stdout) => {
        if (checkErr || (stdout && stdout.includes('No rules match'))) {
          exec(
            `netsh advfirewall firewall add rule name="${name}" dir=in action=allow protocol=${proto} localport=${port}`,
            { timeout: 5_000, windowsHide: true },
            (addErr) => {
              if (!addErr) {
                console.log(`[HOTSPOT] → Firewall rule added: ${name}`);
              }
            },
          );
        }
      },
    );
  }
}

export function detectEsp32KioskIp(
  customInterfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string | null {
  if (ESP32_KIOSK_IP && isValidIpv4Address(ESP32_KIOSK_IP)) {
    return ESP32_KIOSK_IP.trim();
  }

  const projectedIp = platformNetworkStateProjection.getSnapshot()?.kioskIp;
  if (projectedIp && isValidIpv4Address(projectedIp)) {
    return projectedIp.trim();
  }

  const preferredPrefixes: string[] = [];
  if (ESP32_KIOSK_SUBNET_PREFIX.trim().length > 0) {
    preferredPrefixes.push(ESP32_KIOSK_SUBNET_PREFIX.trim());
  }
  const esp32SubnetPrefix = extractEsp32SubnetPrefix();
  if (esp32SubnetPrefix && !preferredPrefixes.includes(esp32SubnetPrefix)) {
    preferredPrefixes.push(esp32SubnetPrefix);
  }

  for (const prefix of preferredPrefixes) {
    const match = findMatchingIpv4ForSubnet(prefix, customInterfaces);
    if (match) return match;
  }

  return getLocalIPv4(undefined, customInterfaces);
}

export async function registerKioskWithEsp32(
  targetIp?: string,
): Promise<boolean> {
  const kioskIp = targetIp?.trim() || detectEsp32KioskIp();

  if (!kioskIp) {
    console.warn(
      `[HOTSPOT] ⚠ ESP32 provider active, but kiosk IP could not be resolved for registration.`,
    );
    console.warn(
      `[HOTSPOT]   Set PRINTBIT_ESP32_KIOSK_IP in .env or verify kiosk is on the same LAN as the ESP32 base URL (${ESP32_AP_BASE_URL}).`,
    );
    return false;
  }

  // Also announce over serial in parallel if available
  sendKioskIpAnnouncement(kioskIp, PORT, ESP32_CAPTIVE_PORTAL_PATH);

  const requestUrl = new URL(ESP32_REGISTER_ROUTE, `${ESP32_AP_BASE_URL}/`);
  const payload = new URLSearchParams({
    token: ESP32_REGISTER_TOKEN,
    ip: kioskIp,
    port: String(PORT),
    path: ESP32_CAPTIVE_PORTAL_PATH,
  });
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    ESP32_REGISTER_TIMEOUT_MS,
  );

  try {
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: payload.toString(),
      signal: abortController.signal,
    });
    if (!response.ok) {
      console.warn(
        `[HOTSPOT] ⚠ ESP32 kiosk registration failed (${response.status}) at ${requestUrl.toString()}`,
      );
      return false;
    }
    console.log(
      `[HOTSPOT] ✓ ESP32 kiosk registration updated: ${kioskIp}:${PORT}${ESP32_CAPTIVE_PORTAL_PATH}`,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[HOTSPOT] ⚠ Could not register kiosk with ESP32 at ${requestUrl.toString()}: ${message}`,
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export type HotspotServiceDeps = {
  env?: NodeJS.ProcessEnv;
  workerClient?: PlatformWorkerClient;
  registerKiosk?: (targetIp?: string) => Promise<boolean>;
  ensureFirewall?: () => void;
  logger?: {
    log: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
};

export class HotspotService {
  private running = false;
  private esp32RegistrationTimer: NodeJS.Timeout | null = null;
  private lastRegisteredIp: string | null = null;
  private readonly deps: {
    env?: NodeJS.ProcessEnv;
    workerClient?: PlatformWorkerClient;
    registerKiosk: (targetIp?: string) => Promise<boolean>;
    ensureFirewall: () => void;
    logger: {
      log: (message: string) => void;
      warn: (message: string) => void;
      error: (message: string) => void;
    };
  };

  constructor(deps: HotspotServiceDeps = {}) {
    this.deps = {
      env: deps.env,
      workerClient: deps.workerClient,
      registerKiosk: deps.registerKiosk ?? registerKioskWithEsp32,
      ensureFirewall: deps.ensureFirewall ?? ensureFirewallRules,
      logger: deps.logger ?? console,
    };
  }

  private stopEsp32RegistrationLoop(): void {
    if (this.esp32RegistrationTimer) {
      clearInterval(this.esp32RegistrationTimer);
      this.esp32RegistrationTimer = null;
    }
  }

  private async startEsp32RegistrationLoop(): Promise<void> {
    this.stopEsp32RegistrationLoop();

    const initialIp = detectEsp32KioskIp();
    const registered = await this.deps.registerKiosk(initialIp ?? undefined);
    if (registered && initialIp) {
      this.lastRegisteredIp = initialIp;
    }

    this.esp32RegistrationTimer = setInterval(async () => {
      const currentIp = detectEsp32KioskIp();
      const needsImmediateUpdate =
        Boolean(currentIp) && currentIp !== this.lastRegisteredIp;

      const success = await this.deps.registerKiosk(currentIp ?? undefined);
      if (success && currentIp) {
        if (needsImmediateUpdate) {
          this.deps.logger.log(
            `[HOTSPOT] → Kiosk IP changed from ${this.lastRegisteredIp ?? 'none'} to ${currentIp}; ESP32 updated.`,
          );
        }
        this.lastRegisteredIp = currentIp;
      }
    }, ESP32_REGISTER_INTERVAL_MS);
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) {
      this.deps.logger.log('[HOTSPOT] Already running — skipping');
      markWatchdogHeartbeat('hotspot', { running: true, provider: 'esp32' });
      setWatchdogComponentState(
        'hotspot',
        'healthy',
        'Hotspot already running.',
        {
          running: true,
          provider: 'esp32',
        },
      );
      return;
    }

    const flags = getPlatformWorkerFlags(this.deps.env);
    if (flags.networking) {
      const client = this.deps.workerClient ?? platformWorkerClient;
      const prefixes: string[] = [];
      if (ESP32_KIOSK_SUBNET_PREFIX.trim().length > 0) {
        prefixes.push(ESP32_KIOSK_SUBNET_PREFIX.trim());
      }
      const esp32SubnetPrefix = extractEsp32SubnetPrefix();
      if (esp32SubnetPrefix && !prefixes.includes(esp32SubnetPrefix)) {
        prefixes.push(esp32SubnetPrefix);
      }

      let response;
      try {
        response = await client.prepareHotspotPlatform({
          preferredSubnetPrefixes: prefixes,
          port: PORT,
        });
      } catch {
        response = null;
      }

      if (response && response.errorCode !== 'NOT_IMPLEMENTED') {
        platformNetworkStateProjection.apply({
          kioskIp: response.kioskIp ?? null,
          firewallReady: response.firewallReady,
          detail: response.detail ?? null,
        });
      } else {
        this.deps.logger.warn(
          '[HOTSPOT] Worker backend unavailable; using temporary Node fallback.',
        );
        this.deps.ensureFirewall();
      }
    } else {
      this.deps.ensureFirewall();
    }

    this.running = true;
    this.deps.logger.log('[HOTSPOT] ESP32 provider enabled');
    void this.startEsp32RegistrationLoop().catch((error) => {
      this.deps.logger.warn(
        `[HOTSPOT] Initial registration attempt failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    markWatchdogHeartbeat('hotspot', { running: true, provider: 'esp32' });
    setWatchdogComponentState(
      'hotspot',
      'healthy',
      'ESP32 provider mode active.',
      {
        running: true,
        provider: 'esp32',
      },
    );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stopEsp32RegistrationLoop();
    this.deps.logger.log('[HOTSPOT] ESP32 provider stop requested');
    markWatchdogHeartbeat('hotspot', { running: false, provider: 'esp32' });
    setWatchdogComponentState(
      'hotspot',
      'degraded',
      'ESP32 provider stop requested.',
      {
        running: false,
        provider: 'esp32',
      },
    );
  }
}

export function createHotspotService(
  deps: HotspotServiceDeps = {},
): HotspotService {
  return new HotspotService(deps);
}

export const hotspotService = createHotspotService();

export async function startHotspot(): Promise<void> {
  return hotspotService.start();
}
export function stopHotspot(): void {
  hotspotService.stop();
}
export function isHotspotRunning(): boolean {
  return hotspotService.isRunning();
}

export type HotspotConfigPayload = {
  provider: 'esp32';
  ssid: string;
  password: string;
  authType: string;
  captivePortalPath: string;
  startsManagedHotspot: boolean;
};

export function getHotspotConfig(): HotspotConfigPayload {
  return {
    provider: 'esp32',
    ssid: HOTSPOT_SSID,
    password: HOTSPOT_PASSWORD,
    authType: HOTSPOT_AUTH_TYPE,
    captivePortalPath: ESP32_CAPTIVE_PORTAL_PATH,
    startsManagedHotspot: false,
  };
}
