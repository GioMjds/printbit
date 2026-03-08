import { AdminUseCaseHandlers } from './admin/handlers';
import { CopyUseCaseHandlers } from './copy/handlers';
import { FinancialUseCaseHandlers } from './financial/handlers';
import { ScanUseCaseHandlers } from './scan/handlers';
import { WirelessSessionUseCaseHandlers } from './wireless-session/handlers';

export const ApplicationUseCaseHandlers = [
  ...AdminUseCaseHandlers,
  ...CopyUseCaseHandlers,
  ...FinancialUseCaseHandlers,
  ...ScanUseCaseHandlers,
  ...WirelessSessionUseCaseHandlers,
] as const;
