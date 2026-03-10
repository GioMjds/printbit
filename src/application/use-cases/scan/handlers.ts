import { ChargeSoftCopyUseCase } from './commands/charge-soft-copy.use-case';
import { CreateScanDownloadUseCase } from './commands/create-scan-download.use-case';
import { ExportScanToUsbUseCase } from './commands/export-scan-to-usb.use-case';
import { StartScanUseCase } from './commands/start-scan.use-case';
import { DownloadScanUseCase } from './queries/download-scan.use-case';
import { GetScannerStatusUseCase } from './queries/get-scanner-status.use-case';
import { ListUsbDrivesUseCase } from './queries/list-usb-drives.use-case';

export const ScanUseCaseHandlers = [
  ChargeSoftCopyUseCase,
  CreateScanDownloadUseCase,
  DownloadScanUseCase,
  ExportScanToUsbUseCase,
  GetScannerStatusUseCase,
  ListUsbDrivesUseCase,
  StartScanUseCase,
];
