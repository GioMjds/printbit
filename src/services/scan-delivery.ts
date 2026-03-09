import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface ScanDownloadSession {
  token: string;
  filePath: string;
  filename: string;
  expiresAt: string;
}

export interface ScanDownloadLink {
  token: string;
  downloadUrl: string;
  expiresAt: string;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000;

const parsedTtl = Number(process.env.PRINTBIT_SCAN_DOWNLOAD_TTL_MS);
const DOWNLOAD_TTL_MS =
  Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : DEFAULT_TTL_MS;

class ScanDeliveryService {
  private readonly sessions = new Map<string, ScanDownloadSession>();

  constructor() {
    setInterval(() => this.purgeExpired(), CLEANUP_INTERVAL_MS);
  }

  private purgeExpired(now = Date.now()): void {
    for (const [token, session] of this.sessions) {
      if (new Date(session.expiresAt).getTime() <= now) {
        this.sessions.delete(token);
      }
    }
  }

  createDownloadLink(scanPath: string, publicBaseUrl: URL): ScanDownloadLink {
    const filePath = path.resolve(scanPath);
    if (!fs.existsSync(filePath)) {
      throw new Error('Scanned file does not exist');
    }

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + DOWNLOAD_TTL_MS).toISOString();
    const filename = path.basename(filePath);

    this.sessions.set(token, { token, filePath, filename, expiresAt });

    const downloadUrl = new URL(
      `/scan/download/${encodeURIComponent(token)}`,
      publicBaseUrl,
    ).toString();
    return { token, downloadUrl, expiresAt };
  }

  resolveDownload(token: string): ScanDownloadSession | null {
    this.purgeExpired();
    const session = this.sessions.get(token);
    if (!session) return null;
    if (!fs.existsSync(session.filePath)) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }
}

export const scanDeliveryService = new ScanDeliveryService();

export function createScanDownloadLink(
  scanPath: string,
  publicBaseUrl: URL,
): ScanDownloadLink {
  return scanDeliveryService.createDownloadLink(scanPath, publicBaseUrl);
}

export function resolveScanDownload(token: string): ScanDownloadSession | null {
  return scanDeliveryService.resolveDownload(token);
}
