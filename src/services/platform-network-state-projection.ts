export interface PlatformNetworkSnapshot {
  kioskIp: string | null;
  firewallReady: boolean;
  detail: string | null;
}

let currentSnapshot: PlatformNetworkSnapshot | null = null;

export const platformNetworkStateProjection = {
  apply(snapshot: PlatformNetworkSnapshot): void {
    currentSnapshot = {
      kioskIp: snapshot.kioskIp ?? null,
      firewallReady: Boolean(snapshot.firewallReady),
      detail: snapshot.detail ?? null,
    };
  },

  getSnapshot(): PlatformNetworkSnapshot | null {
    return currentSnapshot ? { ...currentSnapshot } : null;
  },

  reset(): void {
    currentSnapshot = null;
  },
};
