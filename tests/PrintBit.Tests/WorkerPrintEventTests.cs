using System.Text.Json;
using System.Text.Json.Serialization;
using PrintBit.HardwareService.Services;
using PrintBit.Infrastructure.IPC;
using PrintBit.Shared.Configurations;
using PrintBit.Shared.Power;
using PrintBit.Shared.Printing;

namespace PrintBit.Tests;

public class WorkerPrintEventTests
{
    [Fact]
    public void TryParseCorrelation_ParsesExpectedFormat()
    {
        var fileName = "tx-1_spool-1_1700000000000.pdf";

        var parsed = PrintJobFileName.TryParseCorrelation(fileName);

        Assert.Equal("tx-1", parsed.TransactionId);
        Assert.Equal("spool-1", parsed.SpoolerCorrelationKey);
    }

    [Fact]
    public void TryParseCorrelation_WithMissingParts_ReturnsNulls()
    {
        var parsed = PrintJobFileName.TryParseCorrelation("justfile.pdf");

        Assert.Null(parsed.TransactionId);
        Assert.Null(parsed.SpoolerCorrelationKey);
    }

    [Fact]
    public void PrinterErrorPayload_UsesExpectedContract()
    {
        // Serialize the real WorkerPrintEvent (not an anonymous object) so
        // the test catches any future regression in casing or in the
        // JsonStringEnumConverter that WorkerEventPipeClient uses.
        var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            Converters = { new JsonStringEnumConverter() }
        };

        var evt = new WorkerPrintEvent
        {
            Type = WorkerPrintEventType.PrinterError,
            PrinterName = "EPSON L5290 Series",
            FailureStage = "hardware_error",
            Message = "Printer hardware error detected (code 2). Check paper, ink, or connection.",
        };

        var json = JsonSerializer.Serialize(evt, jsonOptions);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("PrinterError", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("EPSON L5290 Series", doc.RootElement.GetProperty("printerName").GetString());
        Assert.Equal("hardware_error", doc.RootElement.GetProperty("failureStage").GetString());
        Assert.StartsWith("Printer hardware error detected (code 2).", doc.RootElement.GetProperty("message").GetString());
        // TimestampUtc defaults to DateTime.UtcNow, so just assert it is an ISO-8601 string.
        Assert.Matches(@"^\d{4}-\d{2}-\d{2}T", doc.RootElement.GetProperty("timestampUtc").GetString());
    }

    [Fact]
    public void HardwareSettings_HasWholeDocumentConfigFields()
    {
        var settings = new HardwareSettings();

        Assert.Equal(@"C:\Users\printbit\bin\SumatraPDF.exe", settings.SumatraPath);
        Assert.Equal(@"C:\Users\printbit\bin\qpdf.exe", settings.QpdfPath);
        Assert.Equal(15, settings.PauseTimeoutMinutes);
        Assert.Equal(3, settings.PostClearGuardDelaySeconds);
        Assert.Null(typeof(HardwareSettings).GetProperty("PdfSplitTimeoutSeconds"));
    }

    [Fact]
    public void WorkerPrintEvent_TerminalPayloadSerializesPageCountConfidence()
    {
        var evt = new WorkerPrintEvent
        {
            Type = WorkerPrintEventType.PrintSucceeded,
            TransactionId = "TX-1",
            SpoolerCorrelationKey = "SCK-1",
            Outcome = "partially_completed",
            TotalCopies = 2,
            TotalExpected = 4,
            CancelledCount = 1,
            CompletedCount = 3,
            PageCountConfidence = "best_effort",
            Pages = new System.Collections.Generic.List<WorkerPrintPageResult>
            {
                new() { Page = 1, Copy = 1, State = "completed" },
                new() { Page = 2, Copy = 1, State = "cancelled" }
            }
        };

        var json = JsonSerializer.Serialize(evt, new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }
        });

        Assert.Contains("\"type\":\"PrintSucceeded\"", json);
        Assert.Contains("\"transactionId\":\"TX-1\"", json);
        Assert.Contains("\"outcome\":\"partially_completed\"", json);
        Assert.Contains("\"pageCountConfidence\":\"best_effort\"", json);
        Assert.Contains("\"pages\":[", json);
        Assert.Contains("\"state\":\"completed\"", json);
    }

    [Fact]
    public void PowerSettings_HasExpectedDefaultValues()
    {
        var settings = new PowerSettings();

        Assert.Equal(2, settings.PollIntervalSeconds);
        Assert.Equal(10, settings.StableRecoverySeconds);
        Assert.Equal(10, settings.HeartbeatIntervalSeconds);
    }

    [Fact]
    public void WorkerPrintEvent_SerializesPowerStatusSnapshotPayload()
    {
        var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            Converters = { new JsonStringEnumConverter() }
        };

        var powerStatus = new PowerStatusSnapshot(
            AcLineStatus: AcLineStatus.Offline,
            IsCharging: false,
            BatteryPercentage: 85,
            IsBatteryLow: false,
            IsBatteryCritical: false);

        var evt = new WorkerPrintEvent
        {
            Type = WorkerPrintEventType.PowerStatusSnapshot,
            OperationalState = PowerOperationalState.PowerEmergency,
            AcceptingTransactions = false,
            PowerSourceInstanceId = "tablet-battery-01",
            PowerSequence = 42L,
            PowerStatus = powerStatus
        };

        var json = JsonSerializer.Serialize(evt, jsonOptions);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("PowerStatusSnapshot", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("PowerEmergency", doc.RootElement.GetProperty("operationalState").GetString());
        Assert.False(doc.RootElement.GetProperty("acceptingTransactions").GetBoolean());
        Assert.Equal("tablet-battery-01", doc.RootElement.GetProperty("powerSourceInstanceId").GetString());
        Assert.Equal(42L, doc.RootElement.GetProperty("powerSequence").GetInt64());

        var statusProp = doc.RootElement.GetProperty("powerStatus");
        Assert.Equal("Offline", statusProp.GetProperty("acLineStatus").GetString());
        Assert.False(statusProp.GetProperty("isCharging").GetBoolean());
        Assert.Equal(85, statusProp.GetProperty("batteryPercentage").GetInt32());
        Assert.False(statusProp.GetProperty("isBatteryLow").GetBoolean());
        Assert.False(statusProp.GetProperty("isBatteryCritical").GetBoolean());
    }

    [Fact]
    public void WorkerPrintEvent_SerializesPowerStatusChangedPayload()
    {
        var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            Converters = { new JsonStringEnumConverter() }
        };

        var evt = new WorkerPrintEvent
        {
            Type = WorkerPrintEventType.PowerStatusChanged,
            OperationalState = PowerOperationalState.Recovering,
            AcceptingTransactions = false,
            PowerSourceInstanceId = "tablet-battery-01",
            PowerSequence = 43L,
            PowerStatus = new PowerStatusSnapshot(
                AcLineStatus: AcLineStatus.Online,
                IsCharging: true,
                BatteryPercentage: 86,
                IsBatteryLow: false,
                IsBatteryCritical: false)
        };

        var json = JsonSerializer.Serialize(evt, jsonOptions);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("PowerStatusChanged", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("Recovering", doc.RootElement.GetProperty("operationalState").GetString());
        Assert.False(doc.RootElement.GetProperty("acceptingTransactions").GetBoolean());
    }

    [Fact]
    public void WorkerPrintEvent_DeserializesPowerPayloadFromCamelCaseJson()
    {
        var json = """
        {
            "type": "PowerStatusSnapshot",
            "operationalState": "PowerEmergency",
            "acceptingTransactions": false,
            "powerSourceInstanceId": "tablet-battery-01",
            "powerSequence": 100,
            "powerStatus": {
                "acLineStatus": "Offline",
                "isCharging": false,
                "batteryPercentage": 50,
                "isBatteryLow": true,
                "isBatteryCritical": false
            }
        }
        """;

        var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            Converters = { new JsonStringEnumConverter() }
        };

        var evt = JsonSerializer.Deserialize<WorkerPrintEvent>(json, jsonOptions);

        Assert.NotNull(evt);
        Assert.Equal(WorkerPrintEventType.PowerStatusSnapshot, evt.Type);
        Assert.Equal(PowerOperationalState.PowerEmergency, evt.OperationalState);
        Assert.False(evt.AcceptingTransactions);
        Assert.Equal("tablet-battery-01", evt.PowerSourceInstanceId);
        Assert.Equal(100L, evt.PowerSequence);
        Assert.NotNull(evt.PowerStatus);
        Assert.Equal(AcLineStatus.Offline, evt.PowerStatus.AcLineStatus);
        Assert.False(evt.PowerStatus.IsCharging);
        Assert.Equal(50, evt.PowerStatus.BatteryPercentage);
        Assert.True(evt.PowerStatus.IsBatteryLow);
        Assert.False(evt.PowerStatus.IsBatteryCritical);
    }

    [Fact]
    public void WorkerPrintEvent_SerializesPrinterStatusSnapshotPayload()
    {
        var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            Converters = { new JsonStringEnumConverter() }
        };

        var evt = new WorkerPrintEvent
        {
            Type = WorkerPrintEventType.PrinterStatusSnapshot,
            PrinterName = "EPSON L5290 Series",
            Message = "Printer is online",
            TimestampUtc = new DateTime(2026, 9, 2, 13, 0, 0, DateTimeKind.Utc)
        };

        var json = JsonSerializer.Serialize(evt, jsonOptions);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("PrinterStatusSnapshot", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("EPSON L5290 Series", doc.RootElement.GetProperty("printerName").GetString());
        Assert.Equal("Printer is online", doc.RootElement.GetProperty("message").GetString());
        Assert.Equal("2026-09-02T13:00:00Z", doc.RootElement.GetProperty("timestampUtc").GetString());
    }

    [Fact]
    public void WorkerPrintEvent_DeserializesPrinterStatusSnapshotPayload()
    {
        var json = """
        {
            "type": "PrinterStatusSnapshot",
            "printerName": "EPSON L5290 Series",
            "message": "Printer is online",
            "timestampUtc": "2026-09-02T13:00:00Z"
        }
        """;

        var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            Converters = { new JsonStringEnumConverter() }
        };

        var evt = JsonSerializer.Deserialize<WorkerPrintEvent>(json, jsonOptions);

        Assert.NotNull(evt);
        Assert.Equal(WorkerPrintEventType.PrinterStatusSnapshot, evt.Type);
        Assert.Equal("EPSON L5290 Series", evt.PrinterName);
        Assert.Equal("Printer is online", evt.Message);
        Assert.Equal(new DateTime(2026, 9, 2, 13, 0, 0, DateTimeKind.Utc), evt.TimestampUtc);
    }
}

