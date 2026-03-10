import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  CreateUploadSessionCommand,
  GetSessionQuery,
  PreviewSessionFileQuery,
  UploadFileToSessionCommand,
} from '@/application/use-cases/wireless-session';
import {
  UploadFileToSessionRequestDto,
  UploadSessionResponseDto,
} from '@/application/dto';

@Controller('api/wireless/sessions')
export class WirelessSessionController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get()
  createSession(): Promise<UploadSessionResponseDto> {
    return this.commandBus.execute(new CreateUploadSessionCommand());
  }

  @Get('by-token/:token')
  getByToken(@Param('token') token: string): Promise<UploadSessionResponseDto> {
    return this.queryBus.execute(new GetSessionQuery(undefined, token));
  }

  @Get(':sessionId')
  getBySessionId(
    @Param('sessionId') sessionId: string,
  ): Promise<UploadSessionResponseDto> {
    return this.queryBus.execute(new GetSessionQuery(sessionId));
  }

  @Get(':sessionId/preview')
  async previewFile(
    @Param('sessionId') _sessionId: string,
    @Query('filePath') filePath: string,
  ): Promise<{ previewPath: string }> {
    if (!filePath) {
      throw new BadRequestException('filePath is required.');
    }

    const previewPath = await this.queryBus.execute(
      new PreviewSessionFileQuery(filePath),
    );

    return { previewPath };
  }

  @Post(':sessionId/upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Param('sessionId') sessionId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{ ok: true }> {
    if (!file) {
      throw new BadRequestException('No file provided.');
    }

    const dto: UploadFileToSessionRequestDto = {
      sessionId,
      originalName: file.originalname,
      contentType: file.mimetype,
      sizeBytes: file.size,
      filename: file.filename,
      filePath: file.path,
    };

    await this.commandBus.execute(new UploadFileToSessionCommand(dto));
    return { ok: true };
  }
}
