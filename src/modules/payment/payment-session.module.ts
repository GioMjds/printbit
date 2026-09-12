import type { Express, Request } from 'express';
import type { ModuleContext } from '../module.types';
import type { PaymentAcceptorGate } from '@/services/payment-acceptor-gate';
import type { SessionStore } from '@/services/session';
import { PaymentSessionController } from './payment-session.controller';
import { PaymentSessionService } from './payment-session.service';

export interface PaymentSessionModuleDeps extends ModuleContext {
  paymentAcceptorGate: PaymentAcceptorGate;
  sessionStore: SessionStore;
  resolvePublicBaseUrl: (req: Request) => URL;
}

export function registerPaymentModule(
  app: Express,
  deps: PaymentSessionModuleDeps,
): void {
  const service = new PaymentSessionService({
    paymentAcceptorGate: deps.paymentAcceptorGate,
    sessionStore: deps.sessionStore,
    resolvePublicBaseUrl: deps.resolvePublicBaseUrl,
  });
  app.use(new PaymentSessionController(service).router);
}
