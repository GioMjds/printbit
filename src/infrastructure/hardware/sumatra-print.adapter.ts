import { Injectable } from '@nestjs/common';
import { IPrinterPort, PrintOptions } from '@/application/ports';
import { printFile, type PrintJobOptions } from '@/services';

@Injectable()
export class SumatraPrintAdapter implements IPrinterPort {
  async print(options: PrintOptions): Promise<void> {
    const fileName = options.filePath.split(/[\\/]/).pop() ?? options.filePath;

    const paperSize: PrintJobOptions['paperSize'] =
      options.paperSize === 'Letter' || options.paperSize === 'Legal'
        ? options.paperSize
        : 'A4';

    const printOptions: PrintJobOptions = {
      copies: options.copies,
      colorMode: options.colorMode,
      orientation: options.orientation ?? 'portrait',
      paperSize,
      pageRange: options.pageRange,
    };

    await printFile(fileName, printOptions);
  }
}
