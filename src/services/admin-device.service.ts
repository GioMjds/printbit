import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { db } from './db';
import type {
  AdminDeviceEntry,
  AdminDeviceSeverity,
} from '@/modules/admin/admin.schema';

export const ADMIN_DEVICE_COOKIE = 'adminDevice';
export const MAX_ADMIN_DEVICES = 20;
export const MAX_DEVICE_LABEL_LENGTH = 40;
export const DEVICE_COOKIE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_COOKIE_LENGTH = 200;

export const DEVICE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  maxAge: DEVICE_COOKIE_TTL_MS,
};

export class AdminDeviceValidationError extends Error {}

export interface AdminDeviceServiceDeps {
  getDbData?: () => typeof db.data;
  writeDb?: () => Promise<void>;
  now?: () => number;
}

export interface AdminDeviceView {
  id: string;
  label: string;
  minSeverity: AdminDeviceSeverity;
  lastSeenAt: string;
  isCurrent: boolean;
  hasPush: boolean;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function normalizeLabel(label: unknown): string {
  if (typeof label !== 'string') return '';
  return label.trim().slice(0, MAX_DEVICE_LABEL_LENGTH).trim();
}

export function defaultLabelFromUserAgent(ua: string): string {
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  return browser ? `${os} ${browser}` : os;
}

export class AdminDeviceService {
  private readonly deps: Required<AdminDeviceServiceDeps>;

  constructor(deps: AdminDeviceServiceDeps = {}) {
    this.deps = {
      getDbData: deps.getDbData ?? (() => db.data),
      writeDb: deps.writeDb ?? (() => db.write()),
      now: deps.now ?? (() => Date.now()),
    };
  }

  private data() {
    const data = this.deps.getDbData();
    if (!data) throw new Error('Database not initialized');
    if (!data.adminDevices) data.adminDevices = [];
    if (!data.adminPushSubscriptions) data.adminPushSubscriptions = [];
    return data;
  }

  private removeDevices(ids: Set<string>): void {
    const data = this.data();
    data.adminDevices = data.adminDevices.filter((d) => !ids.has(d.id));
    data.adminPushSubscriptions = data.adminPushSubscriptions.filter(
      (s) => !s.deviceId || !ids.has(s.deviceId),
    );
  }

  private evictOverflow(keepId: string): void {
    const data = this.data();
    while (data.adminDevices.length > MAX_ADMIN_DEVICES) {
      let oldest: AdminDeviceEntry | null = null;
      for (const device of data.adminDevices) {
        if (device.id === keepId) continue;
        if (
          !oldest ||
          Date.parse(device.lastSeenAt) < Date.parse(oldest.lastSeenAt)
        ) {
          oldest = device;
        }
      }
      if (!oldest) return;
      this.removeDevices(new Set([oldest.id]));
    }
  }

  async enroll(
    label: string | undefined,
    userAgent: string,
  ): Promise<{ device: AdminDeviceEntry; cookieValue: string }> {
    const data = this.data();
    const nowIso = new Date(this.deps.now()).toISOString();
    const secret = randomBytes(32).toString('base64url');
    const device: AdminDeviceEntry = {
      id: randomUUID(),
      label: normalizeLabel(label) || defaultLabelFromUserAgent(userAgent),
      tokenHash: hashSecret(secret),
      minSeverity: 'warning',
      createdAt: nowIso,
      lastSeenAt: nowIso,
    };
    data.adminDevices.push(device);
    this.evictOverflow(device.id);
    await this.deps.writeDb();
    return { device, cookieValue: `${device.id}.${secret}` };
  }

  async verifyCookie(cookieValue: unknown): Promise<AdminDeviceEntry | null> {
    if (
      typeof cookieValue !== 'string' ||
      cookieValue.length > MAX_COOKIE_LENGTH
    ) {
      return null;
    }
    const dot = cookieValue.indexOf('.');
    if (dot <= 0) return null;
    const id = cookieValue.slice(0, dot);
    const secret = cookieValue.slice(dot + 1);
    if (!secret) return null;

    const device = this.data().adminDevices.find((d) => d.id === id);
    if (!device) return null;

    const presented = Buffer.from(hashSecret(secret), 'hex');
    const stored = Buffer.from(device.tokenHash, 'hex');
    if (
      presented.length !== stored.length ||
      !timingSafeEqual(presented, stored)
    ) {
      return null;
    }

    const now = this.deps.now();
    const lastSeen = Date.parse(device.lastSeenAt);
    const idleMs = Number.isFinite(lastSeen) ? now - lastSeen : Infinity;
    if (idleMs > DEVICE_COOKIE_TTL_MS) return null;
    await this.touchDevice(device);
    // The device may have been revoked while the write was in flight.
    return this.getById(device.id) ? device : null;
  }

  private async touchDevice(device: AdminDeviceEntry): Promise<boolean> {
    const now = this.deps.now();
    const lastSeen = Date.parse(device.lastSeenAt);
    const idleMs = Number.isFinite(lastSeen) ? now - lastSeen : Infinity;
    if (idleMs <= TOUCH_INTERVAL_MS) return false;
    device.lastSeenAt = new Date(now).toISOString();
    await this.deps.writeDb();
    return true;
  }

  /** Throttled lastSeenAt bump (5 min). Resolves true only if it wrote. */
  async touch(id: string): Promise<boolean> {
    const device = this.getById(id);
    if (!device) return false;
    return this.touchDevice(device);
  }

  async resolveOrEnroll(
    cookieValue: unknown,
    label: string | undefined,
    userAgent: string,
  ): Promise<{ device: AdminDeviceEntry; cookieValue: string }> {
    const existing = await this.verifyCookie(cookieValue);
    if (existing && typeof cookieValue === 'string') {
      return { device: existing, cookieValue };
    }
    return this.enroll(label, userAgent);
  }

  getById(id: string): AdminDeviceEntry | null {
    return this.data().adminDevices.find((d) => d.id === id) ?? null;
  }

  list(currentId?: string): AdminDeviceView[] {
    const data = this.data();
    const withPush = new Set(
      data.adminPushSubscriptions.map((s) => s.deviceId).filter(Boolean),
    );
    return data.adminDevices.map((d) => ({
      id: d.id,
      label: d.label,
      minSeverity: d.minSeverity,
      lastSeenAt: d.lastSeenAt,
      isCurrent: d.id === currentId,
      hasPush: withPush.has(d.id),
    }));
  }

  async update(
    id: string,
    patch: { label?: unknown; minSeverity?: unknown },
  ): Promise<AdminDeviceEntry | null> {
    const device = this.getById(id);
    if (!device) return null;

    let nextLabel = device.label;
    let nextSeverity = device.minSeverity;

    if (patch.label !== undefined) {
      nextLabel = normalizeLabel(patch.label);
      if (!nextLabel) {
        throw new AdminDeviceValidationError('Label must not be empty.');
      }
    }
    if (patch.minSeverity !== undefined) {
      if (patch.minSeverity !== 'critical' && patch.minSeverity !== 'warning') {
        throw new AdminDeviceValidationError(
          "minSeverity must be 'critical' or 'warning'.",
        );
      }
      nextSeverity = patch.minSeverity;
    }

    device.label = nextLabel;
    device.minSeverity = nextSeverity;
    await this.deps.writeDb();
    return device;
  }

  async revoke(id: string): Promise<boolean> {
    if (!this.getById(id)) return false;
    this.removeDevices(new Set([id]));
    await this.deps.writeDb();
    return true;
  }
}

export const adminDeviceService = new AdminDeviceService();
