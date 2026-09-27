using System;
using System.IO.Ports;

namespace PrintBit.Infrastructure.Services.SerialService;

public interface ISerialPortAdapter : IDisposable
{
    bool IsOpen { get; }

    string PortName { get; }

    int BaudRate { get; }

    void Open();

    void Close();

    void Write(string text);

    string ReadExisting();

    event SerialDataReceivedEventHandler? DataReceived;

    event SerialErrorReceivedEventHandler? ErrorReceived;
}

public sealed class DefaultSerialPortAdapter : ISerialPortAdapter
{
    private readonly SerialPort _port;

    public DefaultSerialPortAdapter(string portName, int baudRate)
    {
        _port = new SerialPort(portName, baudRate)
        {
            WriteTimeout = 3000
        };
    }

    public bool IsOpen => _port.IsOpen;

    public string PortName => _port.PortName;

    public int BaudRate => _port.BaudRate;

    public void Open() => _port.Open();

    public void Close() => _port.Close();

    public void Write(string text) => _port.Write(text);

    public string ReadExisting() => _port.ReadExisting();

    public event SerialDataReceivedEventHandler? DataReceived
    {
        add => _port.DataReceived += value;
        remove => _port.DataReceived -= value;
    }

    public event SerialErrorReceivedEventHandler? ErrorReceived
    {
        add => _port.ErrorReceived += value;
        remove => _port.ErrorReceived -= value;
    }

    public void Dispose() => _port.Dispose();
}
