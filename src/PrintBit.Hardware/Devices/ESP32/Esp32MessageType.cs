namespace PrintBit.Hardware.Devices.ESP32
{
    public enum Esp32MessageType
    {
        Unknown = 0,
        CoinInserted,
        HopperPulse,
        HopperCompleted,
        PrinterStarted,
        PrinterCompleted,
        Heartbeat,
        Error
    }
}
