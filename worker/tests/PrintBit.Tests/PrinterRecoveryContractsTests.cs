using System.Threading;
using System.Threading.Tasks;
using System.Text.Json;
using System.Text.Json.Serialization;
using PrintBit.Infrastructure.Services.PrintService;

namespace PrintBit.Tests;

public class PrinterRecoveryContractsTests
{
    [Fact]
    public async Task TryAcquireRecovery_ReturnsBusyWhilePrintLeaseIsHeld()
    {
        var coordinator = new PrintOperationCoordinator();
        using var printLease = await coordinator.AcquirePrintAsync(CancellationToken.None);

        var acquired = coordinator.TryAcquireRecovery(out var recoveryLease);

        Assert.False(acquired);
        Assert.Null(recoveryLease);
    }

    [Fact]
    public void TryAcquireRecovery_AllowsOnlyOneRecoveryLease()
    {
        var coordinator = new PrintOperationCoordinator();

        Assert.True(coordinator.TryAcquireRecovery(out var first));
        Assert.False(coordinator.TryAcquireRecovery(out var second));
        Assert.NotNull(first);
        Assert.Null(second);
    }

    [Theory]
    [InlineData(PrinterRecoveryOutcome.Healthy, "\"healthy\"")]
    [InlineData(PrinterRecoveryOutcome.Recovered, "\"recovered\"")]
    [InlineData(PrinterRecoveryOutcome.ManualInterventionRequired, "\"manual_intervention_required\"")]
    [InlineData(PrinterRecoveryOutcome.WorkerBusy, "\"worker_busy\"")]
    [InlineData(PrinterRecoveryOutcome.RestartFailed, "\"restart_failed\"")]
    [InlineData(PrinterRecoveryOutcome.InvalidRequest, "\"invalid_request\"")]
    public void PrinterRecoveryOutcome_SerializesToSpecifiedWireValue(
        PrinterRecoveryOutcome outcome,
        string expectedJson)
    {
        var options = new JsonSerializerOptions
        {
            Converters = { new JsonStringEnumConverter() }
        };

        var json = JsonSerializer.Serialize(outcome, options);

        Assert.Equal(expectedJson, json);
    }

    [Fact]
    public void PrinterRecoveryResult_WithSpoolerState_SerializesAsObjectSnapshot()
    {
        var result = new PrinterRecoveryResult
        {
            RequestId = "req-test-1",
            Type = PrinterRecoveryCommandType.AttemptPrinterRecovery,
            Outcome = PrinterRecoveryOutcome.Recovered,
            Action = "RestartSpooler",
            SpoolerState = new SpoolerStateDto
            {
                IsRunning = true,
                Status = "Running",
                ErrorMessage = null
            },
            PrinterState = "Healthy",
            IssueKind = "None",
            Message = "Recovered successfully.",
            StartedAt = new DateTime(2026, 9, 2, 1, 0, 0, DateTimeKind.Utc),
            CompletedAt = new DateTime(2026, 9, 2, 1, 0, 5, DateTimeKind.Utc)
        };

        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            Converters = { new JsonStringEnumConverter(allowIntegerValues: false) }
        };

        var json = JsonSerializer.Serialize(result, options);

        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.True(root.TryGetProperty("spoolerState", out var spoolerElem));
        Assert.Equal(JsonValueKind.Object, spoolerElem.ValueKind);
        Assert.True(spoolerElem.GetProperty("isRunning").GetBoolean());
        Assert.Equal("Running", spoolerElem.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, spoolerElem.GetProperty("errorMessage").ValueKind);
    }

    [Fact]
    public void PrinterRecoveryResult_WithNullSpoolerState_SerializesAsNull()
    {
        var result = new PrinterRecoveryResult
        {
            RequestId = "req-busy",
            Type = PrinterRecoveryCommandType.AttemptPrinterRecovery,
            Outcome = PrinterRecoveryOutcome.WorkerBusy,
            SpoolerState = null
        };

        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            Converters = { new JsonStringEnumConverter(allowIntegerValues: false) }
        };

        var json = JsonSerializer.Serialize(result, options);

        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.True(root.TryGetProperty("spoolerState", out var spoolerElem));
        Assert.Equal(JsonValueKind.Null, spoolerElem.ValueKind);
    }
}
