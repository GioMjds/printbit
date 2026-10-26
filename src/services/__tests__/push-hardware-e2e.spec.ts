import { adminPushService } from '../admin-push.service';
import { simulatePrinterError, clearPaperJamSimulation } from '../printer-simulation';

describe('Paper Jam Push Alert Integration', () => {
  it('dispatches critical push alert when paper jam simulation is activated', async () => {
    const broadcastSpy = jest
      .spyOn(adminPushService, 'broadcastCriticalAlert')
      .mockResolvedValue({ sent: 1, pruned: 0 });
    const clearSpy = jest.spyOn(adminPushService, 'clearAlert');

    simulatePrinterError('paper_jam');
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PAPER_JAM', severity: 'critical' }),
    );

    clearPaperJamSimulation();
    expect(clearSpy).toHaveBeenCalledWith('PAPER_JAM');
  });
});
