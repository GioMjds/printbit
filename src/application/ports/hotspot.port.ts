export interface IHotspotPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}
