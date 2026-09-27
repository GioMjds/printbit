namespace PrintBit.Infrastructure.IPC;

public enum WorkerPrintEventType
{
    PrintStarted = 0,
    PrintSucceeded = 1,
    PrintFailed = 2,
    PrinterOffline = 3,
    PrinterOnline = 4,
    PrinterError = 5,
    PowerStatusChanged = 6,
    PowerStatusSnapshot = 7,
    PrinterStatusSnapshot = 8,
    CoinInserted = 9,
    CoinRejected = 10,
    HopperProgress = 11,
    HopperDispensed = 12,
    HardwareStatus = 13,
    ScanStarted = 14,
    ScanProgress = 15,
    ScanCompleted = 16,
    ScanFailed = 17,
    UsbInserted = 18,
    UsbRemoved = 19,
    NetworkStatusSnapshot = 20,
    PrinterSupervisorSnapshot = 21,
    PrintProgress = 22
}

