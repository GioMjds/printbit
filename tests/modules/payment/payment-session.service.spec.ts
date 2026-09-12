import type { Request, Response } from 'express';

jest.mock('@/services/db', () => ({ db: { data: null } }));

import { CoinSimulation } from '../../../src/services/coin-simulation';
import {
  CONFIRM_CAPABILITY_COOKIE,
  PaymentAcceptorGate,
} from '../../../src/services/payment-acceptor-gate';
import type { SessionStore } from '../../../src/services/session';
import { PageController } from '../../../src/modules/page/page.controller';
import { PaymentSessionService } from '../../../src/modules/payment/payment-session.service';

const publicBaseUrl = new URL('http://printbit.test');

describe('PaymentSessionService', () => {
  const activeSession = {
    sessionId: 'print-session',
    token: 'session-token',
    uploadUrl: 'http://printbit.test/upload/session-token',
    status: 'uploaded' as const,
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
  };

  let armCustomerPayment: jest.Mock<Promise<boolean>, []>;
  let disarmCustomerPayment: jest.Mock<Promise<boolean>, [string]>;
  let sessionState: 'active' | 'expired' | 'missing';
  let sessionStore: Pick<SessionStore, 'getSessionState' | 'tryGetSession'>;
  let gate: PaymentAcceptorGate;
  let service: PaymentSessionService;

  const requestWith = (cookies: Record<string, unknown> = {}) =>
    ({ cookies } as Request);

  const createService = (): void => {
    gate = new PaymentAcceptorGate({
      armCustomerPayment,
      disarmCustomerPayment,
      canAcceptCustomerWork: () => true,
      isPrinterReady: () => true,
      isSerialConnected: () => true,
      getBalance: () => 0,
    });
    sessionStore = {
      getSessionState: jest.fn(() => sessionState),
      tryGetSession: jest.fn(() =>
        sessionState === 'active' ? activeSession : null,
      ),
    };
    service = new PaymentSessionService({
      paymentAcceptorGate: gate,
      sessionStore: sessionStore as SessionStore,
      resolvePublicBaseUrl: () => publicBaseUrl,
    });
  };

  beforeEach(() => {
    armCustomerPayment = jest.fn().mockResolvedValue(true);
    disarmCustomerPayment = jest.fn().mockResolvedValue(true);
    sessionState = 'active';
    createService();
  });

  it('rejects an arm request whose capability appears only in the body', async () => {
    const bodyCapability = gate.issueConfirmCapability();

    await expect(
      service.arm(requestWith(), {
        mode: 'print',
        amount: 10,
        sessionId: 'print-session',
        capability: bodyCapability,
      }),
    ).resolves.toMatchObject({ statusCode: 401 });
    expect(armCustomerPayment).not.toHaveBeenCalled();
  });

  it('rejects invalid payment mode and amount before arming hardware', async () => {
    const capability = gate.issueConfirmCapability();

    await expect(
      service.arm(requestWith({ [CONFIRM_CAPABILITY_COOKIE]: capability }), {
        mode: 'scan',
        amount: 10,
        sessionId: 'print-session',
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      service.arm(requestWith({ [CONFIRM_CAPABILITY_COOKIE]: capability }), {
        mode: 'print',
        amount: 0,
        sessionId: 'print-session',
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    expect(armCustomerPayment).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', 404],
    ['expired', 410],
  ] as const)('rejects a %s print session with %i', async (state, statusCode) => {
    sessionState = state;
    const capability = gate.issueConfirmCapability();

    await expect(
      service.arm(requestWith({ [CONFIRM_CAPABILITY_COOKIE]: capability }), {
        mode: 'print',
        amount: 10,
        sessionId: 'print-session',
      }),
    ).resolves.toMatchObject({ statusCode });
    expect(armCustomerPayment).not.toHaveBeenCalled();
  });

  it('reports unavailable payment hardware when the gate rejects a valid arm', async () => {
    armCustomerPayment.mockResolvedValue(false);
    const capability = gate.issueConfirmCapability();

    await expect(
      service.arm(requestWith({ [CONFIRM_CAPABILITY_COOKIE]: capability }), {
        mode: 'print',
        amount: 10,
        sessionId: 'print-session',
      }),
    ).resolves.toMatchObject({ statusCode: 503 });
    expect(disarmCustomerPayment).toHaveBeenCalledWith('arm_failed');
  });

  it('returns a lease and forwards its id through heartbeat and cancel', async () => {
    const capability = gate.issueConfirmCapability();
    const request = requestWith({ [CONFIRM_CAPABILITY_COOKIE]: capability });
    const armed = await service.arm(request, {
      mode: 'print',
      amount: 10,
      sessionId: 'print-session',
    });

    expect(armed).toMatchObject({
      statusCode: 200,
      body: {
        ok: true,
        status: 'AWAITING_PAYMENT',
        amount: 10,
        leaseId: expect.any(String),
        expiresAt: expect.any(Number),
      },
    });
    const leaseId = (armed.body as { leaseId: string }).leaseId;
    expect(sessionStore.tryGetSession).toHaveBeenCalledWith(
      'print-session',
      publicBaseUrl,
    );

    await expect(service.heartbeat(request, { leaseId })).resolves.toMatchObject({
      statusCode: 200,
      body: { ok: true, status: 'AWAITING_PAYMENT', expiresAt: expect.any(Number) },
    });
    await expect(service.cancel(request, { leaseId })).resolves.toMatchObject({
      statusCode: 200,
      body: { ok: true, status: 'DISARMED' },
    });
    expect(disarmCustomerPayment).toHaveBeenCalledTimes(1);
  });
});

describe('confirm capability route', () => {
  it('sets a strict finite-lived capability cookie before serving /confirm', () => {
    const gate = new PaymentAcceptorGate({
      armCustomerPayment: async () => true,
      disarmCustomerPayment: async () => true,
      canAcceptCustomerWork: () => true,
      isPrinterReady: () => true,
      isSerialConnected: () => true,
      getBalance: () => 0,
    });
    const controller = new PageController({
      sessionStore: {} as SessionStore,
      publicPageRoutes: [{ route: '/confirm', filePath: 'confirm.html' }],
      resolvePublicBaseUrl: () => publicBaseUrl,
      paymentAcceptorGate: gate,
    });
    const calls: string[] = [];
    const res = {
      cookie: jest.fn(() => {
        calls.push('cookie');
        return res;
      }),
      sendFile: jest.fn(() => calls.push('sendFile')),
    } as unknown as Response;
    const layer = (controller.router as unknown as {
      stack: Array<{
        route?: {
          path: string;
          stack: Array<{ handle: (req: Request, res: Response) => void }>;
        };
      }>;
    }).stack.find(({ route }) => route?.path === '/confirm');

    expect(layer).toBeDefined();
    layer!.route!.stack.at(-1)!.handle({} as Request, res);

    expect(res.cookie).toHaveBeenCalledWith(
      CONFIRM_CAPABILITY_COOKIE,
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        maxAge: expect.any(Number),
      }),
    );
    const maxAge = (res.cookie as jest.Mock).mock.calls[0][2].maxAge;
    expect(Number.isFinite(maxAge)).toBe(true);
    expect(maxAge).toBeGreaterThan(0);
    expect(calls).toEqual(['cookie', 'sendFile']);
  });
});

describe('local coin simulation boundary', () => {
  it('simulates a test coin without reading a customer-payment gate', async () => {
    const send = jest.fn(async (command: Record<string, unknown>) => {
      await simulation.applyEvent(
        {
          type: 'CoinInserted',
          simulated: true,
          requestId: command.requestId as string,
          coinValue: command.coinValue as number,
          timestampUtc: '2026-09-12T00:00:00.000Z',
        },
        async () => 5,
      );
      return {
        type: 'SimulateCoin',
        requestId: command.requestId as string,
        success: true,
      };
    });
    const simulation = new CoinSimulation(send);

    await expect(simulation.insert(5)).resolves.toBe(5);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'SimulateCoin',
      coinValue: 5,
    }));
  });
});
