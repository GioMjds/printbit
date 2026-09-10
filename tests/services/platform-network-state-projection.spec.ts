import { platformNetworkStateProjection } from '../../src/services/platform-network-state-projection';

describe('platformNetworkStateProjection', () => {
  beforeEach(() => {
    platformNetworkStateProjection.reset();
  });

  it('initially returns null snapshot', () => {
    expect(platformNetworkStateProjection.getSnapshot()).toBeNull();
  });

  it('applies and returns snapshot with clone safety', () => {
    platformNetworkStateProjection.apply({
      kioskIp: '192.168.4.2',
      firewallReady: true,
      detail: 'Rule verified',
    });

    const snapshot = platformNetworkStateProjection.getSnapshot();
    expect(snapshot).toEqual({
      kioskIp: '192.168.4.2',
      firewallReady: true,
      detail: 'Rule verified',
    });

    // Verify cloning (mutation does not affect projection)
    if (snapshot) {
      snapshot.kioskIp = '10.0.0.1';
    }
    expect(platformNetworkStateProjection.getSnapshot()?.kioskIp).toBe('192.168.4.2');
  });

  it('resets snapshot back to null', () => {
    platformNetworkStateProjection.apply({
      kioskIp: '192.168.4.2',
      firewallReady: true,
      detail: null,
    });
    expect(platformNetworkStateProjection.getSnapshot()).not.toBeNull();

    platformNetworkStateProjection.reset();
    expect(platformNetworkStateProjection.getSnapshot()).toBeNull();
  });
});
