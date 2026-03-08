import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { DomainException } from '@/domain';

@Catch(DomainException)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: DomainException, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    const status = this.mapStatus(exception.code);

    response.status(status).json({
      statusCode: status,
      error: exception.name,
      code: exception.code,
      message: exception.message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private mapStatus(code: string): number {
    if (code === 'VALIDATION_ERROR') {
      return HttpStatus.BAD_REQUEST;
    }

    if (code === 'INVALID_STATE') {
      return HttpStatus.CONFLICT;
    }

    return HttpStatus.BAD_REQUEST;
  }
}
