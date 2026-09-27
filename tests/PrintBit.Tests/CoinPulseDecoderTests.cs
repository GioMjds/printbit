using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using PrintBit.Hardware.Devices.CoinAcceptor;
using Xunit;

namespace PrintBit.Tests;

public class CoinPulseDecoderTests
{
    private class ManualTimeProvider : TimeProvider
    {
        private readonly List<ManualTimer> _timers = new();
        private readonly object _lock = new();

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            lock (_lock)
            {
                var timer = new ManualTimer(callback, state, dueTime, period);
                _timers.Add(timer);
                return timer;
            }
        }

        public void Advance(TimeSpan delta)
        {
            List<ManualTimer> timersToTrigger = new();
            lock (_lock)
            {
                foreach (var timer in _timers)
                {
                    if (timer.IsActive)
                    {
                        timersToTrigger.Add(timer);
                    }
                }
            }

            foreach (var timer in timersToTrigger)
            {
                timer.Trigger();
            }
        }

        private sealed class ManualTimer : ITimer
        {
            private readonly TimerCallback _callback;
            private readonly object? _state;
            private bool _active;
            private bool _disposed;

            public bool IsActive
            {
                get
                {
                    lock (this)
                    {
                        return _active && !_disposed;
                    }
                }
            }

            public ManualTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
            {
                _callback = callback;
                _state = state;
                _active = dueTime != Timeout.InfiniteTimeSpan && dueTime > TimeSpan.Zero;
            }

            public bool Change(TimeSpan dueTime, TimeSpan period)
            {
                lock (this)
                {
                    if (_disposed) return false;
                    _active = dueTime != Timeout.InfiniteTimeSpan && dueTime >= TimeSpan.Zero;
                    return true;
                }
            }

            public void Trigger()
            {
                lock (this)
                {
                    if (!_active || _disposed) return;
                    _active = false;
                }
                _callback(_state);
            }

            public void Dispose()
            {
                lock (this)
                {
                    _disposed = true;
                    _active = false;
                }
            }

            public ValueTask DisposeAsync()
            {
                Dispose();
                return ValueTask.CompletedTask;
            }
        }
    }

    [Fact]
    public void Token_5_FiresCoinResolved5Immediately()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var resolved = new List<int>();
        decoder.CoinResolved += (_, val) => resolved.Add(val);

        decoder.ProcessToken("5");

        Assert.Single(resolved);
        Assert.Equal(5, resolved[0]);
    }

    [Fact]
    public void Token_1_FollowedBy_0_WithinWindow_FiresCoinResolved10()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var resolved = new List<int>();
        decoder.CoinResolved += (_, val) => resolved.Add(val);

        decoder.ProcessToken("1");
        Assert.Empty(resolved);

        decoder.ProcessToken("0");
        Assert.Single(resolved);
        Assert.Equal(10, resolved[0]);
    }

    [Fact]
    public void Token_2_FollowedBy_0_WithinWindow_FiresCoinResolved20()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var resolved = new List<int>();
        decoder.CoinResolved += (_, val) => resolved.Add(val);

        decoder.ProcessToken("2");
        Assert.Empty(resolved);

        decoder.ProcessToken("0");
        Assert.Single(resolved);
        Assert.Equal(20, resolved[0]);
    }

    [Fact]
    public void Token_1_FollowedBy_WindowExpiration_FiresCoinResolved1()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var resolved = new List<int>();
        decoder.CoinResolved += (_, val) => resolved.Add(val);

        decoder.ProcessToken("1");
        Assert.Empty(resolved);

        timeProvider.Advance(TimeSpan.FromMilliseconds(140));

        Assert.Single(resolved);
        Assert.Equal(1, resolved[0]);
    }

    [Fact]
    public void Token_2_FollowedBy_WindowExpiration_FiresWarningEmitted_InvalidFragment()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var resolved = new List<int>();
        var warnings = new List<(string Code, string Message)>();
        decoder.CoinResolved += (_, val) => resolved.Add(val);
        decoder.WarningEmitted += (_, w) => warnings.Add(w);

        decoder.ProcessToken("2");
        Assert.Empty(resolved);
        Assert.Empty(warnings);

        timeProvider.Advance(TimeSpan.FromMilliseconds(140));

        Assert.Empty(resolved);
        Assert.Single(warnings);
        Assert.Equal("INVALID_FRAGMENT", warnings[0].Code);
        Assert.Contains("2", warnings[0].Message);
    }

    [Fact]
    public void Token_1_FollowedImmediatelyBy_Flush_FiresCoinResolved1()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var resolved = new List<int>();
        decoder.CoinResolved += (_, val) => resolved.Add(val);

        decoder.ProcessToken("1");
        Assert.Empty(resolved);

        decoder.Flush();

        Assert.Single(resolved);
        Assert.Equal(1, resolved[0]);

        // Subsequent time advance should NOT fire another event
        timeProvider.Advance(TimeSpan.FromMilliseconds(140));
        Assert.Single(resolved);
    }

    [Fact]
    public void Token_2_FollowedImmediatelyBy_Flush_FiresWarningEmitted()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var warnings = new List<(string Code, string Message)>();
        decoder.WarningEmitted += (_, w) => warnings.Add(w);

        decoder.ProcessToken("2");
        Assert.Empty(warnings);

        decoder.Flush();

        Assert.Single(warnings);
        Assert.Equal("INVALID_FRAGMENT", warnings[0].Code);

        // Subsequent time advance should NOT fire another event
        timeProvider.Advance(TimeSpan.FromMilliseconds(140));
        Assert.Single(warnings);
    }

    [Fact]
    public void Flush_WithNoPendingFragment_DoesNothing()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var resolved = new List<int>();
        var warnings = new List<(string Code, string Message)>();
        decoder.CoinResolved += (_, val) => resolved.Add(val);
        decoder.WarningEmitted += (_, w) => warnings.Add(w);

        decoder.Flush();

        Assert.Empty(resolved);
        Assert.Empty(warnings);
    }

    [Fact]
    public void RapidSuccessiveCoins_1_Then_5_Resolves1Then5()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var resolved = new List<int>();
        decoder.CoinResolved += (_, val) => resolved.Add(val);

        decoder.ProcessToken("1");
        decoder.ProcessToken("5");

        Assert.Equal(2, resolved.Count);
        Assert.Equal(1, resolved[0]);
        Assert.Equal(5, resolved[1]);
    }

    [Fact]
    public void RapidSuccessiveCoins_2_Then_5_EmitsWarningThenResolves5()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var resolved = new List<int>();
        var warnings = new List<(string Code, string Message)>();
        decoder.CoinResolved += (_, val) => resolved.Add(val);
        decoder.WarningEmitted += (_, w) => warnings.Add(w);

        decoder.ProcessToken("2");
        decoder.ProcessToken("5");

        Assert.Single(warnings);
        Assert.Equal("INVALID_FRAGMENT", warnings[0].Code);
        Assert.Single(resolved);
        Assert.Equal(5, resolved[0]);
    }

    [Fact]
    public void RapidSuccessiveCoins_1_Then_1_ResolvesFirst1AndBuffersSecond1()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var resolved = new List<int>();
        decoder.CoinResolved += (_, val) => resolved.Add(val);

        decoder.ProcessToken("1");
        decoder.ProcessToken("1");

        // First 1 should be resolved, second 1 is buffered waiting for possible '0'
        Assert.Single(resolved);
        Assert.Equal(1, resolved[0]);

        decoder.ProcessToken("0");
        Assert.Equal(2, resolved.Count);
        Assert.Equal(10, resolved[1]);
    }

    [Fact]
    public void Unmatched_0_WithoutPendingFragment_EmitsWarning_UnexpectedZero()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var warnings = new List<(string Code, string Message)>();
        decoder.WarningEmitted += (_, w) => warnings.Add(w);

        decoder.ProcessToken("0");

        Assert.Single(warnings);
        Assert.Equal("UNEXPECTED_ZERO", warnings[0].Code);
    }

    [Fact]
    public void MultipleTokens_5_InSuccession_ResolvesEachImmediately()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var resolved = new List<int>();
        decoder.CoinResolved += (_, val) => resolved.Add(val);

        decoder.ProcessToken("5");
        decoder.ProcessToken("5");
        decoder.ProcessToken("5");

        Assert.Equal(new[] { 5, 5, 5 }, resolved);
    }

    [Fact]
    public void Dispose_CancelsPendingTimer_DoesNotFirePendingEvents()
    {
        var timeProvider = new ManualTimeProvider();
        var decoder = new CoinPulseDecoder(140, timeProvider);
        var resolved = new List<int>();
        decoder.CoinResolved += (_, val) => resolved.Add(val);

        decoder.ProcessToken("1");
        decoder.Dispose();

        timeProvider.Advance(TimeSpan.FromMilliseconds(140));

        Assert.Empty(resolved);
    }

    [Fact]
    public void ProcessToken_AfterDispose_DoesNotFireEvents()
    {
        var timeProvider = new ManualTimeProvider();
        var decoder = new CoinPulseDecoder(140, timeProvider);
        var resolved = new List<int>();
        decoder.CoinResolved += (_, val) => resolved.Add(val);

        decoder.Dispose();
        decoder.ProcessToken("5");

        Assert.Empty(resolved);
    }

    [Fact]
    public void Token_WithWhitespaceOrNewlines_ParsedCorrectly()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var resolved = new List<int>();
        decoder.CoinResolved += (_, val) => resolved.Add(val);

        decoder.ProcessToken("  1 \r\n");
        decoder.ProcessToken(" 0\n");

        Assert.Single(resolved);
        Assert.Equal(10, resolved[0]);
    }

    [Fact]
    public void UnknownToken_EmitsWarning_UnexpectedToken()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var warnings = new List<(string Code, string Message)>();
        decoder.WarningEmitted += (_, w) => warnings.Add(w);

        decoder.ProcessToken("9");

        Assert.Single(warnings);
        Assert.Equal("UNEXPECTED_TOKEN", warnings[0].Code);
    }

    [Fact]
    public void ProcessToken_NullOrEmpty_HandledGracefully()
    {
        var timeProvider = new ManualTimeProvider();
        using var decoder = new CoinPulseDecoder(140, timeProvider);
        var resolved = new List<int>();
        var warnings = new List<(string Code, string Message)>();
        decoder.CoinResolved += (_, val) => resolved.Add(val);
        decoder.WarningEmitted += (_, w) => warnings.Add(w);

        Assert.Throws<ArgumentNullException>(() => decoder.ProcessToken(null!));
        decoder.ProcessToken("   ");

        Assert.Empty(resolved);
        Assert.Empty(warnings);
    }

    [Fact]
    public async Task RealTimer_WindowExpiration_WorksWithWallClock()
    {
        // Integration test with real system timer and a short 40ms window
        using var decoder = new CoinPulseDecoder(fragmentWindowMs: 40);
        var resolved = new List<int>();
        using var signal = new ManualResetEventSlim(false);

        decoder.CoinResolved += (_, val) =>
        {
            resolved.Add(val);
            signal.Set();
        };

        decoder.ProcessToken("1");
        Assert.Empty(resolved);

        // Wait up to 500ms for 40ms window to expire
        var signaled = await Task.Run(() => signal.Wait(500));

        Assert.True(signaled, "Expected timer to expire and resolve coin 1");
        Assert.Single(resolved);
        Assert.Equal(1, resolved[0]);
    }
}
