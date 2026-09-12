import type { Request } from 'express';
import {
  CONFIRM_CAPABILITY_COOKIE,
  type PaymentAcceptorGate,
} from '@/services/payment-acceptor-gate';
import type { SessionStore } from '@/services/session';

type PaymentArmRequest =
  | { mode: 'print'; amount: number; sessionId: string }
  | { mode: 'copy'; amount: number; sessionId: string | null };

type PaymentSessionResponseBody =
  | { ok: true; status: 'AWAITING_PAYMENT'; leaseId: string; amount: number; expiresAt: number }
  | { ok: true; status: 'AWAITING_PAYMENT'; expiresAt: number }
  | { ok: true; status: 'DISARMED' }
  | { ok: false; error: string };

export interface PaymentSessionResponse {
  statusCode: number;
  body: PaymentSessionResponseBody;
}

export interface PaymentSessionServiceDeps {
  paymentAcceptorGate: PaymentAcceptorGate;
  sessionStore: SessionStore;
  resolvePublicBaseUrl: (req: Request) => URL;
}

export class PaymentSessionService {
  public constructor(private readonly deps: PaymentSessionServiceDeps) {}

  public async arm(
    req: Request,
    body: unknown,
  ): Promise<PaymentSessionResponse> {
    const capability = this.getCapability(req);
    if (!capability) return this.error(401, 'Confirmation capability is required.');

    const input = this.parseArmInput(body);
    if (!input) return this.error(400, 'Invalid payment session request.');

    if (input.mode === 'print') {
      const state = this.deps.sessionStore.getSessionState(input.sessionId);
      if (state === 'missing') return this.error(404, 'Print session was not found.');
      if (state === 'expired') return this.error(410, 'Print session has expired.');
      if (!this.deps.sessionStore.tryGetSession(
        input.sessionId,
        this.deps.resolvePublicBaseUrl(req),
      )) {
        return this.error(404, 'Print session was not found.');
      }
    }

    const lease = await this.deps.paymentAcceptorGate.arm({
      capability,
      mode: input.mode,
      amount: input.amount,
      sessionId: input.sessionId,
    });
    if (!lease) return this.error(503, 'Payment hardware is unavailable.');

    return {
      statusCode: 200,
      body: {
        ok: true,
        status: 'AWAITING_PAYMENT',
        leaseId: lease.leaseId,
        amount: lease.amount,
        expiresAt: lease.expiresAt,
      },
    };
  }

  public async heartbeat(
    req: Request,
    body: unknown,
  ): Promise<PaymentSessionResponse> {
    const capability = this.getCapability(req);
    if (!capability) return this.error(401, 'Confirmation capability is required.');
    const leaseId = this.parseLeaseId(body);
    if (!leaseId) return this.error(400, 'Invalid payment lease.');

    const lease = await this.deps.paymentAcceptorGate.heartbeat(capability, leaseId);
    if (!lease) return this.error(409, 'Payment lease is no longer active.');
    return {
      statusCode: 200,
      body: { ok: true, status: 'AWAITING_PAYMENT', expiresAt: lease.expiresAt },
    };
  }

  public async cancel(
    req: Request,
    body: unknown,
  ): Promise<PaymentSessionResponse> {
    const capability = this.getCapability(req);
    if (!capability) return this.error(401, 'Confirmation capability is required.');
    const leaseId = this.parseLeaseId(body);
    if (!leaseId) return this.error(400, 'Invalid payment lease.');

    const disarmed = await this.deps.paymentAcceptorGate.disarm(
      leaseId,
      'payment_session_cancelled',
    );
    if (!disarmed) return this.error(409, 'Payment lease is no longer active.');
    return { statusCode: 200, body: { ok: true, status: 'DISARMED' } };
  }

  private getCapability(req: Request): string | null {
    const capability = req.cookies?.[CONFIRM_CAPABILITY_COOKIE];
    return typeof capability === 'string' && capability.length > 0
      ? capability
      : null;
  }

  private parseArmInput(body: unknown): PaymentArmRequest | null {
    if (!this.isRecordWithOnlyKeys(body, ['mode', 'amount', 'sessionId'])) return null;
    const { mode, amount, sessionId } = body;
    if (
      (mode !== 'print' && mode !== 'copy')
      || typeof amount !== 'number'
      || !Number.isFinite(amount)
      || amount <= 0
    ) {
      return null;
    }
    if (typeof sessionId !== 'string' && sessionId !== null) return null;
    if (mode === 'print') {
      if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return null;
      return { mode, amount, sessionId };
    }
    return { mode, amount, sessionId };
  }

  private parseLeaseId(body: unknown): string | null {
    if (!this.isRecordWithOnlyKeys(body, ['leaseId'])) return null;
    return typeof body.leaseId === 'string' && body.leaseId.length > 0
      ? body.leaseId
      : null;
  }

  private isRecordWithOnlyKeys(
    value: unknown,
    allowedKeys: string[],
  ): value is Record<string, unknown> {
    return typeof value === 'object'
      && value !== null
      && Object.keys(value).every((key) => allowedKeys.includes(key));
  }

  private error(statusCode: number, error: string): PaymentSessionResponse {
    return { statusCode, body: { ok: false, error } };
  }
}
