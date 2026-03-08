import { RunHopperSelfTestUseCase } from './commands/run-hopper-self-test.use-case';
import { UpdateAdminSettingsUseCase } from './commands/update-admin-settings.use-case';
import { ExportAdminLogsCsvUseCase } from './queries/export-admin-logs-csv.use-case';
import { GetAdminLogsUseCase } from './queries/get-admin-logs.use-case';
import { GetAdminSettingsUseCase } from './queries/get-admin-settings.use-case';
import { GetAdminStatusUseCase } from './queries/get-admin-status.use-case';
import { GetAdminSummaryUseCase } from './queries/get-admin-summary.use-case';
import { ValidateAdminPinUseCase } from './queries/validate-admin-pin.use-case';

export const AdminUseCaseHandlers = [
  ExportAdminLogsCsvUseCase,
  GetAdminLogsUseCase,
  GetAdminSettingsUseCase,
  GetAdminStatusUseCase,
  GetAdminSummaryUseCase,
  RunHopperSelfTestUseCase,
  UpdateAdminSettingsUseCase,
  ValidateAdminPinUseCase,
];
