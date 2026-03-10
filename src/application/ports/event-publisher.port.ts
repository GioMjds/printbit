export interface IEventPublisherPort {
  emitBalance(balance: number): void;
  emitCoinAccepted(value: number, balance: number): void;
  emitUploadEvent(
    sessionId: string,
    eventName: 'UploadStarted' | 'UploadCompleted' | 'UploadFailed',
    payload: Record<string, string | number | boolean | null>,
  ): void;
}
