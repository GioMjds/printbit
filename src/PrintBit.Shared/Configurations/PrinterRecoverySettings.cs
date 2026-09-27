namespace PrintBit.Shared.Configurations;

public class PrinterRecoverySettings
{
    public bool SupervisorEnabled { get; set; }

    public int SupervisorPollIntervalSeconds { get; set; } = 5;

    public int UnhealthySamplesBeforeRecovery { get; set; } = 2;

    public int HealthySamplesBeforeReady { get; set; } = 2;

    public int CircuitBreakerFailureLimit { get; set; } = 3;

    public int CircuitBreakerWindowMinutes { get; set; } = 10;

    public int StuckBaseTimeoutSeconds { get; set; } = 60;

    public int StuckPerPageTimeoutSeconds { get; set; } = 30;

    public int StuckTimeoutCapMinutes { get; set; } = 15;

    public int SpoolerTransitionTimeoutSeconds { get; set; } = 30;

    public int HealthRecheckTimeoutSeconds { get; set; } = 10;

    public int HealthRecheckIntervalSeconds { get; set; } = 2;

    public string ServiceName { get; set; } = "Spooler";

    public string? PrinterName { get; set; }

    public bool IsValidSupervisorPolicy() =>
        SupervisorPollIntervalSeconds > 0 &&
        UnhealthySamplesBeforeRecovery > 0 &&
        HealthySamplesBeforeReady > 0 &&
        CircuitBreakerFailureLimit > 0 &&
        CircuitBreakerWindowMinutes > 0 &&
        StuckBaseTimeoutSeconds > 0 &&
        StuckPerPageTimeoutSeconds > 0 &&
        StuckTimeoutCapMinutes > 0 &&
        SpoolerTransitionTimeoutSeconds > 0 &&
        HealthRecheckTimeoutSeconds > 0 &&
        HealthRecheckIntervalSeconds > 0;

}
