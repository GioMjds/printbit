import { AdminSettings } from '@/domain';
import type {
  AdminSettings as PrismaAdminSettings,
  HopperSettings as PrismaHopperSettings,
} from '@prisma/client';

export class AdminSettingsMapper {
  toDomain(
    settings: PrismaAdminSettings,
    hopper: PrismaHopperSettings,
  ): AdminSettings {
    return AdminSettings.create({
      pricing: {
        printPerPage: settings.printPerPage,
        copyPerPage: settings.copyPerPage,
        scanDocument: settings.scanDocument,
        colorSurcharge: settings.colorSurcharge,
      },
      idleTimeoutSeconds: settings.idleTimeoutSeconds,
      adminPin: settings.adminPin,
      adminLocalOnly: settings.adminLocalOnly,
      hopper: {
        enabled: hopper.enabled,
        timeoutMs: hopper.timeoutMs,
        retryCount: hopper.retryCount,
        dispenseCommandPrefix: hopper.dispenseCommandPrefix,
        selfTestCommand: hopper.selfTestCommand,
      },
    });
  }

  toPersistence(entity: AdminSettings): {
    settings: {
      printPerPage: number;
      copyPerPage: number;
      scanDocument: number;
      colorSurcharge: number;
      idleTimeoutSeconds: number;
      adminPin: string;
      adminLocalOnly: boolean;
    };
    hopper: {
      enabled: boolean;
      timeoutMs: number;
      retryCount: number;
      dispenseCommandPrefix: string;
      selfTestCommand: string;
    };
  } {
    const data = entity.toPrimitives();
    return {
      settings: {
        printPerPage: data.pricing.printPerPage,
        copyPerPage: data.pricing.copyPerPage,
        scanDocument: data.pricing.scanDocument,
        colorSurcharge: data.pricing.colorSurcharge,
        idleTimeoutSeconds: data.idleTimeoutSeconds,
        adminPin: data.adminPin,
        adminLocalOnly: data.adminLocalOnly,
      },
      hopper: {
        enabled: data.hopper.enabled,
        timeoutMs: data.hopper.timeoutMs,
        retryCount: data.hopper.retryCount,
        dispenseCommandPrefix: data.hopper.dispenseCommandPrefix,
        selfTestCommand: data.hopper.selfTestCommand,
      },
    };
  }
}
