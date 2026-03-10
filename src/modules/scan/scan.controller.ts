import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  ChargeSoftCopyCommand,
  CreateScanDownloadCommand,
  DownloadScanQuery,
  ExportScanToUsbCommand,
  GetScannerStatusQuery,
  ListUsbDrivesQuery,
  StartScanCommand,
} from '@/application/use-cases/scan';
import {
  ExportScanToUsbRequestDto,
  ScannerStatusResponseDto,
  StartScanRequestDto,
  StartScanResponseDto,
} from '@/application/dto';
import { UsbDrive } from '@/application/ports';

interface ChargeSoftCopyBody {
  amountCents: number;
}

interface CreateScanDownloadBody {
  filePath: string;
  filename: string;
  ttlMs?: number;
}

@Controller('api')
export class ScanController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get('scanner/status')
  getScannerStatus(): Promise<ScannerStatusResponseDto> {
    return this.queryBus.execute(new GetScannerStatusQuery());
  }

  @Post('scanner/scan')
  startScan(@Body() dto: StartScanRequestDto): Promise<StartScanResponseDto> {
    return this.commandBus.execute(new StartScanCommand(dto));
  }

  @Post('scanner/soft-copy/charge')
  async chargeSoftCopy(@Body() body: ChargeSoftCopyBody): Promise<{ balance: number }> {
    const balance = await this.commandBus.execute(
      new ChargeSoftCopyCommand(body.amountCents),
    );
    return { balance };
  }

  @Post('scanner/download')
  async createDownloadToken(@Body() body: CreateScanDownloadBody): Promise<{ token: string }> {
    const token = await this.commandBus.execute(
      new CreateScanDownloadCommand(
        body.filePath,
        body.filename,
        body.ttlMs ?? 30 * 60 * 1000,
      ),
    );
    return { token };
  }

  @Get('scanner/download/:token')
  async resolveDownload(@Param('token') token: string): Promise<{ filePath: string }> {
    const filePath = await this.queryBus.execute(new DownloadScanQuery(token));
    return { filePath };
  }

  @Get('usb/drives')
  listUsbDrives(): Promise<UsbDrive[]> {
    return this.queryBus.execute(new ListUsbDrivesQuery());
  }

  @Post('scanner/export-usb')
  async exportToUsb(@Body() dto: ExportScanToUsbRequestDto): Promise<{ outputPath: string }> {
    const outputPath = await this.commandBus.execute(new ExportScanToUsbCommand(dto));
    return { outputPath };
  }
}
