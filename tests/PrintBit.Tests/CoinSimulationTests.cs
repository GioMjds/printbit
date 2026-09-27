using PrintBit.Infrastructure.IPC;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;
using PrintBit.Application.Services;
using PrintBit.HardwareService.Services;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Shared.Configurations;
using Xunit;

namespace PrintBit.Tests;

public class CoinSimulationTests
{
    [Theory]
    [InlineData(true, false, true, true, null)]
    [InlineData(false, false, true, false, "SIMULATION_DISABLED")]
    [InlineData(true, true, true, true, null)]
    [InlineData(true, false, false, false, "WORKER_EVENT_UNAVAILABLE")]
    public async Task Command_RespectsGateAndReportsEventDelivery(
        bool enabled, bool locked, bool delivered, bool success, string? errorCode)
    {
        var hardware = new Mock<IHardwareOrchestrator>();
        hardware.SetupGet(h => h.IsCoinSlotLocked).Returns(locked);
        var events = new Mock<IWorkerEventPipeClient>();
        var sent = new List<WorkerPrintEvent>();
        events.Setup(e => e.SendAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Callback<WorkerPrintEvent, CancellationToken>((evt, _) => sent.Add(evt))
            .ReturnsAsync(delivered);
        var service = new WorkerCommandPipeHostedService(
            NullLogger<WorkerCommandPipeHostedService>.Instance,
            Mock.Of<IPrinterRecoveryService>(), Options.Create(new IpcSettings()),
            hardware.Object, events.Object,
            Options.Create(new HardwareSettings { EnableCoinSimulation = enabled }));
        using var input = new MemoryStream(Encoding.UTF8.GetBytes(
            "{\"type\":\"SimulateCoin\",\"requestId\":\"scc-1\",\"coinValue\":5}\n"));
        using var output = new MemoryStream();
        await service.ProcessRequestAsync(input, output, CancellationToken.None);
        using var response = JsonDocument.Parse(output.ToArray());
        Assert.Equal(success, response.RootElement.GetProperty("success").GetBoolean());
        Assert.Equal("scc-1", response.RootElement.GetProperty("requestId").GetString());
        Assert.Equal("SimulateCoin", response.RootElement.GetProperty("type").GetString());
        Assert.Equal(errorCode, response.RootElement.GetProperty("errorCode").GetString());
        if (enabled)
        {
            var evt = Assert.Single(sent);
            Assert.Equal(WorkerPrintEventType.CoinInserted, evt.Type);
            Assert.True(evt.Simulated);
            Assert.Equal(5, evt.CoinValue);
            Assert.Equal("scc-1", evt.RequestId);
        }
        else Assert.Empty(sent);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(5)]
    [InlineData(10)]
    [InlineData(20)]
    public void Parser_AcceptsSimulationDenominations(int value)
    {
        Assert.True(WorkerCommandParser.IsHardwareCommandType("SimulateCoin"));
        Assert.True(WorkerCommandParser.TryParseHardwareCommand(
            $$"""{"type":"SimulateCoin","requestId":"test-coin","coinValue":{{value}}}""",
            8192, out var command, out var error));
        Assert.Equal("test-coin", command!.RequestId);
        Assert.Null(error);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("2")]
    [InlineData("1.5")]
    [InlineData("\"5\"")]
    [InlineData("null")]
    public void Parser_RejectsInvalidSimulationDenominations(string value)
    {
        Assert.False(WorkerCommandParser.TryParseHardwareCommand(
            $$"""{"type":"SimulateCoin","requestId":"test-coin","coinValue":{{value}}}""",
            8192, out _, out _));
    }
}
