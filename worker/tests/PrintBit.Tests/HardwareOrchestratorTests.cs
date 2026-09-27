using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;
using PrintBit.Application.Events;
using PrintBit.Application.Handlers;
using PrintBit.Application.Services;
using PrintBit.Application.StateMachine;
using PrintBit.Hardware.Devices.CoinAcceptor;
using PrintBit.Hardware.Devices.ESP32;
using PrintBit.Hardware.Devices.Hopper;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Infrastructure.Services.SerialService;
using PrintBit.Shared.Configurations;
using PrintBit.Shared.Enums;
using Xunit;

namespace PrintBit.Tests;

public class HardwareOrchestratorTests
{
    [Fact]
    public async Task PrintRequest_IsRejectedOutsideReadyToPrint()
    {
        var printService = new OrchestratorFakePrintService();
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        var pipeServer = new FakeNamedPipeServer();
        var sut = CreateSut(stateMachine, printService, pipeServer);

        var accepted = await sut.HandlePrintRequestAsync(
            new StartPrintEvent { FilePath = @"C:\PrintBit\sample.pdf" },
            "queue");

        Assert.False(accepted);
        Assert.Equal(0, printService.CallCount);
    }

    [Fact]
    public async Task PrintRequest_RunsWhenReadyToPrint()
    {
        var printService = new OrchestratorFakePrintService();
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        stateMachine.TryInsertCoin(5);
        var pipeServer = new FakeNamedPipeServer();
        var sut = CreateSut(stateMachine, printService, pipeServer);

        var accepted = await sut.HandlePrintRequestAsync(
            new StartPrintEvent { FilePath = @"C:\PrintBit\sample.pdf" },
            "queue");

        Assert.True(accepted);
        Assert.Equal(1, printService.CallCount);
        Assert.Equal(TransactionState.Success, stateMachine.CurrentState);
    }

    [Fact]
    public async Task ResetPipeCommand_ResetsFailedTransaction()
    {
        var printService = new OrchestratorFakePrintService();
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        stateMachine.TryInsertCoin(5);
        stateMachine.TryStartPrinting();
        stateMachine.TryMarkFailed("verification failed");
        var pipeServer = new FakeNamedPipeServer();
        var sut = CreateSut(stateMachine, printService, pipeServer);

        await sut.HandlePipeMessageAsync(
            new PipeMessage
            {
                Type = PipeMessageType.ResetTransactionRequest
            });

        Assert.Equal(TransactionState.Idle, stateMachine.CurrentState);
        Assert.Equal(0m, stateMachine.CurrentBalance);
    }

    [Fact]
    public void SerialLine_WithDirectCoinToken_RoutesToPulseDecoder()
    {
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        var printService = new OrchestratorFakePrintService();
        var pipeServer = new FakeNamedPipeServer();
        var serialMock = new Mock<ISerialConnection>();
        var pulseDecoder = new CoinPulseDecoder();

        var resolvedCoins = new List<int>();
        pulseDecoder.CoinResolved += (_, coin) => resolvedCoins.Add(coin);

        using var sut = CreateSut(stateMachine, printService, pipeServer, serialMock: serialMock, pulseDecoder: pulseDecoder);

        // Raise serial line "5"
        serialMock.Raise(s => s.LineReceived += null, serialMock.Object, "5");

        Assert.Single(resolvedCoins);
        Assert.Equal(5, resolvedCoins[0]);
    }

    [Fact]
    public void SerialLine_WithCoinPrefixToken_RoutesToPulseDecoder()
    {
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        var printService = new OrchestratorFakePrintService();
        var pipeServer = new FakeNamedPipeServer();
        var serialMock = new Mock<ISerialConnection>();
        var pulseDecoder = new CoinPulseDecoder();

        var resolvedCoins = new List<int>();
        pulseDecoder.CoinResolved += (_, coin) => resolvedCoins.Add(coin);

        using var sut = CreateSut(stateMachine, printService, pipeServer, serialMock: serialMock, pulseDecoder: pulseDecoder);

        // Raise serial line "COIN:5"
        serialMock.Raise(s => s.LineReceived += null, serialMock.Object, "COIN:5");

        Assert.Single(resolvedCoins);
        Assert.Equal(5, resolvedCoins[0]);
    }

    [Fact]
    public void SerialLine_WithCoinPrefixToken_LogsTheReceivedPulse()
    {
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        var printService = new OrchestratorFakePrintService();
        var pipeServer = new FakeNamedPipeServer();
        var serialMock = new Mock<ISerialConnection>();
        var logger = new RecordingLogger<HardwareOrchestrator>();

        using var sut = CreateSut(
            stateMachine,
            printService,
            pipeServer,
            serialMock: serialMock,
            logger: logger);

        serialMock.Raise(s => s.LineReceived += null, serialMock.Object, "COIN:5");

        Assert.Contains(
            logger.Entries,
            entry => entry.Level == LogLevel.Information &&
                     entry.Message == "Coin pulse received: 5 (source: COIN)");
    }

    [Fact]
    public void SerialLine_WithEsp32CoinPulse_LogsTheResolvedDenomination()
    {
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        var printService = new OrchestratorFakePrintService();
        var pipeServer = new FakeNamedPipeServer();
        var serialMock = new Mock<ISerialConnection>();
        var logger = new RecordingLogger<HardwareOrchestrator>();

        using var sut = CreateSut(
            stateMachine,
            printService,
            pipeServer,
            serialMock: serialMock,
            logger: logger);

        serialMock.Raise(s => s.LineReceived += null, serialMock.Object, "coin_pulse:10");

        Assert.Contains(
            logger.Entries,
            entry => entry.Level == LogLevel.Information &&
                     entry.Message == "Coin pulse received: 10 (source: ESP32)");
    }

    [Fact]
    public void SerialLine_WithTwoDigitCoinPulses_DecodesCorrectly()
    {
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        var printService = new OrchestratorFakePrintService();
        var pipeServer = new FakeNamedPipeServer();
        var serialMock = new Mock<ISerialConnection>();
        var pulseDecoder = new CoinPulseDecoder();

        var resolvedCoins = new List<int>();
        pulseDecoder.CoinResolved += (_, coin) => resolvedCoins.Add(coin);

        using var sut = CreateSut(stateMachine, printService, pipeServer, serialMock: serialMock, pulseDecoder: pulseDecoder);

        // Send "1" followed by "0" (representing 10 PHP)
        serialMock.Raise(s => s.LineReceived += null, serialMock.Object, "1");
        serialMock.Raise(s => s.LineReceived += null, serialMock.Object, "0");

        Assert.Single(resolvedCoins);
        Assert.Equal(10, resolvedCoins[0]);
    }

    [Fact]
    public void SerialLine_WithUnrelatedLine_DoesNotRouteToDecoder()
    {
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        var printService = new OrchestratorFakePrintService();
        var pipeServer = new FakeNamedPipeServer();
        var serialMock = new Mock<ISerialConnection>();
        var pulseDecoder = new CoinPulseDecoder();

        var resolvedCoins = new List<int>();
        var warnings = new List<string>();
        pulseDecoder.CoinResolved += (_, coin) => resolvedCoins.Add(coin);
        pulseDecoder.WarningEmitted += (_, w) => warnings.Add(w.Code);

        using var sut = CreateSut(stateMachine, printService, pipeServer, serialMock: serialMock, pulseDecoder: pulseDecoder);

        serialMock.Raise(s => s.LineReceived += null, serialMock.Object, "STA_IP:192.168.1.50");
        serialMock.Raise(s => s.LineReceived += null, serialMock.Object, "HOPPER:ACK:req1");
        serialMock.Raise(s => s.LineReceived += null, serialMock.Object, "");

        Assert.Empty(resolvedCoins);
        Assert.Empty(warnings);
    }

    [Fact]
    public void CoinAccepted_TriggersCoinHandlerAndBroadcastsPipeMessage()
    {
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        var printService = new OrchestratorFakePrintService();
        var pipeServer = new FakeNamedPipeServer();
        var coinAcceptorMock = new Mock<ICoinAcceptor>();

        using var sut = CreateSut(stateMachine, printService, pipeServer, coinAcceptorMock: coinAcceptorMock);

        coinAcceptorMock.Raise(c => c.CoinAccepted += null, coinAcceptorMock.Object, 5);

        // Handler should have updated the state machine balance
        Assert.Equal(5m, stateMachine.CurrentBalance);
        Assert.Equal(TransactionState.ReadyToPrint, stateMachine.CurrentState);

        // Pipe server should have broadcast CoinInserted
        Assert.Contains(pipeServer.BroadcastMessages, m => m.Type == PipeMessageType.CoinInserted);
        var coinMsg = pipeServer.BroadcastMessages.First(m => m.Type == PipeMessageType.CoinInserted);
        Assert.NotNull(coinMsg.Payload);
        using var doc = JsonDocument.Parse(coinMsg.Payload);
        Assert.Equal(5, doc.RootElement.GetProperty("amount").GetInt32());

        // Because balance reached ready threshold, TransactionStatus is also broadcast
        Assert.Contains(pipeServer.BroadcastMessages, m => m.Type == PipeMessageType.TransactionStatus);
    }

    [Fact]
    public void CoinRejected_LogsWarningWithoutThrowing()
    {
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        var printService = new OrchestratorFakePrintService();
        var pipeServer = new FakeNamedPipeServer();
        var coinAcceptorMock = new Mock<ICoinAcceptor>();

        using var sut = CreateSut(stateMachine, printService, pipeServer, coinAcceptorMock: coinAcceptorMock);

        // Should not throw
        coinAcceptorMock.Raise(c => c.CoinRejected += null, coinAcceptorMock.Object, (5, "power_emergency"));
    }

    [Fact]
    public void HopperProgressReceived_LogsProgressWithoutThrowing()
    {
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        var printService = new OrchestratorFakePrintService();
        var pipeServer = new FakeNamedPipeServer();
        var hopperMock = new Mock<IHopper>();

        using var sut = CreateSut(stateMachine, printService, pipeServer, hopperMock: hopperMock);

        // Should not throw
        hopperMock.Raise(h => h.ProgressReceived += null, hopperMock.Object, ("req-42", 2, 5));
    }

    [Fact]
    public void CoinSlotLockMethods_DelegateToCoinAcceptor()
    {
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        var printService = new OrchestratorFakePrintService();
        var pipeServer = new FakeNamedPipeServer();
        var coinAcceptorMock = new Mock<ICoinAcceptor>();
        coinAcceptorMock.Setup(c => c.IsLocked).Returns(true);
        coinAcceptorMock.Setup(c => c.Unlock("owner1")).Returns(true);

        using var sut = CreateSut(stateMachine, printService, pipeServer, coinAcceptorMock: coinAcceptorMock);

        Assert.True(sut.IsCoinSlotLocked);
        coinAcceptorMock.Verify(c => c.IsLocked, Times.Once);

        sut.LockCoinSlot("owner1", "test reason");
        coinAcceptorMock.Verify(c => c.Lock("owner1", "test reason"), Times.Once);

        var unlocked = sut.UnlockCoinSlot("owner1");
        Assert.True(unlocked);
        coinAcceptorMock.Verify(c => c.Unlock("owner1"), Times.Once);

        sut.ResetCoinSlotLocks();
        coinAcceptorMock.Verify(c => c.ResetLocks(), Times.Once);
    }

    [Fact]
    public void Esp32Delegation_DelegatesToEsp32Device()
    {
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        var printService = new OrchestratorFakePrintService();
        var pipeServer = new FakeNamedPipeServer();
        var esp32Mock = new Mock<IEsp32Device>();

        using var sut = CreateSut(stateMachine, printService, pipeServer, esp32Mock: esp32Mock);

        sut.AnnounceKioskIp("192.168.4.2", 3000, "/api/coin");
        esp32Mock.Verify(e => e.SendKioskIpAnnouncement("192.168.4.2", 3000, "/api/coin"), Times.Once);

        sut.SendWifiCommand("disconnect");
        esp32Mock.Verify(e => e.SendWifiCommand("disconnect"), Times.Once);
    }

    [Fact]
    public async Task DispenseCoinsAsync_And_IsDispensingCoins_DelegateToHopper()
    {
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        var printService = new OrchestratorFakePrintService();
        var pipeServer = new FakeNamedPipeServer();
        var hopperMock = new Mock<IHopper>();

        hopperMock.Setup(h => h.IsDispensing).Returns(true);
        var expectedResult = new HopperDispenseResult(true, "req-123", 4, null, "Dispensed");
        hopperMock.Setup(h => h.DispenseAsync("req-123", 4, 10000, It.IsAny<CancellationToken>()))
            .ReturnsAsync(expectedResult);

        using var sut = CreateSut(stateMachine, printService, pipeServer, hopperMock: hopperMock);

        Assert.True(sut.IsDispensingCoins);
        hopperMock.Verify(h => h.IsDispensing, Times.Once);

        var result = await sut.DispenseCoinsAsync("req-123", 4, 10000);
        Assert.Same(expectedResult, result);
        hopperMock.Verify(h => h.DispenseAsync("req-123", 4, 10000, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public void Dispose_UnsubscribesEventsFromHardwareComponents()
    {
        var stateMachine = new TransactionStateMachine(NullLogger<TransactionStateMachine>.Instance);
        var printService = new OrchestratorFakePrintService();
        var pipeServer = new FakeNamedPipeServer();
        var serialMock = new Mock<ISerialConnection>();
        var coinAcceptorMock = new Mock<ICoinAcceptor>();
        var hopperMock = new Mock<IHopper>();
        var pulseDecoder = new CoinPulseDecoder();

        var resolvedCoins = new List<int>();
        pulseDecoder.CoinResolved += (_, coin) => resolvedCoins.Add(coin);

        var sut = CreateSut(
            stateMachine,
            printService,
            pipeServer,
            serialMock: serialMock,
            coinAcceptorMock: coinAcceptorMock,
            hopperMock: hopperMock,
            pulseDecoder: pulseDecoder);

        sut.Dispose();

        // Raising events after dispose should not route or process
        serialMock.Raise(s => s.LineReceived += null, serialMock.Object, "5");
        coinAcceptorMock.Raise(c => c.CoinAccepted += null, coinAcceptorMock.Object, 5);

        Assert.Empty(resolvedCoins);
        Assert.Equal(0m, stateMachine.CurrentBalance);
    }

    private static HardwareOrchestrator CreateSut(
        TransactionStateMachine stateMachine,
        OrchestratorFakePrintService printService,
        FakeNamedPipeServer pipeServer,
        Mock<ISerialConnection>? serialMock = null,
        Mock<IEsp32Device>? esp32Mock = null,
        Mock<ICoinAcceptor>? coinAcceptorMock = null,
        Mock<IHopper>? hopperMock = null,
        CoinPulseDecoder? pulseDecoder = null,
        Mock<IWorkerEventPipeClient>? eventPipeMock = null,
        ILogger<HardwareOrchestrator>? logger = null)
    {
        var startPrint = new StartPrintHandler(
            NullLogger<StartPrintHandler>.Instance,
            stateMachine,
            printService,
            Options.Create(new HardwareSettings()));

        var coinHandler = new CoinInsertedHandler(
            NullLogger<CoinInsertedHandler>.Instance,
            stateMachine);

        return new HardwareOrchestrator(
            logger ?? NullLogger<HardwareOrchestrator>.Instance,
            coinHandler,
            startPrint,
            stateMachine,
            pipeServer,
            serialMock?.Object ?? new Mock<ISerialConnection>().Object,
            esp32Mock?.Object ?? new Mock<IEsp32Device>().Object,
            coinAcceptorMock?.Object ?? new Mock<ICoinAcceptor>().Object,
            hopperMock?.Object ?? new Mock<IHopper>().Object,
            pulseDecoder ?? new CoinPulseDecoder(),
            eventPipeMock?.Object);
    }
}

public sealed class RecordingLogger<T> : ILogger<T>
{
    public List<(LogLevel Level, string Message)> Entries { get; } = new();

    public IDisposable? BeginScope<TState>(TState state)
        where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        Entries.Add((logLevel, formatter(state, exception)));
    }
}

public class OrchestratorFakePrintService : IPrintService
{
    public int CallCount { get; private set; }

    public Task<PrintJobResult> PrintAsync(PrintJobRequest request, CancellationToken cancellationToken = default)
    {
        CallCount++;
        return Task.FromResult(new PrintJobResult
        {
            Success = true,
            SumatraProcessSucceeded = true,
            VerificationSucceeded = true
        });
    }
}

public class FakeNamedPipeServer : INamedPipeServer
{
    public List<PipeMessage> BroadcastMessages { get; } = new();

    public event Func<PipeMessage, CancellationToken, Task>? MessageReceived
    {
        add { }
        remove { }
    }

    public Task StartAsync(CancellationToken cancellationToken = default)
    {
        return Task.CompletedTask;
    }

    public Task BroadcastAsync(PipeMessage message, CancellationToken cancellationToken = default)
    {
        BroadcastMessages.Add(message);
        return Task.CompletedTask;
    }
}
