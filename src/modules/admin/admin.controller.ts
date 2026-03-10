import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  ExportAdminLogsCsvQuery,
  GetAdminLogsQuery,
  GetAdminSettingsQuery,
  GetAdminStatusQuery,
  GetAdminSummaryQuery,
  RunHopperSelfTestCommand,
  UpdateAdminSettingsCommand,
  ValidateAdminPinQuery,
} from '@/application/use-cases/admin';
import {
  AdminSummaryResponseDto,
  UpdateAdminSettingsRequestDto,
} from '@/application/dto';
import { LogProps } from '@/domain';
import { AdminLocalGuard } from './guards/admin-local.guard';
import { AdminPinGuard } from './guards/admin-pin.guard';
import { AdminStatusResponseDto } from '@/application/use-cases/admin/queries/get-admin-status.use-case';

@Controller('api/admin')
@UseGuards(AdminLocalGuard)
export class AdminController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post('auth')
  async authenticate(@Body('pin') pin: string): Promise<{ ok: boolean }> {
    const ok = await this.queryBus.execute(new ValidateAdminPinQuery(pin));
    return { ok };
  }

  @Get('summary')
  @UseGuards(AdminPinGuard)
  getSummary(): Promise<AdminSummaryResponseDto> {
    return this.queryBus.execute(new GetAdminSummaryQuery());
  }

  @Get('status')
  @UseGuards(AdminPinGuard)
  getStatus(): Promise<AdminStatusResponseDto> {
    return this.queryBus.execute(new GetAdminStatusQuery());
  }

  @Get('settings')
  @UseGuards(AdminPinGuard)
  getSettings(): Promise<UpdateAdminSettingsRequestDto> {
    return this.queryBus.execute(new GetAdminSettingsQuery());
  }

  @Put('settings')
  @UseGuards(AdminPinGuard)
  async updateSettings(@Body() dto: UpdateAdminSettingsRequestDto): Promise<{ ok: true }> {
    await this.commandBus.execute(new UpdateAdminSettingsCommand(dto));
    return { ok: true };
  }

  @Post('hopper/self-test')
  @UseGuards(AdminPinGuard)
  async runHopperSelfTest(): Promise<{ ok: true }> {
    await this.commandBus.execute(new RunHopperSelfTestCommand());
    return { ok: true };
  }

  @Get('logs')
  @UseGuards(AdminPinGuard)
  async getLogs(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
  ): Promise<{ logs: LogProps[] }> {
    const logs = await this.queryBus.execute(
      new GetAdminLogsQuery(limit ?? 100, offset ?? 0),
    );
    return { logs };
  }

  @Get('logs/export.csv')
  @UseGuards(AdminPinGuard)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportLogs(): Promise<string> {
    return this.queryBus.execute(new ExportAdminLogsCsvQuery());
  }
}
