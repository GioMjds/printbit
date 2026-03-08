import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { IPreviewPort } from '@/application/ports';

export class PreviewSessionFileQuery {
  constructor(public readonly filePath: string) {}
}

@QueryHandler(PreviewSessionFileQuery)
export class PreviewSessionFileUseCase implements IQueryHandler<PreviewSessionFileQuery, string> {
  constructor(
    @Inject('IPreviewPort')
    private readonly previewPort: IPreviewPort,
  ) {}

  async execute(query: PreviewSessionFileQuery): Promise<string> {
    return this.previewPort.generatePreview(query.filePath);
  }
}
