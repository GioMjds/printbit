using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Moq;
using PrintBit.Application.Events;
using PrintBit.Application.Handlers;
using PrintBit.Application.Services;
using PrintBit.Application.StateMachine;
using PrintBit.Hardware.Devices.CoinAcceptor;
using PrintBit.Hardware.Devices.ESP32;
using PrintBit.Hardware.Devices.Hopper;
using PrintBit.HardwareService.Services;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Infrastructure.Services.SerialService;
using PrintBit.Infrastructure.Windows.PrinterMonitoring;
using PrintBit.Shared.Configurations;
using Xunit;

namespace PrintBit.Tests;

public class WorkerHardwareCommandTests
{
    private readonly Mock<IPrinterRecoveryService> _recoveryServiceMock;
    private readonly Mock<IHardwareOrchestrator> _orchestratorMock;
    private readonly Mock<ILogger<WorkerCommandPipeHostedService>> _loggerMock;
    private readonly IpcSettings _ipcSettings;

    public WorkerHardwareCommandTests()
    {
        _recoveryServiceMock = new Mock<IPrinterRecoveryService>();
        _orchestratorMock = new Mock<IHardwareOrchestrator>();
        _loggerMock = new Mock<ILogger<WorkerCommandPipeHostedService>>();
        _ipcSettings = new IpcSettings
        {
            WorkerCommandPipeName = "test-worker-hw-commands-" + Guid.NewGuid().ToString("N"),
            MaxMessageBytes = 8192
        };
    }

    private WorkerCommandPipeHostedService CreateHostedService()
    {
        return new WorkerCommandPipeHostedService(
            _loggerMock.Object,
            _recoveryServiceMock.Object,
            Options.Create(_ipcSettings),
            _orchestratorMock.Object);
    }

    #region 1. Hardware Command Parser Tests (Valid Cases)

    [Fact]
    public void Parser_ValidDispenseCoins_ParsesSuccessfully()
    {
        const string json = "{\"requestId\":\"hw-disp-1\",\"type\":\"DispenseCoins\",\"coinCount\":5,\"timeoutMs\":3000}";

        var parsed = WorkerCommandParser.TryParseHardwareCommand(
            json,
            maxBytes: 8192,
            out var command,
            out var errorDetail,
            out var requestId,
            out var commandType);

        Assert.True(parsed);
        Assert.Null(errorDetail);
        Assert.Equal("hw-disp-1", requestId);
        Assert.Equal("DispenseCoins", commandType);
        Assert.NotNull(command);

        var dispenseCmd = Assert.IsType<DispenseCoinsCommand>(command);
        Assert.Equal("hw-disp-1", dispenseCmd.RequestId);
        Assert.Equal(5, dispenseCmd.CoinCount);
        Assert.Equal(3000, dispenseCmd.TimeoutMs);
    }

    [Fact]
    public void Parser_ValidLockCoinSlot_ParsesSuccessfully()
    {
        const string json = "{\"requestId\":\"hw-lock-1\",\"type\":\"LockCoinSlot\",\"ownerId\":\"pos-terminal-1\",\"reason\":\"maintenance\"}";

        var parsed = WorkerCommandParser.TryParseHardwareCommand(
            json,
            maxBytes: 8192,
            out var command,
            out var errorDetail,
            out var requestId,
            out var commandType);

        Assert.True(parsed);
        Assert.Null(errorDetail);
        Assert.Equal("hw-lock-1", requestId);
        Assert.Equal("LockCoinSlot", commandType);
        Assert.NotNull(command);

        var lockCmd = Assert.IsType<LockCoinSlotCommand>(command);
        Assert.Equal("hw-lock-1", lockCmd.RequestId);
        Assert.Equal("pos-terminal-1", lockCmd.OwnerId);
        Assert.Equal("maintenance", lockCmd.Reason);
    }

    [Fact]
    public void Parser_ValidUnlockCoinSlot_ParsesSuccessfully()
    {
        const string json = "{\"requestId\":\"hw-unlock-1\",\"type\":\"UnlockCoinSlot\",\"ownerId\":\"pos-terminal-1\"}";

        var parsed = WorkerCommandParser.TryParseHardwareCommand(
            json,
            maxBytes: 8192,
            out var command,
            out var errorDetail,
            out var requestId,
            out var commandType);

        Assert.True(parsed);
        Assert.Null(errorDetail);
        Assert.Equal("hw-unlock-1", requestId);
        Assert.Equal("UnlockCoinSlot", commandType);
        Assert.NotNull(command);

        var unlockCmd = Assert.IsType<UnlockCoinSlotCommand>(command);
        Assert.Equal("hw-unlock-1", unlockCmd.RequestId);
        Assert.Equal("pos-terminal-1", unlockCmd.OwnerId);
    }

    [Fact]
    public void Parser_ValidAnnounceKioskIp_ParsesSuccessfully()
    {
        const string json = "{\"requestId\":\"hw-announce-1\",\"type\":\"AnnounceKioskIp\",\"ip\":\"192.168.1.50\",\"port\":3000,\"path\":\"/api/coins\"}";

        var parsed = WorkerCommandParser.TryParseHardwareCommand(
            json,
            maxBytes: 8192,
            out var command,
            out var errorDetail,
            out var requestId,
            out var commandType);

        Assert.True(parsed);
        Assert.Null(errorDetail);
        Assert.Equal("hw-announce-1", requestId);
        Assert.Equal("AnnounceKioskIp", commandType);
        Assert.NotNull(command);

        var announceCmd = Assert.IsType<AnnounceKioskIpCommand>(command);
        Assert.Equal("hw-announce-1", announceCmd.RequestId);
        Assert.Equal("192.168.1.50", announceCmd.Ip);
        Assert.Equal(3000, announceCmd.Port);
        Assert.Equal("/api/coins", announceCmd.Path);
    }

    #endregion

    #region 2. Hardware Command Parser Tests (Invalid Cases)

    [Theory]
    [InlineData("{\"type\":\"DispenseCoins\",\"coinCount\":5}", "", "RequestId is required")]
    [InlineData("{\"requestId\":\"hw-err-1\",\"type\":\"DispenseCoins\",\"coinCount\":0}", "hw-err-1", "CoinCount")]
    [InlineData("{\"requestId\":\"hw-err-2\",\"type\":\"DispenseCoins\"}", "hw-err-2", "CoinCount")]
    [InlineData("{\"requestId\":\"hw-err-3\",\"type\":\"LockCoinSlot\"}", "hw-err-3", "OwnerId")]
    [InlineData("{\"requestId\":\"hw-err-4\",\"type\":\"UnlockCoinSlot\",\"ownerId\":\"\"}", "hw-err-4", "OwnerId")]
    [InlineData("{\"requestId\":\"hw-err-5\",\"type\":\"AnnounceKioskIp\",\"port\":3000,\"path\":\"/kiosk\"}", "hw-err-5", "Ip")]
    [InlineData("{\"requestId\":\"hw-err-6\",\"type\":\"AnnounceKioskIp\",\"ip\":\"127.0.0.1\",\"port\":-1,\"path\":\"/kiosk\"}", "hw-err-6", "Port")]
    [InlineData("{\"requestId\":\"hw-err-7\",\"type\":\"AnnounceKioskIp\",\"ip\":\"127.0.0.1\",\"port\":80}", "hw-err-7", "Path")]
    public void Parser_InvalidPayloads_ReturnFalseWithRequestIdAndError(
        string json,
        string expectedRequestId,
        string expectedErrorSubstring)
    {
        var parsed = WorkerCommandParser.TryParseHardwareCommand(
            json,
            maxBytes: 8192,
            out var command,
            out var errorDetail,
            out var requestId,
            out _);

        Assert.False(parsed);
        Assert.Null(command);
        Assert.Equal(expectedRequestId, requestId);
        Assert.NotNull(errorDetail);
        Assert.Contains(expectedErrorSubstring, errorDetail, StringComparison.OrdinalIgnoreCase);
    }

    #endregion

    #region 3. Dispatch & Structured Response Tests: DispenseCoins

    [Fact]
    public async Task ProcessRequestAsync_ValidDispenseCoins_DispatchesToOrchestrator_AndSerializesResponse()
    {
        var service = CreateHostedService();

        _orchestratorMock
            .Setup(o => o.DispenseCoinsAsync("dispense-101", 5, 6000, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HopperDispenseResult(true, "dispense-101", 5, null, "Coins dispensed successfully"));

        const string requestJson = "{\"requestId\":\"dispense-101\",\"type\":\"DispenseCoins\",\"coinCount\":5,\"timeoutMs\":6000}\n";
        using var inputStream = new MemoryStream(Encoding.UTF8.GetBytes(requestJson));
        using var outputStream = new MemoryStream();

        await service.ProcessRequestAsync(inputStream, outputStream, CancellationToken.None);

        _orchestratorMock.Verify(
            o => o.DispenseCoinsAsync("dispense-101", 5, 6000, It.IsAny<CancellationToken>()),
            Times.Once);

        var responseString = Encoding.UTF8.GetString(outputStream.ToArray());
        Assert.EndsWith("\n", responseString);

        var response = JsonSerializer.Deserialize<DispenseCoinsResponse>(
            responseString.TrimEnd('\r', '\n'),
            WorkerCommandParser.JsonOptions);

        Assert.NotNull(response);
        Assert.Equal("dispense-101", response.RequestId);
        Assert.Equal("DispenseCoins", response.Type);
        Assert.True(response.Success);
        Assert.Equal(5, response.DispensedCoins);
        Assert.Null(response.ErrorCode);
        Assert.Equal("Coins dispensed successfully", response.Message);
    }

    #endregion

    #region 4. Dispatch & Structured Response Tests: LockCoinSlot & UnlockCoinSlot

    [Fact]
    public async Task ProcessRequestAsync_ValidLockCoinSlot_DispatchesToOrchestrator_AndSerializesResponse()
    {
        var service = CreateHostedService();

        const string requestJson = "{\"requestId\":\"lock-101\",\"type\":\"LockCoinSlot\",\"ownerId\":\"session-abc\",\"reason\":\"busy\"}\n";
        using var inputStream = new MemoryStream(Encoding.UTF8.GetBytes(requestJson));
        using var outputStream = new MemoryStream();

        await service.ProcessRequestAsync(inputStream, outputStream, CancellationToken.None);

        _orchestratorMock.Verify(
            o => o.LockCoinSlot("session-abc", "busy"),
            Times.Once);

        var responseString = Encoding.UTF8.GetString(outputStream.ToArray());
        Assert.EndsWith("\n", responseString);

        var response = JsonSerializer.Deserialize<LockCoinSlotResponse>(
            responseString.TrimEnd('\r', '\n'),
            WorkerCommandParser.JsonOptions);

        Assert.NotNull(response);
        Assert.Equal("lock-101", response.RequestId);
        Assert.Equal("LockCoinSlot", response.Type);
        Assert.True(response.Success);
    }

    [Fact]
    public async Task ProcessRequestAsync_ValidUnlockCoinSlot_DispatchesToOrchestrator_AndSerializesResponse()
    {
        var service = CreateHostedService();

        _orchestratorMock
            .Setup(o => o.UnlockCoinSlot("session-abc"))
            .Returns(true);

        const string requestJson = "{\"requestId\":\"unlock-101\",\"type\":\"UnlockCoinSlot\",\"ownerId\":\"session-abc\"}\n";
        using var inputStream = new MemoryStream(Encoding.UTF8.GetBytes(requestJson));
        using var outputStream = new MemoryStream();

        await service.ProcessRequestAsync(inputStream, outputStream, CancellationToken.None);

        _orchestratorMock.Verify(
            o => o.UnlockCoinSlot("session-abc"),
            Times.Once);

        var responseString = Encoding.UTF8.GetString(outputStream.ToArray());
        Assert.EndsWith("\n", responseString);

        var response = JsonSerializer.Deserialize<UnlockCoinSlotResponse>(
            responseString.TrimEnd('\r', '\n'),
            WorkerCommandParser.JsonOptions);

        Assert.NotNull(response);
        Assert.Equal("unlock-101", response.RequestId);
        Assert.Equal("UnlockCoinSlot", response.Type);
        Assert.True(response.Success);
        Assert.True(response.Unlocked);
    }

    #endregion

    #region 5. Dispatch & Structured Response Tests: AnnounceKioskIp

    [Fact]
    public async Task ProcessRequestAsync_ValidAnnounceKioskIp_DispatchesToOrchestrator_AndSerializesResponse()
    {
        var service = CreateHostedService();

        const string requestJson = "{\"requestId\":\"ip-101\",\"type\":\"AnnounceKioskIp\",\"ip\":\"192.168.1.10\",\"port\":8080,\"path\":\"/kiosk\"}\n";
        using var inputStream = new MemoryStream(Encoding.UTF8.GetBytes(requestJson));
        using var outputStream = new MemoryStream();

        await service.ProcessRequestAsync(inputStream, outputStream, CancellationToken.None);

        _orchestratorMock.Verify(
            o => o.AnnounceKioskIp("192.168.1.10", 8080, "/kiosk"),
            Times.Once);

        var responseString = Encoding.UTF8.GetString(outputStream.ToArray());
        Assert.EndsWith("\n", responseString);

        var response = JsonSerializer.Deserialize<AnnounceKioskIpResponse>(
            responseString.TrimEnd('\r', '\n'),
            WorkerCommandParser.JsonOptions);

        Assert.NotNull(response);
        Assert.Equal("ip-101", response.RequestId);
        Assert.Equal("AnnounceKioskIp", response.Type);
        Assert.True(response.Success);
    }

    #endregion

    #region 6. Invalid Hardware Request Handling (No Throw, Structured Error)

    [Fact]
    public async Task ProcessRequestAsync_InvalidHardwarePayload_ReturnsStructuredErrorResponseWithoutThrowing()
    {
        var service = CreateHostedService();

        const string requestJson = "{\"requestId\":\"bad-hw-1\",\"type\":\"DispenseCoins\",\"coinCount\":-3}\n";
        using var inputStream = new MemoryStream(Encoding.UTF8.GetBytes(requestJson));
        using var outputStream = new MemoryStream();

        await service.ProcessRequestAsync(inputStream, outputStream, CancellationToken.None);

        _orchestratorMock.Verify(
            o => o.DispenseCoinsAsync(It.IsAny<string>(), It.IsAny<int>(), It.IsAny<int?>(), It.IsAny<CancellationToken>()),
            Times.Never);

        var responseString = Encoding.UTF8.GetString(outputStream.ToArray());
        Assert.EndsWith("\n", responseString);

        var response = JsonSerializer.Deserialize<HardwareErrorResponse>(
            responseString.TrimEnd('\r', '\n'),
            WorkerCommandParser.JsonOptions);

        Assert.NotNull(response);
        Assert.Equal("bad-hw-1", response.RequestId);
        Assert.Equal("DispenseCoins", response.Type);
        Assert.False(response.Success);
        Assert.Equal("INVALID_REQUEST", response.ErrorCode);
        Assert.Contains("CoinCount", response.Message);
    }

    #endregion

    #region 7. Hardware Event Broadcasting Tests via HardwareOrchestrator

    [Fact]
    public async Task HardwareOrchestrator_BroadcastsHardwareEvents_ToEventPipeClient()
    {
        var eventPipeMock = new Mock<IWorkerEventPipeClient>();
        var sentEvents = new System.Collections.Generic.List<WorkerPrintEvent>();

        eventPipeMock
            .Setup(p => p.SendAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Callback<WorkerPrintEvent, CancellationToken>((evt, _) => sentEvents.Add(evt))
            .ReturnsAsync(true);

        var coinAcceptorMock = new Mock<ICoinAcceptor>();
        var hopperMock = new Mock<IHopper>();

        var sut = new HardwareOrchestrator(
            Microsoft.Extensions.Logging.Abstractions.NullLogger<HardwareOrchestrator>.Instance,
            new Mock<ISerialConnection>().Object,
            new Mock<IEsp32Device>().Object,
            coinAcceptorMock.Object,
            hopperMock.Object,
            new CoinPulseDecoder(),
            eventPipeClient: eventPipeMock.Object);

        // 1. CoinAccepted -> CoinInserted event
        coinAcceptorMock.Raise(c => c.CoinAccepted += null, coinAcceptorMock.Object, 10);
        Assert.Contains(sentEvents, e => e.Type == WorkerPrintEventType.CoinInserted && e.CoinValue == 10);

        // 2. CoinRejected -> CoinRejected event
        coinAcceptorMock.Raise(c => c.CoinRejected += null, coinAcceptorMock.Object, (5, "power_emergency"));
        Assert.Contains(sentEvents, e => e.Type == WorkerPrintEventType.CoinRejected && e.CoinValue == 5 && e.RejectReason == "power_emergency");

        // 3. ProgressReceived -> HopperProgress event
        hopperMock.Raise(h => h.ProgressReceived += null, hopperMock.Object, ("req-hop-1", 3, 5));
        Assert.Contains(sentEvents, e => e.Type == WorkerPrintEventType.HopperProgress && e.RequestId == "req-hop-1" && e.DispensedCoins == 3 && e.TotalCoins == 5);

        // 4. DispenseCoinsAsync -> HopperDispensed event
        hopperMock
            .Setup(h => h.DispenseAsync("req-hop-done", 4, It.IsAny<int?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HopperDispenseResult(true, "req-hop-done", 4, null, "Dispense ok"));

        await sut.DispenseCoinsAsync("req-hop-done", 4);
        Assert.Contains(sentEvents, e => e.Type == WorkerPrintEventType.HopperDispensed && e.RequestId == "req-hop-done" && e.DispensedCoins == 4);
    }

    #endregion

    #region 8. DI Resolution: WorkerCommandPipeHostedService resolves both services

    [Fact]
    public void ServiceCollection_WorkerCommandPipeHostedService_ResolvesBothRecoveryServiceAndHardwareOrchestrator()
    {
        var services = new ServiceCollection();

        services.AddLogging();
        services.Configure<PrinterRecoverySettings>(_ => { });
        services.Configure<IpcSettings>(_ => { });
        services.Configure<HardwareSettings>(_ => { });

        var mockHealthMonitor = new Mock<IPrinterHealthMonitor>();
        services.AddSingleton(mockHealthMonitor.Object);

        services.AddSingleton<IPrinterOperationCoordinator, PrintOperationCoordinator>();
        services.AddSingleton<IPrintSpoolerController, ServiceControllerSpoolerController>();
        services.AddSingleton<IPrinterRecoveryService, PrinterRecoveryService>();

        var mockOrchestrator = new Mock<IHardwareOrchestrator>();
        services.AddSingleton<IHardwareOrchestrator>(mockOrchestrator.Object);

        services.AddHostedService<WorkerCommandPipeHostedService>();

        using var provider = services.BuildServiceProvider();

        var recoverySingleton = provider.GetRequiredService<IPrinterRecoveryService>();
        var orchestratorSingleton = provider.GetRequiredService<IHardwareOrchestrator>();

        var hostedService = provider.GetServices<IHostedService>()
            .OfType<WorkerCommandPipeHostedService>()
            .Single();

        var recoveryField = typeof(WorkerCommandPipeHostedService).GetField("_recoveryService", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
        Assert.NotNull(recoveryField);
        var injectedRecovery = recoveryField.GetValue(hostedService);
        Assert.Same(recoverySingleton, injectedRecovery);

        var orchestratorField = typeof(WorkerCommandPipeHostedService).GetField("_hardwareOrchestrator", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
        Assert.NotNull(orchestratorField);
        var injectedOrchestrator = orchestratorField.GetValue(hostedService);
        Assert.Same(orchestratorSingleton, injectedOrchestrator);
    }

    [Fact]
    public async Task ProcessRequestAsync_OrchestratorUnavailable_ReturnsStructuredUnavailableError()
    {
        var service = new WorkerCommandPipeHostedService(
            _loggerMock.Object,
            _recoveryServiceMock.Object,
            Options.Create(_ipcSettings),
            hardwareOrchestrator: null);

        const string json = "{\"requestId\":\"req-no-orch\",\"type\":\"LockCoinSlot\",\"ownerId\":\"session-1\"}\n";
        using var inputStream = new MemoryStream(Encoding.UTF8.GetBytes(json));
        using var outputStream = new MemoryStream();

        var result = await service.ProcessRequestAsync(inputStream, outputStream, CancellationToken.None);

        Assert.Null(result);
        var responseString = Encoding.UTF8.GetString(outputStream.ToArray());
        var error = JsonSerializer.Deserialize<HardwareErrorResponse>(responseString, WorkerCommandParser.JsonOptions);

        Assert.NotNull(error);
        Assert.Equal("req-no-orch", error.RequestId);
        Assert.Equal("HARDWARE_ORCHESTRATOR_UNAVAILABLE", error.ErrorCode);
        Assert.False(error.Success);
    }

    [Fact]
    public async Task ProcessRequestAsync_OrchestratorThrowsException_ReturnsCommandExecutionError()
    {
        var service = CreateHostedService();

        _orchestratorMock
            .Setup(o => o.DispenseCoinsAsync("req-err", 5, null, It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("Hardware driver crashed"));

        const string json = "{\"requestId\":\"req-err\",\"type\":\"DispenseCoins\",\"coinCount\":5}\n";
        using var inputStream = new MemoryStream(Encoding.UTF8.GetBytes(json));
        using var outputStream = new MemoryStream();

        var result = await service.ProcessRequestAsync(inputStream, outputStream, CancellationToken.None);

        Assert.Null(result);
        var responseString = Encoding.UTF8.GetString(outputStream.ToArray());
        var error = JsonSerializer.Deserialize<HardwareErrorResponse>(responseString, WorkerCommandParser.JsonOptions);

        Assert.NotNull(error);
        Assert.Equal("req-err", error.RequestId);
        Assert.Equal("COMMAND_EXECUTION_ERROR", error.ErrorCode);
        Assert.False(error.Success);
        Assert.Contains("Hardware driver crashed", error.Message);
    }

    [Fact]
    public async Task ProcessRequestAsync_DispenseCoinsFailure_ReturnsStructuredFailureResponse()
    {
        var service = CreateHostedService();

        _orchestratorMock
            .Setup(o => o.DispenseCoinsAsync("req-fail", 10, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HopperDispenseResult(false, "req-fail", 3, "TIMEOUT", "Hopper timed out"));

        const string json = "{\"requestId\":\"req-fail\",\"type\":\"DispenseCoins\",\"coinCount\":10}\n";
        using var inputStream = new MemoryStream(Encoding.UTF8.GetBytes(json));
        using var outputStream = new MemoryStream();

        var result = await service.ProcessRequestAsync(inputStream, outputStream, CancellationToken.None);

        Assert.Null(result);
        var responseString = Encoding.UTF8.GetString(outputStream.ToArray());
        var response = JsonSerializer.Deserialize<DispenseCoinsResponse>(responseString, WorkerCommandParser.JsonOptions);

        Assert.NotNull(response);
        Assert.Equal("req-fail", response.RequestId);
        Assert.False(response.Success);
        Assert.Equal(3, response.DispensedCoins);
        Assert.Equal("TIMEOUT", response.ErrorCode);
        Assert.Equal("Hopper timed out", response.Message);
    }

    [Fact]
    public void Parser_AnnounceKioskIp_PortAbove65535_ReturnsFalse()
    {
        const string json = "{\"requestId\":\"req-port-high\",\"type\":\"AnnounceKioskIp\",\"ip\":\"192.168.1.1\",\"port\":70000,\"path\":\"/\"}";

        var parsed = WorkerCommandParser.TryParseHardwareCommand(
            json,
            maxBytes: 8192,
            out var command,
            out var errorDetail,
            out var requestId,
            out var commandType);

        Assert.False(parsed);
        Assert.Null(command);
        Assert.Contains("65535", errorDetail);
    }

    #endregion
}
