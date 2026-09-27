namespace PrintBit.Shared.Enums;

public enum TransactionState
{
    Idle,
    Pending,
    ReadyToPrint,
    Printing,
    Verifying,
    Success,
    Failed,
    HardwareError
}
