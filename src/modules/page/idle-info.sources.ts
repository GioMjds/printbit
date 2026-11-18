import { db, defaultPricingEngine } from '@/services/db';
import { printerStateProjection } from '@/services/printer-state-projection';
import { printerErrorStateManager } from '@/services/printer-error-state';
import { getScannerStatus } from '@/services/scanner';
import { MAX_FILE_SIZE_BYTES } from '@/utils/file-types';
import { ACCEPTED_COIN_VALUES } from '@/shared/accepted-coins';
import {
  normalizeIdleScreenSettings,
  type IdleInfo,
} from '@/shared/idle-screen-contract';
import { buildIdleInfo } from './idle-info';

/**
 * Reads the live kiosk state for GET /api/idle/info. Every reader is cheap:
 * cached projections and settings only, no device probes.
 */
export function createIdleInfoProvider(): () => IdleInfo {
  return () =>
    buildIdleInfo({
      readers: {
        printerStatus: () => printerStateProjection.getSnapshot().status,
        activePrinterErrorCode: () => {
          const active = printerErrorStateManager.getActiveError();
          return active && active.status !== 'cleared' ? active.code : null;
        },
        scannerReady: () => {
          const scanner = getScannerStatus();
          return scanner.connected || scanner.usingStub;
        },
        hopperLastError: () => db.data!.hopperStats?.lastError ?? null,
        paperForecast: () => {
          const forecast = db.data!.settings.consumablesForecasting;
          return {
            enabled: Boolean(forecast.enabled),
            currentSheets: forecast.paperCurrentSheets,
            capacitySheets: forecast.paperTrayCapacitySheets,
          };
        },
      },
      settings: () => normalizeIdleScreenSettings(db.data!.settings.idleScreen),
      pricing: () => {
        const settings = db.data!.settings;
        return {
          paperProfiles:
            settings.pricingEngine?.paperProfiles ??
            defaultPricingEngine.paperProfiles,
          copyBwPerPage: settings.pricing?.copyBwPerPage,
          copyPerPage: settings.pricing?.copyPerPage,
          copyColorPerPage: settings.pricing?.copyColorPerPage,
          scanDocument: settings.pricing?.scanDocument,
        };
      },
      coins: ACCEPTED_COIN_VALUES,
      maxUploadBytes: MAX_FILE_SIZE_BYTES,
      wordUploads: () =>
        Boolean(db.data!.settings.pipelineSettings?.documentConversionEnabled),
    });
}
