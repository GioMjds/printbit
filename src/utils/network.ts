/**
 * Network utility functions for IP address handling and detection.
 */
import os from 'node:os';

/**
 * Normalizes an IP or subnet prefix candidate into a trailing dot prefix (e.g. "192.168.4.").
 */
export function normalizeSubnetPrefix(prefixCandidate: string): string | null {
  const trimmed = prefixCandidate.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('.').filter((p) => p.length > 0);
  if (parts.length < 3) return null;
  const octets = parts.slice(0, 3);
  for (const octet of octets) {
    if (!/^\d+$/.test(octet)) return null;
    const num = Number(octet);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
  }
  return `${octets[0]}.${octets[1]}.${octets[2]}.`;
}

/**
 * Scans active network interfaces and returns the first non-internal IPv4 address
 * matching the given subnet prefix (e.g. "192.168.4.").
 */
export function findMatchingIpv4ForSubnet(
  subnetPrefix: string,
  customInterfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string | null {
  const normalizedPrefix = normalizeSubnetPrefix(subnetPrefix);
  if (!normalizedPrefix) return null;

  const interfaces = customInterfaces ?? os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (iface.address.startsWith(normalizedPrefix)) {
        return iface.address;
      }
    }
  }

  return null;
}

/**
 * Returns all active non-internal IPv4 addresses with their interface names.
 */
export function getAllLocalIPv4s(
  customInterfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): { name: string; address: string; isInternal: boolean }[] {
  const interfaces = customInterfaces ?? os.networkInterfaces();
  const results: { name: string; address: string; isInternal: boolean }[] =
    [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      results.push({
        name,
        address: iface.address,
        isInternal: Boolean(iface.internal),
      });
    }
  }

  return results;
}

/**
 * Get the local IPv4 address, optionally preferring a specific subnet prefix or hotspot adapter.
 */
export function getLocalIPv4(
  preferredPrefix?: string,
  customInterfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string | null {
  const interfaces = customInterfaces ?? os.networkInterfaces();

  if (preferredPrefix) {
    const matched = findMatchingIpv4ForSubnet(preferredPrefix, interfaces);
    if (matched) return matched;
  }

  let hotspotMatch: string | null = null;
  let privateFallback: string | null = null;
  let generalFallback: string | null = null;

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;

      // Prefer hotspot adapter: Windows Mobile Hotspot (192.168.137.x)
      const isHotspot =
        /Wi-Fi Direct|Local Area Connection\*/i.test(name) ||
        iface.address.startsWith('192.168.137.');
      if (isHotspot && !hotspotMatch) {
        hotspotMatch = iface.address;
      }

      if (
        !privateFallback &&
        /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(iface.address)
      ) {
        privateFallback = iface.address;
      }

      if (!generalFallback) generalFallback = iface.address;
    }
  }

  return hotspotMatch ?? privateFallback ?? generalFallback;
}

/**
 * Normalize a remote IP address by stripping IPv4-mapped IPv6 prefix.
 */
export function normalizeRemoteIp(rawIp: string): string {
  const normalized = rawIp.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    return normalized.slice('::ffff:'.length);
  }
  return normalized;
}

/**
 * Check if a request originated from localhost.
 */
export function isLoopbackRequest(remoteIp: string): boolean {
  const ip = normalizeRemoteIp(remoteIp);
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}
