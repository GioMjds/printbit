using System.IO;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrintBit.Hardware.Devices.Hopper;
using PrintBit.Infrastructure.Services.SerialService;
using Xunit;

namespace PrintBit.Tests;

public class HopperDeviceTests : IDisposable
{
    private readonly Mock<ISerialConnection> _serialMock;
    private readonly HopperDevice _sut;

    public HopperDeviceTests()
    {
        _serialMock = new Mock<ISerialConnection>();
        _serialMock.Setup(s => s.IsConnected).Returns(true);
        _sut = new HopperDevice(_serialMock.Object, NullLogger<HopperDevice>.Instance);
    }

    public void Dispose()
    {
        _sut.Dispose();
    }

    [Fact]
    public async Task DispenseAsync_SuccessfulLifecycle_EmitsCommand_FiresProgress_ReturnsSuccess()
    {
        var progressEvents = new List<(string RequestId, int Dispensed, int Total)>();
        _sut.ProgressReceived += (_, args) => progressEvents.Add(args);

        _serialMock.Setup(s => s.SendLine("HOPPER DISPENSE req1 5"))
            .Callback(() =>
            {
                _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "HOPPER ACK req1");
                _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "HOPPER PROGRESS req1 2 5");
                _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "HOPPER PROGRESS req1 5 5");
                _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "HOPPER DONE req1 5");
            });

        var result = await _sut.DispenseAsync("req1", 5, timeoutMs: 1000);

        _serialMock.Verify(s => s.SendLine("HOPPER DISPENSE req1 5"), Times.Once);
        Assert.True(result.Success);
        Assert.Equal("req1", result.RequestId);
        Assert.Equal(5, result.DispensedCoins);
        Assert.Null(result.ErrorCode);
        Assert.Equal("Dispense completed successfully", result.Message);

        Assert.Equal(2, progressEvents.Count);
        Assert.Equal(("req1", 2, 5), progressEvents[0]);
        Assert.Equal(("req1", 5, 5), progressEvents[1]);
        Assert.False(_sut.IsDispensing);
    }

    [Fact]
    public async Task DispenseAsync_WhenAlreadyDispensing_ReturnsHopperBusy()
    {
        _serialMock.Setup(s => s.SendLine("HOPPER DISPENSE req1 10"))
            .Callback(() =>
            {
                // First dispense stays active until unblocked
            });

        var firstDispenseTask = _sut.DispenseAsync("req1", 10, timeoutMs: 5000);
        Assert.True(_sut.IsDispensing);

        var busyResult = await _sut.DispenseAsync("req2", 5, timeoutMs: 1000);

        Assert.False(busyResult.Success);
        Assert.Equal("req2", busyResult.RequestId);
        Assert.Equal(0, busyResult.DispensedCoins);
        Assert.Equal("HOPPER_BUSY", busyResult.ErrorCode);
        Assert.Equal("Another dispense operation is in progress", busyResult.Message);

        // Complete first dispense
        _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "HOPPER DONE req1 10");
        var firstResult = await firstDispenseTask;

        Assert.True(firstResult.Success);
        Assert.False(_sut.IsDispensing);
    }

    [Fact]
    public async Task DispenseAsync_HardwareErrorResponse_ReturnsFailureWithErrorCodeAndDispensedCoins()
    {
        _serialMock.Setup(s => s.SendLine("HOPPER DISPENSE reqA 10"))
            .Callback(() =>
            {
                _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "HOPPER PROGRESS reqA 3 10");
                _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "HOPPER ERR reqA JAM Coin jam detected");
            });

        var result = await _sut.DispenseAsync("reqA", 10, timeoutMs: 1000);

        Assert.False(result.Success);
        Assert.Equal("reqA", result.RequestId);
        Assert.Equal(3, result.DispensedCoins);
        Assert.Equal("JAM", result.ErrorCode);
        Assert.Equal("Coin jam detected", result.Message);
        Assert.False(_sut.IsDispensing);
    }

    [Fact]
    public async Task DispenseAsync_TimeoutWatchdog_WhenNoResponse_ReturnsTimeout()
    {
        var result = await _sut.DispenseAsync("reqT", 5, timeoutMs: 50);

        Assert.False(result.Success);
        Assert.Equal("reqT", result.RequestId);
        Assert.Equal(0, result.DispensedCoins);
        Assert.Equal("TIMEOUT", result.ErrorCode);
        Assert.Equal("Hopper dispense timed out", result.Message);
        Assert.False(_sut.IsDispensing);
    }

    [Fact]
    public async Task DispenseAsync_TimeoutWatchdog_WithPartialProgress_ReturnsTimeoutWithDispensedSoFar()
    {
        _serialMock.Setup(s => s.SendLine("HOPPER DISPENSE reqP 8"))
            .Callback(() =>
            {
                _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "HOPPER PROGRESS reqP 4 8");
            });

        var result = await _sut.DispenseAsync("reqP", 8, timeoutMs: 50);

        Assert.False(result.Success);
        Assert.Equal("reqP", result.RequestId);
        Assert.Equal(4, result.DispensedCoins);
        Assert.Equal("TIMEOUT", result.ErrorCode);
        Assert.Equal("Hopper dispense timed out", result.Message);
        Assert.False(_sut.IsDispensing);
    }

    [Fact]
    public async Task DispenseAsync_IgnoresResponsesForDifferentRequestId()
    {
        var dispenseTask = _sut.DispenseAsync("reqX", 5, timeoutMs: 1000);

        // Hardware sends response for another request
        _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "HOPPER DONE otherReq 10");

        Assert.True(_sut.IsDispensing);
        Assert.False(dispenseTask.IsCompleted);

        // Hardware now sends response for active request
        _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "HOPPER DONE reqX 5");

        var result = await dispenseTask;
        Assert.True(result.Success);
        Assert.Equal("reqX", result.RequestId);
        Assert.Equal(5, result.DispensedCoins);
        Assert.False(_sut.IsDispensing);
    }

    [Fact]
    public async Task DispenseAsync_LegacyDoneResponse_MatchesActiveRequest()
    {
        _serialMock.Setup(s => s.SendLine("HOPPER DISPENSE leg1 3"))
            .Callback(() =>
            {
                _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "DONE");
            });

        var result = await _sut.DispenseAsync("leg1", 3, timeoutMs: 1000);

        Assert.True(result.Success);
        Assert.Equal("leg1", result.RequestId);
        Assert.Equal(3, result.DispensedCoins);
        Assert.Null(result.ErrorCode);
        Assert.Equal("Dispense completed successfully", result.Message);
        Assert.False(_sut.IsDispensing);
    }

    [Fact]
    public async Task DispenseAsync_LegacyHopperOkResponse_MatchesActiveRequest()
    {
        _serialMock.Setup(s => s.SendLine("HOPPER DISPENSE leg2 4"))
            .Callback(() =>
            {
                _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "HOPPER OK");
            });

        var result = await _sut.DispenseAsync("leg2", 4, timeoutMs: 1000);

        Assert.True(result.Success);
        Assert.Equal("leg2", result.RequestId);
        Assert.Equal(4, result.DispensedCoins);
        Assert.Null(result.ErrorCode);
        Assert.False(_sut.IsDispensing);
    }

    [Fact]
    public async Task DispenseAsync_LegacyErrorResponse_MatchesActiveRequest()
    {
        _serialMock.Setup(s => s.SendLine("HOPPER DISPENSE leg3 4"))
            .Callback(() =>
            {
                _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "HOPPER ERROR");
            });

        var result = await _sut.DispenseAsync("leg3", 4, timeoutMs: 1000);

        Assert.False(result.Success);
        Assert.Equal("leg3", result.RequestId);
        Assert.Equal(0, result.DispensedCoins);
        Assert.Equal("ERROR", result.ErrorCode);
        Assert.False(_sut.IsDispensing);
    }

    [Fact]
    public async Task DispenseAsync_CallerCancellation_ReturnsCancelled()
    {
        using var cts = new CancellationTokenSource();

        _serialMock.Setup(s => s.SendLine("HOPPER DISPENSE reqC 10"))
            .Callback(() =>
            {
                cts.Cancel();
            });

        var result = await _sut.DispenseAsync("reqC", 10, timeoutMs: 2000, ct: cts.Token);

        Assert.False(result.Success);
        Assert.Equal("reqC", result.RequestId);
        Assert.Equal("CANCELLED", result.ErrorCode);
        Assert.False(_sut.IsDispensing);
    }

    [Fact]
    public async Task Dispose_UnhooksEvents_AndAbortsPendingDispense()
    {
        var dispenseTask = _sut.DispenseAsync("reqD", 5, timeoutMs: 2000);
        Assert.True(_sut.IsDispensing);

        _sut.Dispose();

        var result = await dispenseTask;
        Assert.False(result.Success);
        Assert.Equal("DISPOSED", result.ErrorCode);
        Assert.False(_sut.IsDispensing);

        // Disposed instance throws on subsequent calls
        await Assert.ThrowsAsync<ObjectDisposedException>(() => _sut.DispenseAsync("reqAfter", 1));
    }

    [Fact]
    public async Task DispenseAsync_InvalidArguments_Throws()
    {
        await Assert.ThrowsAsync<ArgumentException>(() => _sut.DispenseAsync("", 5));
        await Assert.ThrowsAsync<ArgumentException>(() => _sut.DispenseAsync("   ", 5));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => _sut.DispenseAsync("req1", 0));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => _sut.DispenseAsync("req1", -1));
    }

    [Fact]
    public async Task DispenseAsync_DefaultTimeoutCalculation_ComputesCorrectDueTime()
    {
        var timeProvider = new TestTimeProvider();
        using var hopper = new HopperDevice(_serialMock.Object, NullLogger<HopperDevice>.Instance, timeProvider);

        var task = hopper.DispenseAsync("reqCalc", 4); // Math.Max(5000, 5000 + 4 * 1500) = 11000 ms

        Assert.Equal(TimeSpan.FromMilliseconds(11000), timeProvider.LastDueTime);

        timeProvider.FireAll();
        var result = await task;
        Assert.False(result.Success);
        Assert.Equal("TIMEOUT", result.ErrorCode);
    }

    [Fact]
    public async Task DispenseAsync_SendLineFails_ReturnsSendFailedAndResetsDispensing()
    {
        _serialMock.Setup(s => s.SendLine(It.IsAny<string>()))
            .Throws(new IOException("COM port closed"));

        var result = await _sut.DispenseAsync("reqFail", 2, timeoutMs: 1000);

        Assert.False(result.Success);
        Assert.Equal("SEND_FAILED", result.ErrorCode);
        Assert.False(_sut.IsDispensing);
    }

    [Fact]
    public void Constructor_WithLoggerAndSerialConnection_InitializesCorrectly()
    {
        using var dev = new HopperDevice(NullLogger<HopperDevice>.Instance, _serialMock.Object);
        Assert.False(dev.IsDispensing);
    }

    private sealed class TestTimeProvider : TimeProvider
    {
        public TimeSpan LastDueTime { get; private set; }
        private readonly List<TestTimer> _timers = new();
        private readonly object _lock = new();

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            lock (_lock)
            {
                LastDueTime = dueTime;
                var timer = new TestTimer(callback, state);
                _timers.Add(timer);
                return timer;
            }
        }

        public void FireAll()
        {
            List<TestTimer> copy;
            lock (_lock)
            {
                copy = new List<TestTimer>(_timers);
            }
            foreach (var t in copy)
            {
                t.Trigger();
            }
        }

        private sealed class TestTimer : ITimer
        {
            private readonly TimerCallback _callback;
            private readonly object? _state;
            private bool _disposed;

            public TestTimer(TimerCallback callback, object? state)
            {
                _callback = callback;
                _state = state;
            }

            public void Trigger()
            {
                if (!_disposed)
                {
                    _callback(_state);
                }
            }

            public bool Change(TimeSpan dueTime, TimeSpan period) => true;

            public void Dispose()
            {
                _disposed = true;
            }

            public ValueTask DisposeAsync()
            {
                _disposed = true;
                return ValueTask.CompletedTask;
            }
        }
    }
}
