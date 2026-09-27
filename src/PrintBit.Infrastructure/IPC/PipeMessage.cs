namespace PrintBit.Infrastructure.IPC;

public class PipeMessage
{
    public PipeMessageType Type { get; set; }

    public string Payload { get; set; } = string.Empty;

    public DateTime TimestampUtc { get; set; } = DateTime.UtcNow;
}