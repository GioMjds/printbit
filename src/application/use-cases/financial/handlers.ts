import { AddTestCoinUseCase } from './commands/add-test-coin.use-case';
import { ConfirmPaymentUseCase } from './commands/confirm-payment.use-case';
import { ResetBalanceUseCase } from './commands/reset-balance.use-case';
import { GetBalanceUseCase } from './queries/get-balance.use-case';
import { GetPricingUseCase } from './queries/get-pricing.use-case';

export const FinancialUseCaseHandlers = [
  AddTestCoinUseCase,
  ConfirmPaymentUseCase,
  GetBalanceUseCase,
  GetPricingUseCase,
  ResetBalanceUseCase,
] as const;
