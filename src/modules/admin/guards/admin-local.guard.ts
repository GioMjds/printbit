import { CanActivate, ExecutionContext, Inject, Injectable, ForbiddenException } from '@nestjs/common';
import { IAdminSettingsRepository } from '@/domain';

@Injectable()
export class AdminLocalGuard implements CanActivate {
  constructor(
    @Inject('IAdminSettingsRepository')
    private readonly adminSettingsRepository: IAdminSettingsRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ ip?: string; socket?: { remoteAddress?: string } }>();
    const settings = await this.adminSettingsRepository.get();

    if (!settings.toPrimitives().adminLocalOnly) {
      return true;
    }

    const rawIp = request.ip ?? request.socket?.remoteAddress ?? '';
    const ip = rawIp.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;

    if (
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip.startsWith('192.168.') ||
      ip.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
    ) {
      return true;
    }

    throw new ForbiddenException('Admin endpoints are allowed only from local/private network.');
  }
}
