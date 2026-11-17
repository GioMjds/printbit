import type { IdleInfo } from '@/shared/idle-screen-contract';

export const IDLE_STATUS_POLL_MS = 30_000;

export async function fetchIdleInfo(): Promise<IdleInfo> {
  const response = await fetch('/api/idle/info', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Idle info failed: ${response.status}`);
  return (await response.json()) as IdleInfo;
}

export interface IdleStatusPollerDeps {
  fetchInfo: () => Promise<IdleInfo>;
  onUpdate: (info: IdleInfo) => void;
  intervalMs?: number;
}

/**
 * Polls idle info only while started. A failed fetch keeps the last good
 * response; a response that lands after stop() is dropped.
 */
export class IdleStatusPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private latestInfo: IdleInfo | null = null;

  constructor(private readonly deps: IdleStatusPollerDeps) {}

  get latest(): IdleInfo | null {
    return this.latestInfo;
  }

  start(): void {
    if (this.timer !== null) return;
    this.generation += 1;
    void this.refresh(this.generation);
    this.timer = setInterval(
      () => void this.refresh(this.generation),
      this.deps.intervalMs ?? IDLE_STATUS_POLL_MS,
    );
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.generation += 1;
  }

  private async refresh(generation: number): Promise<void> {
    try {
      const info = await this.deps.fetchInfo();
      if (generation !== this.generation) return;
      this.latestInfo = info;
      this.deps.onUpdate(info);
    } catch (error) {
      console.warn(
        '[IdleScreen] Idle info refresh failed; keeping last data.',
        error,
      );
    }
  }
}
