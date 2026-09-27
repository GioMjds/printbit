namespace PrintBit.Infrastructure.Services.SerialService;

public interface ISerialConnection
{
    bool IsConnected { get; }

    string? CurrentPortName { get; }

    event EventHandler<string>? LineReceived;

    event EventHandler<(bool isConnected, string? port, string? error)>? ConnectionChanged;

    void Connect(string portName, int baudRate);

    void Disconnect();

    void SendLine(string data);

    [Obsolete("Use LineReceived instead.")]
    event EventHandler<string>? DataReceived;

    [Obsolete("Use SendLine instead.")]
    void Send(string data);
}
