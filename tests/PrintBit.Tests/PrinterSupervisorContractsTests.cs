using System;
using System.Text.Json;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Shared.Configurations;

namespace PrintBit.Tests;

public class PrinterSupervisorContractsTests
{
    [Fact]
    public void Snapshot_SerializesStableCamelCaseContract()
    {
        var value = PrinterSupervisorSnapshot.Ready(
            7,
            DateTime.Parse("2026-09-09T06:26:12Z").ToUniversalTime(),
            "EPSON L5290 Series",
            "USB005");

        var json = JsonSerializer.Serialize(value, WorkerJson.Options);

        Assert.Contains("\"status\":\"ready\"", json);
        Assert.Contains("\"sequence\":7", json);
        Assert.Contains("\"portName\":\"USB005\"", json);
    }

    [Fact]
    public void Snapshot_NormalizesLocalTimestampToUtc()
    {
        var localTimestamp = new DateTime(2026, 9, 9, 14, 26, 12, DateTimeKind.Local);
        var value = PrinterSupervisorSnapshot.Ready(
            8,
            localTimestamp,
            "EPSON L5290 Series",
            "USB005");

        var json = JsonSerializer.Serialize(value, WorkerJson.Options);
        using var document = JsonDocument.Parse(json);

        Assert.Equal(localTimestamp.ToUniversalTime(), value.TimestampUtc);
        Assert.EndsWith("Z", document.RootElement.GetProperty("timestampUtc").GetString());
    }

    [Fact]
    public void Settings_DefaultsMatchApprovedPolicy()
    {
        var value = new PrinterRecoverySettings();

        Assert.Equal((5, 2, 2), (value.SupervisorPollIntervalSeconds,
            value.UnhealthySamplesBeforeRecovery, value.HealthySamplesBeforeReady));
        Assert.Equal((3, 10), (value.CircuitBreakerFailureLimit,
            value.CircuitBreakerWindowMinutes));
        Assert.Equal((60, 30, 15), (value.StuckBaseTimeoutSeconds,
            value.StuckPerPageTimeoutSeconds, value.StuckTimeoutCapMinutes));
    }

    [Fact]
    public void Settings_RejectsEveryNonPositiveSupervisorLimitOrTiming()
    {
        var invalidSettings = new[]
        {
            new PrinterRecoverySettings { SupervisorPollIntervalSeconds = 0 },
            new PrinterRecoverySettings { UnhealthySamplesBeforeRecovery = 0 },
            new PrinterRecoverySettings { HealthySamplesBeforeReady = 0 },
            new PrinterRecoverySettings { CircuitBreakerFailureLimit = 0 },
            new PrinterRecoverySettings { CircuitBreakerWindowMinutes = 0 },
            new PrinterRecoverySettings { StuckBaseTimeoutSeconds = 0 },
            new PrinterRecoverySettings { StuckPerPageTimeoutSeconds = 0 },
            new PrinterRecoverySettings { StuckTimeoutCapMinutes = 0 },
            new PrinterRecoverySettings { SpoolerTransitionTimeoutSeconds = 0 },
            new PrinterRecoverySettings { HealthRecheckTimeoutSeconds = 0 },
            new PrinterRecoverySettings { HealthRecheckIntervalSeconds = 0 }
        };

        Assert.True(new PrinterRecoverySettings().IsValidSupervisorPolicy());
        Assert.All(invalidSettings, setting => Assert.False(setting.IsValidSupervisorPolicy()));
    }
}
