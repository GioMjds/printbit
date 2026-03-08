import { Injectable } from '@nestjs/common';
import { IPrinterStatusPort, PrinterStatus } from '@/application/ports';
import { getPrinterTelemetry } from '@/services';

@Injectable()
export class PrinterStatusAdapter implements IPrinterStatusPort {
  async getStatus(): Promise<PrinterStatus> {
    const telemetry = getPrinterTelemetry();
    return {
      isOnline: telemetry.connected,
      status: telemetry.status,
      details: telemetry.statusFlags.join(', '),
    };
  }
}
