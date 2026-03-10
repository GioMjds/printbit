import { Body, Controller, Get, Post } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  AddTestCoinCommand,
  ConfirmPaymentCommand,
  GetBalanceQuery,
  GetPricingQuery,
  ResetBalanceCommand,
} from '@/application/use-cases/financial';
import {
  AddTestCoinRequestDto,
  BalanceResponseDto,
  ConfirmPaymentRequestDto,
  PaymentResultResponseDto,
  PricingResponseDto,
} from '@/application/dto';

@Controller('api')
export class FinancialController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get('balance')
  getBalance(): Promise<BalanceResponseDto> {
    return this.queryBus.execute(new GetBalanceQuery());
  }

  @Get('pricing')
  getPricing(): Promise<PricingResponseDto> {
    return this.queryBus.execute(new GetPricingQuery());
  }

  @Post('balance/reset')
  async resetBalance(): Promise<{ ok: true }> {
    await this.commandBus.execute(new ResetBalanceCommand());
    return { ok: true };
  }

  @Post('balance/add-test-coin')
  addTestCoin(
    @Body() dto: AddTestCoinRequestDto,
  ): Promise<BalanceResponseDto> {
    return this.commandBus.execute(new AddTestCoinCommand(dto));
  }

  @Post('confirm-payment')
  confirmPayment(
    @Body() dto: ConfirmPaymentRequestDto,
  ): Promise<PaymentResultResponseDto> {
    return this.commandBus.execute(new ConfirmPaymentCommand(dto));
  }
}
