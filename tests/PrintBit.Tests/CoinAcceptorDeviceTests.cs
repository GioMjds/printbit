using System;
using System.Collections.Generic;
using Microsoft.Extensions.Logging;
using Moq;
using PrintBit.Hardware.Devices.CoinAcceptor;
using PrintBit.Infrastructure.Windows.PowerMonitoring;
using Xunit;

namespace PrintBit.Tests;

public class CoinAcceptorDeviceTests : IDisposable
{
    private readonly CoinPulseDecoder _decoder;
    private readonly Mock<IPowerSafetyGate> _mockPowerSafetyGate;
    private readonly Mock<ILogger<CoinAcceptorDevice>> _mockLogger;

    public CoinAcceptorDeviceTests()
    {
        _decoder = new CoinPulseDecoder();
        _mockPowerSafetyGate = new Mock<IPowerSafetyGate>();
        _mockLogger = new Mock<ILogger<CoinAcceptorDevice>>();

        // Default to healthy power dispatch
        _mockPowerSafetyGate.Setup(p => p.IsDispatchAllowed).Returns(true);
    }

    public void Dispose()
    {
        _decoder.Dispose();
    }

    private CoinAcceptorDevice CreateDevice()
    {
        return new CoinAcceptorDevice(_decoder, _mockPowerSafetyGate.Object, _mockLogger.Object);
    }

    [Fact]
    public void IsLocked_HealthyPowerAndNoLocks_ReturnsFalse()
    {
        // Arrange
        _mockPowerSafetyGate.Setup(p => p.IsDispatchAllowed).Returns(true);
        using var device = CreateDevice();

        // Assert
        Assert.False(device.IsLocked);
    }

    [Fact]
    public void IsLocked_PowerEmergency_ReturnsTrue()
    {
        // Arrange
        _mockPowerSafetyGate.Setup(p => p.IsDispatchAllowed).Returns(false);
        using var device = CreateDevice();

        // Assert
        Assert.True(device.IsLocked);
    }

    [Fact]
    public void IsLocked_SessionLockActive_ReturnsTrue()
    {
        // Arrange
        using var device = CreateDevice();
        device.Lock("session-1", "in_transaction");

        // Assert
        Assert.True(device.IsLocked);
    }

    [Fact]
    public void CoinAccepted_HealthyPowerAndNoLocks_EmitsCoinAccepted()
    {
        // Arrange
        using var device = CreateDevice();
        var acceptedCoins = new List<int>();
        var rejectedCoins = new List<(int Value, string Reason)>();

        device.CoinAccepted += (_, val) => acceptedCoins.Add(val);
        device.CoinRejected += (_, args) => rejectedCoins.Add(args);

        // Act
        _decoder.ProcessToken("5");

        // Assert
        Assert.Single(acceptedCoins);
        Assert.Equal(5, acceptedCoins[0]);
        Assert.Empty(rejectedCoins);
    }

    [Fact]
    public void CoinRejected_PowerEmergency_EmitsPowerEmergencyReason()
    {
        // Arrange
        _mockPowerSafetyGate.Setup(p => p.IsDispatchAllowed).Returns(false);
        using var device = CreateDevice();
        var acceptedCoins = new List<int>();
        var rejectedCoins = new List<(int Value, string Reason)>();

        device.CoinAccepted += (_, val) => acceptedCoins.Add(val);
        device.CoinRejected += (_, args) => rejectedCoins.Add(args);

        // Act
        _decoder.ProcessToken("5");

        // Assert
        Assert.Empty(acceptedCoins);
        Assert.Single(rejectedCoins);
        Assert.Equal(5, rejectedCoins[0].Value);
        Assert.Equal("power_emergency", rejectedCoins[0].Reason);
    }

    [Fact]
    public void CoinRejected_SessionLockWithReason_EmitsSpecifiedReason()
    {
        // Arrange
        using var device = CreateDevice();
        device.Lock("session-123", "in_transaction");

        var acceptedCoins = new List<int>();
        var rejectedCoins = new List<(int Value, string Reason)>();

        device.CoinAccepted += (_, val) => acceptedCoins.Add(val);
        device.CoinRejected += (_, args) => rejectedCoins.Add(args);

        // Act
        _decoder.ProcessToken("5");

        // Assert
        Assert.Empty(acceptedCoins);
        Assert.Single(rejectedCoins);
        Assert.Equal(5, rejectedCoins[0].Value);
        Assert.Equal("in_transaction", rejectedCoins[0].Reason);
    }

    [Fact]
    public void CoinRejected_SessionLockWithoutReason_EmitsOwnerIdAsReason()
    {
        // Arrange
        using var device = CreateDevice();
        device.Lock("session-456");

        var rejectedCoins = new List<(int Value, string Reason)>();
        device.CoinRejected += (_, args) => rejectedCoins.Add(args);

        // Act
        _decoder.ProcessToken("5");

        // Assert
        Assert.Single(rejectedCoins);
        Assert.Equal(5, rejectedCoins[0].Value);
        Assert.Equal("session-456", rejectedCoins[0].Reason);
    }

    [Fact]
    public void CoinRejected_PowerEmergencyTakesPrecedenceOverSessionLock()
    {
        // Arrange
        _mockPowerSafetyGate.Setup(p => p.IsDispatchAllowed).Returns(false);
        using var device = CreateDevice();
        device.Lock("session-123", "in_transaction");

        var rejectedCoins = new List<(int Value, string Reason)>();
        device.CoinRejected += (_, args) => rejectedCoins.Add(args);

        // Act
        _decoder.ProcessToken("5");

        // Assert
        Assert.Single(rejectedCoins);
        Assert.Equal(5, rejectedCoins[0].Value);
        Assert.Equal("power_emergency", rejectedCoins[0].Reason);
    }

    [Fact]
    public void Unlock_RemovesLockAndRestoresAcceptance()
    {
        // Arrange
        using var device = CreateDevice();
        device.Lock("session-123", "in_transaction");
        Assert.True(device.IsLocked);

        var acceptedCoins = new List<int>();
        var rejectedCoins = new List<(int Value, string Reason)>();
        device.CoinAccepted += (_, val) => acceptedCoins.Add(val);
        device.CoinRejected += (_, args) => rejectedCoins.Add(args);

        // Act
        bool unlocked = device.Unlock("session-123");

        // Assert
        Assert.True(unlocked);
        Assert.False(device.IsLocked);

        _decoder.ProcessToken("5");
        Assert.Single(acceptedCoins);
        Assert.Equal(5, acceptedCoins[0]);
        Assert.Empty(rejectedCoins);
    }

    [Fact]
    public void Unlock_UnknownOwner_ReturnsFalse()
    {
        // Arrange
        using var device = CreateDevice();

        // Act
        bool unlocked = device.Unlock("non_existent_session");

        // Assert
        Assert.False(unlocked);
    }

    [Fact]
    public void MultipleLocks_RemainsLockedUntilAllOwnersUnlock()
    {
        // Arrange
        using var device = CreateDevice();
        device.Lock("owner-1", "reason-1");
        device.Lock("owner-2", "reason-2");

        Assert.True(device.IsLocked);

        // Act & Assert 1: Unlock owner-1
        Assert.True(device.Unlock("owner-1"));
        Assert.True(device.IsLocked); // still locked by owner-2

        // Act & Assert 2: Unlock owner-2
        Assert.True(device.Unlock("owner-2"));
        Assert.False(device.IsLocked); // now completely unlocked
    }

    [Fact]
    public void ResetLocks_ClearsAllActiveLocks()
    {
        // Arrange
        using var device = CreateDevice();
        device.Lock("owner-1", "reason-1");
        device.Lock("owner-2", "reason-2");
        Assert.True(device.IsLocked);

        // Act
        device.ResetLocks();

        // Assert
        Assert.False(device.IsLocked);

        var acceptedCoins = new List<int>();
        device.CoinAccepted += (_, val) => acceptedCoins.Add(val);

        _decoder.ProcessToken("5");
        Assert.Single(acceptedCoins);
        Assert.Equal(5, acceptedCoins[0]);
    }

    [Fact]
    public void Dispose_UnsubscribesFromDecoder()
    {
        // Arrange
        var device = CreateDevice();
        var acceptedCoins = new List<int>();
        device.CoinAccepted += (_, val) => acceptedCoins.Add(val);

        // Act
        device.Dispose();
        _decoder.ProcessToken("5");

        // Assert
        Assert.Empty(acceptedCoins);
    }

    [Fact]
    public void Constructor_NullArguments_ThrowsArgumentNullException()
    {
        Assert.Throws<ArgumentNullException>(() => new CoinAcceptorDevice(null!, _mockPowerSafetyGate.Object, _mockLogger.Object));
        Assert.Throws<ArgumentNullException>(() => new CoinAcceptorDevice(_decoder, null!, _mockLogger.Object));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Lock_InvalidOwnerId_ThrowsArgumentException(string? invalidOwner)
    {
        using var device = CreateDevice();
        Assert.ThrowsAny<ArgumentException>(() => device.Lock(invalidOwner!, "reason"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Unlock_InvalidOwnerId_ThrowsArgumentException(string? invalidOwner)
    {
        using var device = CreateDevice();
        Assert.ThrowsAny<ArgumentException>(() => device.Unlock(invalidOwner!));
    }

    [Fact]
    public void SubscriberException_DoesNotCrashOrPropagate()
    {
        // Arrange
        using var device = CreateDevice();
        device.CoinAccepted += (_, _) => throw new InvalidOperationException("Simulated subscriber crash");

        // Act & Assert (should not throw)
        var ex = Record.Exception(() => _decoder.ProcessToken("5"));
        Assert.Null(ex);
    }
}
