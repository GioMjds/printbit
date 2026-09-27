namespace PrintBit.Application.Events
{
    public class CoinInsertedEvent
    {
        public decimal Amount { get; set; }
        public DateTime TimestampUtc { get; set; } = DateTime.UtcNow;   
    }
}
