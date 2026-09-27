import { Router, Request, Response } from 'express';
import { PrinterService } from './printer.service';

export class PrinterController {
  public readonly router: Router;

  constructor(private readonly printerService: PrinterService) {
    this.router = Router();
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.router.get('/status', this.getStatus);
    this.router.post('/preflight', this.preflight);
    this.router.post('/pause', this.pauseJob);
    this.router.post('/resume', this.resumeJob);
    this.router.post('/cancel-remaining', this.cancelRemainingJob);
  }

  private getStatus = async (_req: Request, res: Response): Promise<void> => {
    const response = await this.printerService.getStatusResponse();
    res.set('Cache-Control', 'no-store');
    res.json(response);
  };

  /**
   * Pre-dispatch validation: queries the printer via edge-js System.Printing
   * and returns a structured printError if a blocking condition is detected.
   */
  private preflight = async (req: Request, res: Response): Promise<void> => {
    try {
      const { printerName } = req.body ?? {};
      if (printerName !== undefined && printerName !== null) {
        if (typeof printerName !== 'string' || printerName.length > 255 || !/^[a-zA-Z0-9-_\s\\.:()]+$/.test(printerName)) {
          res.status(400).json({ error: 'Invalid printerName format' });
          return;
        }
      }
      const printError = await this.printerService.preDispatchCheck(
        typeof printerName === 'string' ? printerName : null,
      );
      if (printError) {
        // Non-200 only for fatal / recoverable; warnings still return 200
        const httpStatus = printError.severity === 'warning' ? 200 : 409;
        res.status(httpStatus).json({ printError });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      console.error('[PRINTER_CTRL] Preflight check failed:', error);
      res.status(500).json({
        printError: {
          code: 'PREFLIGHT_FAILED',
          severity: 'fatal',
          userMessage: 'Could not verify printer readiness.',
          timestamp: new Date().toISOString(),
        },
      });
    }
  };

  private pauseJob = async (req: Request, res: Response): Promise<void> => {
    try {
      const { spoolerCorrelationKey } = req.body ?? {};
      if (!isValidCorrelationKey(spoolerCorrelationKey)) {
        res.status(400).json({ error: 'Invalid or missing spoolerCorrelationKey' });
        return;
      }
      await this.printerService.pauseJob(spoolerCorrelationKey);
      res.json({ success: true });
    } catch (error) {
      console.error('[PRINTER_CTRL] Failed to pause job:', error);
      res.status(500).json({ error: 'Failed to pause job' });
    }
  };

  private resumeJob = async (req: Request, res: Response): Promise<void> => {
    try {
      const { spoolerCorrelationKey } = req.body ?? {};
      if (!isValidCorrelationKey(spoolerCorrelationKey)) {
        res.status(400).json({ error: 'Invalid or missing spoolerCorrelationKey' });
        return;
      }
      await this.printerService.resumeJob(spoolerCorrelationKey);
      res.json({ success: true });
    } catch (error) {
      console.error('[PRINTER_CTRL] Failed to resume job:', error);
      res.status(500).json({ error: 'Failed to resume job' });
    }
  };

  private cancelRemainingJob = async (req: Request, res: Response): Promise<void> => {
    try {
      const { spoolerCorrelationKey } = req.body ?? {};
      if (!isValidCorrelationKey(spoolerCorrelationKey)) {
        res.status(400).json({ error: 'Invalid or missing spoolerCorrelationKey' });
        return;
      }
      await this.printerService.cancelRemaining(spoolerCorrelationKey);
      res.json({ success: true });
    } catch (error) {
      console.error('[PRINTER_CTRL] Failed to cancel remaining pages:', error);
      res.status(500).json({ error: 'Failed to cancel remaining pages' });
    }
  };
}

function isValidCorrelationKey(key: string): key is string {
  return typeof key === 'string' && key.length <= 255 && /^[a-zA-Z0-9-_]+$/.test(key);
}
