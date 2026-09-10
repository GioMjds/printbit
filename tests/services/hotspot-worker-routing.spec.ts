import {
  createHotspotService,
  detectEsp32KioskIp,
} from '../../src/services/hotspot';
import { platformNetworkStateProjection } from '../../src/services/platform-network-state-projection';
import type { PlatformWorkerClient } from '../../src/services/platform-worker-client';

describe('hotspot-worker-routing', () => {
  let workerClientMock: {
    prepareHotspotPlatform: jest.Mock;
  };
  let registerKioskMock: jest.Mock;
  let ensureFirewallMock: jest.Mock;
  let loggerMock: { warn: jest.Mock; error: jest.Mock; log: jest.Mock };

  beforeEach(() => {
    platformNetworkStateProjection.reset();
    workerClientMock = {
      prepareHotspotPlatform: jest.fn(),
    };
    registerKioskMock = jest.fn().mockResolvedValue(true);
    ensureFirewallMock = jest.fn();
    loggerMock = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  });

  afterEach(() => {
    platformNetworkStateProjection.reset();
  });

  describe('detectEsp32KioskIp precedence', () => {
    it('uses projected worker IP when explicit IP is not set', () => {
      platformNetworkStateProjection.apply({
        kioskIp: '192.168.4.5',
        firewallReady: true,
        detail: null,
      });

      const resolved = detectEsp32KioskIp();
      expect(resolved).toBe('192.168.4.5');
    });
  });

  describe('hotspot service startup with worker backend', () => {
    it('prepares platform via worker and updates projection when flag is enabled', async () => {
      workerClientMock.prepareHotspotPlatform.mockResolvedValue({
        requestId: 'net-1',
        type: 'PrepareHotspotPlatform',
        success: true,
        kioskIp: '192.168.4.2',
        firewallReady: true,
        detail: null,
      });

      const service = createHotspotService({
        env: { PRINTBIT_WORKER_NETWORKING_ENABLED: 'true' },
        workerClient: workerClientMock as unknown as PlatformWorkerClient,
        registerKiosk: registerKioskMock,
        ensureFirewall: ensureFirewallMock,
        logger: loggerMock,
      });

      await service.start();

      expect(workerClientMock.prepareHotspotPlatform).toHaveBeenCalledWith({
        preferredSubnetPrefixes: expect.arrayContaining(['192.168.4.']),
        port: expect.any(Number),
      });
      expect(platformNetworkStateProjection.getSnapshot()?.kioskIp).toBe('192.168.4.2');
      expect(ensureFirewallMock).not.toHaveBeenCalled();
      expect(registerKioskMock).toHaveBeenCalledWith('192.168.4.2');

      service.stop();
    });

    it('falls back to legacy firewall when worker returns NOT_IMPLEMENTED', async () => {
      workerClientMock.prepareHotspotPlatform.mockResolvedValue({
        requestId: 'net-2',
        type: 'PrepareHotspotPlatform',
        success: false,
        kioskIp: null,
        firewallReady: false,
        errorCode: 'NOT_IMPLEMENTED',
        detail: 'Scaffolded',
      });

      const service = createHotspotService({
        env: { PRINTBIT_WORKER_NETWORKING_ENABLED: 'true' },
        workerClient: workerClientMock as unknown as PlatformWorkerClient,
        registerKiosk: registerKioskMock,
        ensureFirewall: ensureFirewallMock,
        logger: loggerMock,
      });

      await service.start();

      expect(workerClientMock.prepareHotspotPlatform).toHaveBeenCalled();
      expect(ensureFirewallMock).toHaveBeenCalled();
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining('[HOTSPOT] Worker backend unavailable; using temporary Node fallback.'),
      );

      service.stop();
    });

    it('uses legacy firewall without calling worker when flag is disabled', async () => {
      const service = createHotspotService({
        env: {},
        workerClient: workerClientMock as unknown as PlatformWorkerClient,
        registerKiosk: registerKioskMock,
        ensureFirewall: ensureFirewallMock,
        logger: loggerMock,
      });

      await service.start();

      expect(workerClientMock.prepareHotspotPlatform).not.toHaveBeenCalled();
      expect(ensureFirewallMock).toHaveBeenCalled();

      service.stop();
    });
  });
});
