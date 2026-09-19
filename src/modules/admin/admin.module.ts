import type { Express } from 'express';
import type { ModuleContext } from '../module.types';
import { AdminController, type AdminControllerDeps } from './admin.controller';
import { AdminService } from './admin.service';
import { ConsumablesService } from './consumables.service';

export interface AdminModuleDeps extends ModuleContext {
  uploadDir: string;
  getSerialStatus: AdminControllerDeps['getSerialStatus'];
  getHopperStatus: AdminControllerDeps['getHopperStatus'];
  runHopperSelfTest: AdminControllerDeps['runHopperSelfTest'];
}

export function registerAdminModule(
  app: Express,
  deps: AdminModuleDeps,
): void {
  const adminService = new AdminService();
  adminService.setSocketIo(deps.io);
  const consumablesService = new ConsumablesService();
  const adminController = new AdminController(
    adminService,
    consumablesService,
    deps,
  );
  app.use('/api/admin', adminController.router);
  void adminService.reconcileMissingCopyTransactions().catch((err) => {
    console.error(
      '[ADMIN] Failed to reconcile missing copy transactions on registerAdminModule:',
      err,
    );
  });
}

