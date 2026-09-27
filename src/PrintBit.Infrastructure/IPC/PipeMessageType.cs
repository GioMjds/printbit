namespace PrintBit.Infrastructure.IPC;

public enum PipeMessageType
{
    Unknown = 0,
    HardwareStatus,
    PrinterStatus,
    TransactionStatus,
    CoinInserted,
    PrintStarted,
    PrintCompleted,
    ResetTransactionRequest,
    Error
}
