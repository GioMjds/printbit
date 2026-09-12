import type { Express, Request } from 'express';
import type { ModuleContext } from '../module.types';
import type { SessionStore } from '@/services/session';
import type { PaymentAcceptorGate } from '@/services/payment-acceptor-gate';
import { PageController, type PageRoute } from './page.controller';

export interface PageModuleDeps extends ModuleContext {
  sessionStore: SessionStore;
  publicPageRoutes: PageRoute[];
  resolvePublicBaseUrl: (req: Request) => URL;
  paymentAcceptorGate: PaymentAcceptorGate;
}

export function registerPageModule(
  app: Express,
  deps: PageModuleDeps,
): void {
  const controller = new PageController({
    sessionStore: deps.sessionStore,
    publicPageRoutes: deps.publicPageRoutes,
    resolvePublicBaseUrl: deps.resolvePublicBaseUrl,
    paymentAcceptorGate: deps.paymentAcceptorGate,
  });

  // Page routes serve static HTML files - mount at root (no /api prefix)
  app.use(controller.router);
}

