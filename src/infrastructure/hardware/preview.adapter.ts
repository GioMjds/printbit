import { Injectable } from '@nestjs/common';
import { IPreviewPort } from '@/application/ports';
import { convertToPdfPreview } from '@/services';

@Injectable()
export class PreviewAdapter implements IPreviewPort {
  async generatePreview(filePath: string): Promise<string> {
    return convertToPdfPreview(filePath);
  }
}
