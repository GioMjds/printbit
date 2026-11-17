import express from 'express';
import request from 'supertest';
import {
  createDefaultIdleScreenSettings,
  type IdleInfo,
} from '@/shared/idle-screen-contract';

jest.mock('@/services/db', () => ({
  db: {
    data: { settings: { idleTimeoutSeconds: 120, idleScreenTimeoutSeconds: 30 } },
  },
}));

import { PageController } from './page.controller';

const INFO: IdleInfo = {
  settings: createDefaultIdleScreenSettings(),
  pricing: { printBwFrom: 3, printColorFrom: 18, copyBw: 3, copyColor: 5, scan: 5 },
  services: {
    print: { state: 'ready', reason: null },
    copy: { state: 'limited', reason: 'paper_low' },
    scan: { state: 'ready', reason: null },
  },
  paper: { level: 'low' },
  change: { exactCoinsOnly: false },
  coins: [1, 5, 10, 20],
  maxUploadMb: 25,
  wordUploads: true,
};

function makeApp(idleInfoProvider: () => IdleInfo): express.Express {
  const controller = new PageController({
    sessionStore: {} as never,
    publicPageRoutes: [],
    resolvePublicBaseUrl: () => new URL('http://localhost'),
    paymentAcceptorGate: {} as never,
    idleInfoProvider,
  });
  const app = express();
  app.use(controller.router);
  return app;
}

describe('GET /api/idle/info', () => {
  it('returns the provider snapshot without caching', async () => {
    const res = await request(makeApp(() => INFO)).get('/api/idle/info');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual(INFO);
  });

  it('returns 503 without leaking error text when the provider throws', async () => {
    const res = await request(
      makeApp(() => {
        throw new Error('secret device path C:\\naps2');
      }),
    ).get('/api/idle/info');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Idle info unavailable.' });
  });
});
