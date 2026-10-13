import type { Express } from 'express';
import type { ModuleContext } from '../module.types';
import { PrinterService } from './printer.service';
import { PrinterController } from './printer.controller';
import type { SessionStore } from '@/services/session';
import { setPrinterGuideSocketIo } from '@/services/printer-state-projection';

export interface PrinterModuleDeps extends ModuleContext {
  sessionStore: SessionStore;
}

export function registerPrinterModule(app: Express, deps: PrinterModuleDeps): void {
  if (deps.io) {
    setPrinterGuideSocketIo(deps.io);
  }
  const printerService = new PrinterService(deps.io, deps.sessionStore);
  const printerController = new PrinterController(printerService);

  app.use('/api/printer', printerController.router);
}

