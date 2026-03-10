import { Provider } from '@nestjs/common';
import { PrismaAdminSettingsRepository } from './prisma-admin-settings.repository';
import { PrismaCoinStatsRepository } from './prisma-coin-stats.repository';
import { PrismaIdempotencyRepository } from './prisma-idempotency.repository';
import { PrismaKioskStateRepository } from './prisma-kiosk-state.repository';
import { PrismaLogRepository } from './prisma-log.repository';
import { PrismaScanDeliveryTokenRepository } from './prisma-scan-delivery-token.repository';
import { PrismaUploadSessionRepository } from './prisma-upload-session.repository';
import { REPOSITORY_TOKENS } from './tokens';

export const PrismaRepositoryProviders: Provider[] = [
  PrismaAdminSettingsRepository,
  PrismaCoinStatsRepository,
  PrismaIdempotencyRepository,
  PrismaKioskStateRepository,
  PrismaLogRepository,
  PrismaScanDeliveryTokenRepository,
  PrismaUploadSessionRepository,
  {
    provide: REPOSITORY_TOKENS.ADMIN_SETTINGS,
    useExisting: PrismaAdminSettingsRepository,
  },
  {
    provide: REPOSITORY_TOKENS.COIN_STATS,
    useExisting: PrismaCoinStatsRepository,
  },
  {
    provide: REPOSITORY_TOKENS.IDEMPOTENCY,
    useExisting: PrismaIdempotencyRepository,
  },
  {
    provide: REPOSITORY_TOKENS.KIOSK_STATE,
    useExisting: PrismaKioskStateRepository,
  },
  {
    provide: REPOSITORY_TOKENS.LOG,
    useExisting: PrismaLogRepository,
  },
  {
    provide: REPOSITORY_TOKENS.SCAN_DELIVERY_TOKEN,
    useExisting: PrismaScanDeliveryTokenRepository,
  },
  {
    provide: REPOSITORY_TOKENS.UPLOAD_SESSION,
    useExisting: PrismaUploadSessionRepository,
  },
];
