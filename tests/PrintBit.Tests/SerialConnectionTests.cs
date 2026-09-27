using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Ports;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;
using PrintBit.HardwareService.Services;
using PrintBit.Infrastructure.Services.SerialService;
using PrintBit.Shared.Configurations;
using Xunit;

namespace PrintBit.Tests;

public class SerialConnectionTests
{
    #region SerialConnection Line Framing & Buffering Tests

    [Fact]
    public void ProcessIncomingData_SingleLineCrlf_EmitsLineWithoutCr()
    {
        var connection = new SerialConnection();
        var receivedLines = new List<string>();
        connection.LineReceived += (_, line) => receivedLines.Add(line);

        connection.ProcessIncomingData("PING\r\n");

        Assert.Single(receivedLines);
        Assert.Equal("PING", receivedLines[0]);
    }

    [Fact]
    public void ProcessIncomingData_SingleLineLfOnly_EmitsLine()
    {
        var connection = new SerialConnection();
        var receivedLines = new List<string>();
        connection.LineReceived += (_, line) => receivedLines.Add(line);

        connection.ProcessIncomingData("PING\n");

        Assert.Single(receivedLines);
        Assert.Equal("PING", receivedLines[0]);
    }

    [Fact]
    public void ProcessIncomingData_PartialChunks_BuffersUntilNewlineReceived()
    {
        var connection = new SerialConnection();
        var receivedLines = new List<string>();
        connection.LineReceived += (_, line) => receivedLines.Add(line);

        connection.ProcessIncomingData("PART");
        Assert.Empty(receivedLines);

        connection.ProcessIncomingData("IAL_LINE\r\n");
        Assert.Single(receivedLines);
        Assert.Equal("PARTIAL_LINE", receivedLines[0]);
    }

    [Fact]
    public void ProcessIncomingData_MultipleLinesInSingleChunk_EmitsAllLinesInOrder()
    {
        var connection = new SerialConnection();
        var receivedLines = new List<string>();
        connection.LineReceived += (_, line) => receivedLines.Add(line);

        connection.ProcessIncomingData("LINE1\r\nLINE2\nLINE3\r\n");

        Assert.Equal(3, receivedLines.Count);
        Assert.Equal("LINE1", receivedLines[0]);
        Assert.Equal("LINE2", receivedLines[1]);
        Assert.Equal("LINE3", receivedLines[2]);
    }

    [Fact]
    public void ProcessIncomingData_MultipleLinesWithTrailingPartial_EmitsLinesAndKeepsPartial()
    {
        var connection = new SerialConnection();
        var receivedLines = new List<string>();
        connection.LineReceived += (_, line) => receivedLines.Add(line);

        connection.ProcessIncomingData("LINE1\r\nPARTIAL_");
        Assert.Single(receivedLines);
        Assert.Equal("LINE1", receivedLines[0]);

        connection.ProcessIncomingData("REST\n");
        Assert.Equal(2, receivedLines.Count);
        Assert.Equal("PARTIAL_REST", receivedLines[1]);
    }

    [Fact]
    public void ProcessIncomingData_EmptyOrNull_DoesNotThrowOrEmit()
    {
        var connection = new SerialConnection();
        var receivedLines = new List<string>();
        connection.LineReceived += (_, line) => receivedLines.Add(line);

        connection.ProcessIncomingData(string.Empty);

        Assert.Empty(receivedLines);
    }

    [Fact]
    public void DataReceived_LegacyAlias_InvokedWhenLineReceived()
    {
        var connection = new SerialConnection();
        var legacyReceived = new List<string>();
#pragma warning disable CS0618 // Type or member is obsolete
        connection.DataReceived += (_, data) => legacyReceived.Add(data);
#pragma warning restore CS0618

        connection.ProcessIncomingData("LEGACY_DATA\n");

        Assert.Single(legacyReceived);
        Assert.Equal("LEGACY_DATA", legacyReceived[0]);
    }

    #endregion

    #region SerialConnection Lifecycle & Port Adapter Tests

    [Fact]
    public void Connect_Success_SetsIsConnectedAndCurrentPortName_FiresConnectionChanged()
    {
        var mockAdapter = new Mock<ISerialPortAdapter>();
        bool isOpen = false;
        mockAdapter.Setup(a => a.Open()).Callback(() => isOpen = true);
        mockAdapter.Setup(a => a.IsOpen).Returns(() => isOpen);

        var connection = new SerialConnection((_, _) => mockAdapter.Object);

        (bool isConnected, string? port, string? error)? lastEvent = null;
        connection.ConnectionChanged += (_, args) => lastEvent = args;

        connection.Connect("COM3", 115200);

        Assert.True(connection.IsConnected);
        Assert.Equal("COM3", connection.CurrentPortName);
        Assert.NotNull(lastEvent);
        Assert.True(lastEvent.Value.isConnected);
        Assert.Equal("COM3", lastEvent.Value.port);
        Assert.Null(lastEvent.Value.error);
        mockAdapter.Verify(a => a.Open(), Times.Once);
    }

    [Fact]
    public void Connect_WhenAlreadyConnected_DoesNotReopenOrRefire()
    {
        var mockAdapter = new Mock<ISerialPortAdapter>();
        bool isOpen = true;
        mockAdapter.Setup(a => a.Open());
        mockAdapter.Setup(a => a.IsOpen).Returns(() => isOpen);

        var connection = new SerialConnection((_, _) => mockAdapter.Object);

        int eventCount = 0;
        connection.ConnectionChanged += (_, _) => eventCount++;

        connection.Connect("COM3", 115200);
        connection.Connect("COM3", 115200);

        Assert.Equal(1, eventCount);
        mockAdapter.Verify(a => a.Open(), Times.Once);
    }

    [Fact]
    public void Connect_Failure_FiresConnectionChangedWithError_AndThrows()
    {
        var mockAdapter = new Mock<ISerialPortAdapter>();
        mockAdapter.Setup(a => a.Open()).Throws(new IOException("Device not found"));
        mockAdapter.Setup(a => a.IsOpen).Returns(false);

        var connection = new SerialConnection((_, _) => mockAdapter.Object);

        (bool isConnected, string? port, string? error)? lastEvent = null;
        connection.ConnectionChanged += (_, args) => lastEvent = args;

        var ex = Assert.Throws<IOException>(() => connection.Connect("COM99", 115200));

        Assert.Equal("Device not found", ex.Message);
        Assert.False(connection.IsConnected);
        Assert.Null(connection.CurrentPortName);
        Assert.NotNull(lastEvent);
        Assert.False(lastEvent.Value.isConnected);
        Assert.Equal("COM99", lastEvent.Value.port);
        Assert.Equal("Device not found", lastEvent.Value.error);
    }

    [Fact]
    public void Disconnect_WhenConnected_ClosesPortResetsStateAndFiresConnectionChanged()
    {
        var mockAdapter = new Mock<ISerialPortAdapter>();
        bool isOpen = false;
        mockAdapter.Setup(a => a.Open()).Callback(() => isOpen = true);
        mockAdapter.Setup(a => a.Close()).Callback(() => isOpen = false);
        mockAdapter.Setup(a => a.IsOpen).Returns(() => isOpen);

        var connection = new SerialConnection((_, _) => mockAdapter.Object);
        connection.Connect("COM3", 115200);

        (bool isConnected, string? port, string? error)? disconnectEvent = null;
        connection.ConnectionChanged += (_, args) => disconnectEvent = args;

        connection.Disconnect();

        Assert.False(connection.IsConnected);
        Assert.Null(connection.CurrentPortName);
        Assert.NotNull(disconnectEvent);
        Assert.False(disconnectEvent.Value.isConnected);
        Assert.Equal("COM3", disconnectEvent.Value.port);
        Assert.Null(disconnectEvent.Value.error);
        mockAdapter.Verify(a => a.Close(), Times.Once);
    }

    [Fact]
    public void Disconnect_ClearsBuffer()
    {
        var mockAdapter = new Mock<ISerialPortAdapter>();
        bool isOpen = true;
        mockAdapter.Setup(a => a.IsOpen).Returns(() => isOpen);

        var connection = new SerialConnection((_, _) => mockAdapter.Object);
        connection.Connect("COM3", 115200);

        connection.ProcessIncomingData("PARTIAL_BEFORE_DISCONNECT");
        connection.Disconnect();

        var received = new List<string>();
        connection.LineReceived += (_, line) => received.Add(line);

        connection.ProcessIncomingData("NEW_MESSAGE\n");

        Assert.Single(received);
        Assert.Equal("NEW_MESSAGE", received[0]);
    }

    [Fact]
    public void SendLine_WhenConnected_AppendsNewlineIfNotPresent()
    {
        var mockAdapter = new Mock<ISerialPortAdapter>();
        mockAdapter.Setup(a => a.IsOpen).Returns(true);

        var connection = new SerialConnection((_, _) => mockAdapter.Object);
        connection.Connect("COM3", 115200);

        connection.SendLine("CMD:STATUS");

        mockAdapter.Verify(a => a.Write("CMD:STATUS\n"), Times.Once);
    }

    [Fact]
    public void SendLine_WhenConnected_PreservesExistingNewline()
    {
        var mockAdapter = new Mock<ISerialPortAdapter>();
        mockAdapter.Setup(a => a.IsOpen).Returns(true);

        var connection = new SerialConnection((_, _) => mockAdapter.Object);
        connection.Connect("COM3", 115200);

        connection.SendLine("CMD:STATUS\n");

        mockAdapter.Verify(a => a.Write("CMD:STATUS\n"), Times.Once);
    }

    [Fact]
    public void SendLine_WhenDisconnected_ThrowsInvalidOperationException()
    {
        var connection = new SerialConnection();

        Assert.Throws<InvalidOperationException>(() => connection.SendLine("TEST"));
    }

    [Fact]
    public void Send_LegacyAlias_DelegatesToSendLine()
    {
        var mockAdapter = new Mock<ISerialPortAdapter>();
        mockAdapter.Setup(a => a.IsOpen).Returns(true);

        var connection = new SerialConnection((_, _) => mockAdapter.Object);
        connection.Connect("COM3", 115200);

#pragma warning disable CS0618 // Type or member is obsolete
        connection.Send("LEGACY_SEND");
#pragma warning restore CS0618

        mockAdapter.Verify(a => a.Write("LEGACY_SEND\n"), Times.Once);
    }

    #endregion

    #region SerialHostedService Tests

    [Fact]
    public async Task SerialHostedService_ConnectsWithConfiguredSettings()
    {
        var mockConnection = new Mock<ISerialConnection>();
        bool isConnected = false;
        mockConnection.Setup(c => c.IsConnected).Returns(() => isConnected);
        mockConnection.Setup(c => c.Connect("COM7", 115200))
            .Callback(() => isConnected = true);

        var settings = Options.Create(new HardwareSettings
        {
            Esp32Port = "COM7",
            Esp32BaudRate = 115200
        });

        using var cts = new CancellationTokenSource();

        var service = new SerialHostedService(
            mockConnection.Object,
            settings,
            NullLogger<SerialHostedService>.Instance,
            (_, ct) =>
            {
                cts.Cancel();
                return Task.CompletedTask;
            });

        await service.StartAsync(cts.Token);
        try { await Task.Delay(100, cts.Token); } catch (OperationCanceledException) { }
        await service.StopAsync(CancellationToken.None);

        mockConnection.Verify(c => c.Connect("COM7", 115200), Times.AtLeastOnce);
    }

    [Fact]
    public async Task SerialHostedService_ReconnectBackoff_DoublesDelayUpToMax()
    {
        var mockConnection = new Mock<ISerialConnection>();
        mockConnection.Setup(c => c.IsConnected).Returns(false);
        mockConnection.Setup(c => c.Connect(It.IsAny<string>(), It.IsAny<int>()))
            .Throws(new IOException("COM port busy"));

        var settings = Options.Create(new HardwareSettings
        {
            Esp32Port = "COM3",
            Esp32BaudRate = 115200
        });

        var delays = new List<int>();
        using var cts = new CancellationTokenSource();

        var service = new SerialHostedService(
            mockConnection.Object,
            settings,
            NullLogger<SerialHostedService>.Instance,
            (ms, ct) =>
            {
                delays.Add(ms);
                if (delays.Count >= 6)
                {
                    cts.Cancel();
                }
                return Task.CompletedTask;
            });

        await service.StartAsync(cts.Token);
        try { await Task.Delay(200, cts.Token); } catch (OperationCanceledException) { }
        await service.StopAsync(CancellationToken.None);

        // Expected sequence: 2000, 4000, 8000, 16000, 30000, 30000
        Assert.True(delays.Count >= 5);
        Assert.Equal(2000, delays[0]);
        Assert.Equal(4000, delays[1]);
        Assert.Equal(8000, delays[2]);
        Assert.Equal(16000, delays[3]);
        Assert.Equal(30000, delays[4]);
        if (delays.Count >= 6)
        {
            Assert.Equal(30000, delays[5]);
        }
    }

    [Fact]
    public async Task SerialHostedService_ReconnectBackoff_ResetsBaseDelayAfterSuccess()
    {
        var mockConnection = new Mock<ISerialConnection>();
        int connectAttempts = 0;
        bool isConnected = false;

        mockConnection.Setup(c => c.IsConnected).Returns(() => isConnected);
        mockConnection.Setup(c => c.Connect(It.IsAny<string>(), It.IsAny<int>()))
            .Callback(() =>
            {
                connectAttempts++;
                if (connectAttempts == 1)
                {
                    throw new IOException("Fail 1");
                }
                if (connectAttempts == 2)
                {
                    isConnected = true; // Success!
                }
                if (connectAttempts >= 3)
                {
                    throw new IOException("Fail again after drop");
                }
            });

        var settings = Options.Create(new HardwareSettings
        {
            Esp32Port = "COM3",
            Esp32BaudRate = 115200
        });

        var delays = new List<int>();
        using var cts = new CancellationTokenSource();

        var service = new SerialHostedService(
            mockConnection.Object,
            settings,
            NullLogger<SerialHostedService>.Instance,
            (ms, ct) =>
            {
                delays.Add(ms);
                if (isConnected)
                {
                    // Simulate port dropping after connection monitor check
                    isConnected = false;
                }
                if (delays.Count >= 3)
                {
                    cts.Cancel();
                }
                return Task.CompletedTask;
            });

        await service.StartAsync(cts.Token);
        try { await Task.Delay(200, cts.Token); } catch (OperationCanceledException) { }
        await service.StopAsync(CancellationToken.None);

        Assert.Contains(2000, delays);
        Assert.Contains(1000, delays);
        var reconnectDelayIndex = delays.FindLastIndex(d => d == 2000);
        Assert.True(reconnectDelayIndex >= 0);
    }

    [Fact]
    public async Task SerialHostedService_StopAsync_DisconnectsConnection()
    {
        var mockConnection = new Mock<ISerialConnection>();
        mockConnection.Setup(c => c.IsConnected).Returns(true);

        var settings = Options.Create(new HardwareSettings());

        var service = new SerialHostedService(
            mockConnection.Object,
            settings,
            NullLogger<SerialHostedService>.Instance);

        await service.StopAsync(CancellationToken.None);

        mockConnection.Verify(c => c.Disconnect(), Times.Once);
    }

    #endregion
}
