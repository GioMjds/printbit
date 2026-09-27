namespace PrintBit.Shared.Configurations;

public class PowerSettings
{
    public int PollIntervalSeconds { get; set; } = 2;
    public int StableRecoverySeconds { get; set; } = 10;
    public int HeartbeatIntervalSeconds { get; set; } = 10;
}
