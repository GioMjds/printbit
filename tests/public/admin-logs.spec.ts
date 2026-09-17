import { inferLogBadge, inferLogSource } from '@/public/admin/logs/app';

describe('Admin Logs Badge & Source Inference', () => {
  it('correctly identifies worker sources', () => {
    const workerLog1 = {
      id: '1',
      timestamp: new Date().toISOString(),
      type: 'worker_print_started',
      message: 'Print job started',
      meta: { source: 'Worker' },
    };
    const workerLog2 = {
      id: '2',
      timestamp: new Date().toISOString(),
      type: 'printer_offline',
      message: 'Printer is offline',
    };
    const workerLog3 = {
      id: '3',
      timestamp: new Date().toISOString(),
      type: 'upload_deleted_after_print',
      message: 'File deleted',
      meta: { source: 'worker-return-pipe' },
    };

    expect(inferLogSource(workerLog1)).toEqual({ label: 'WORKER', className: 'log-badge--worker' });
    expect(inferLogSource(workerLog2)).toEqual({ label: 'WORKER', className: 'log-badge--worker' });
    expect(inferLogSource(workerLog3)).toEqual({ label: 'WORKER', className: 'log-badge--worker' });
  });

  it('correctly identifies node sources', () => {
    const nodeLog1 = {
      id: '4',
      timestamp: new Date().toISOString(),
      type: 'trusted_time_synced',
      message: 'Trusted time synchronized',
    };
    const nodeLog2 = {
      id: '5',
      timestamp: new Date().toISOString(),
      type: 'kiosk_lockdown_applied',
      message: 'Lockdown enabled',
      meta: { source: 'Node' },
    };

    expect(inferLogSource(nodeLog1)).toEqual({ label: 'NODE', className: 'log-badge--node' });
    expect(inferLogSource(nodeLog2)).toEqual({ label: 'NODE', className: 'log-badge--node' });
  });

  it('infers severity badges accurately', () => {
    expect(inferLogBadge('printer_error', 'Spooler failed')).toEqual({
      label: 'ERROR',
      className: 'log-badge--error',
    });
    expect(inferLogBadge('system_warning', 'High memory usage')).toEqual({
      label: 'WARN',
      className: 'log-badge--warn',
    });
    expect(inferLogBadge('worker_print_succeeded', 'Printed 2 pages')).toEqual({
      label: 'PRINT',
      className: 'log-badge--print',
    });
    expect(inferLogBadge('coin_inserted', 'Coin detected')).toEqual({
      label: 'COIN',
      className: 'log-badge--coin',
    });
  });
});
