import { Controller, Get } from '@nestjs/common';

@Controller('api/system')
export class SystemController {
  @Get('health')
  getHealth(): { ok: true; uptimeSeconds: number } {
    return {
      ok: true,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
