namespace PrintBit.Hardware.Devices.ESP32
{
    public class Esp32Message
    {
        public Esp32MessageType Type { get; set; }
        public string Raw { get; set; } = string.Empty;
        public int? Value { get; set; }
        public DateTime TimestampUtc { get; set; } = DateTime.UtcNow;
    }
}
