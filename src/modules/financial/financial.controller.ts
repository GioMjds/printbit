import { Router, Request, Response } from 'express';
import {
  legacyUploadMiddleware,
  validateLegacyUploadMagicBytes,
  scanLegacyUploadForMalware,
  handleMulterError,
} from '@/middleware/file-validation';
import { requireAdminLocalAccess, requireAdminPin } from '@/middleware';
import { createRateLimit } from '@/middleware';
import { FinancialService } from './financial.service';

const directPrintRateLimit = createRateLimit({
  keyPrefix: 'admin-direct-print',
  windowMs: 60_000,
  max: 10,
});

export class FinancialController {
  public readonly router: Router;

  constructor(private readonly financialService: FinancialService) {
    this.router = Router();
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.router.get('/coin', this.addCoinCompatibility);
    this.router.get('/api/balance', this.getBalance);
    this.router.get('/api/pricing', this.getPricing);
    this.router.get('/api/pricing-config', this.getPricingConfig);
    this.router.get(
      '/api/transactions/:transactionId/receipt',
      this.getTransactionReceipt,
    );
    this.router.post('/api/print/quote', this.getPrintQuote);
    this.router.post('/api/balance/reset', this.resetBalance);
    this.router.post('/api/balance/add-test-coin', this.addTestCoin);
    this.router.post(
      '/upload',
      legacyUploadMiddleware.single('file'),
      validateLegacyUploadMagicBytes,
      scanLegacyUploadForMalware,
      this.uploadLegacy,
    );
    this.router.use('/upload', handleMulterError);
    this.router.post('/print', this.printLegacy);
    this.router.post('/api/confirm-payment', this.confirmPayment);
    this.router.post(
      '/api/admin/direct-print/confirm',
      requireAdminLocalAccess,
      requireAdminPin,
      directPrintRateLimit,
      this.confirmDirectPrint,
    );
  }

  private getBalance = (req: Request, res: Response): void => {
    this.financialService.getBalance(req, res);
  };

  private addCoinCompatibility = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    await this.financialService.addCoinCompatibility(req, res);
  };

  private getPricing = (req: Request, res: Response): void => {
    this.financialService.getPricing(req, res);
  };

  private getPricingConfig = (req: Request, res: Response): void => {
    this.financialService.getPricingConfig(req, res);
  };

  private getTransactionReceipt = (req: Request, res: Response): void => {
    this.financialService.getTransactionReceipt(req, res);
  };

  private getPrintQuote = (req: Request, res: Response): void => {
    this.financialService.getPrintQuote(req, res);
  };

  private resetBalance = async (req: Request, res: Response): Promise<void> => {
    await this.financialService.resetBalance(req, res);
  };

  private addTestCoin = async (req: Request, res: Response): Promise<void> => {
    await this.financialService.addTestCoin(req, res);
  };

  private uploadLegacy = async (req: Request, res: Response): Promise<void> => {
    await this.financialService.uploadLegacy(req, res);
  };

  private printLegacy = async (req: Request, res: Response): Promise<void> => {
    await this.financialService.printLegacy(req, res);
  };

  private confirmPayment = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    await this.financialService.confirmPayment(req, res);
  };

  private confirmDirectPrint = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    if (req.body?.mode !== 'print') {
      res.status(400).json({ error: 'Direct print supports print jobs only.' });
      return;
    }
    res.locals.paymentSource = 'direct';
    await this.financialService.confirmPayment(req, res);
  };
}
