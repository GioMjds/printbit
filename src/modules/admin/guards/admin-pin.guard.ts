import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { ValidateAdminPinQuery } from '@/application/use-cases/admin';

@Injectable()
export class AdminPinGuard implements CanActivate {
  constructor(private readonly queryBus: QueryBus) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const pinHeader = request.headers['x-admin-pin'];
    const pin = Array.isArray(pinHeader) ? pinHeader[0] : pinHeader;

    if (!pin) {
      throw new UnauthorizedException('Missing x-admin-pin header.');
    }

    const isValid = await this.queryBus.execute(new ValidateAdminPinQuery(pin));
    if (!isValid) {
      throw new UnauthorizedException('Invalid admin PIN.');
    }

    return true;
  }
}
