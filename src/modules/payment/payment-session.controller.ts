import { Router, type Request, type Response } from 'express';
import { PaymentSessionService } from './payment-session.service';

export class PaymentSessionController {
  public readonly router: Router;

  public constructor(private readonly service: PaymentSessionService) {
    this.router = Router();
    this.router.post('/api/payment-session/arm', this.arm);
    this.router.post('/api/payment-session/heartbeat', this.heartbeat);
    this.router.post('/api/payment-session/cancel', this.cancel);
  }

  private arm = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.arm(req, req.body);
    res.status(result.statusCode).json(result.body);
  };

  private heartbeat = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.heartbeat(req, req.body);
    res.status(result.statusCode).json(result.body);
  };

  private cancel = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.cancel(req, req.body);
    res.status(result.statusCode).json(result.body);
  };
}
