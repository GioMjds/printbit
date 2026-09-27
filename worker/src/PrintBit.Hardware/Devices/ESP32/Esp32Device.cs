using Microsoft.Extensions.Logging;
using PrintBit.Hardware.Devices.ESP32.Protocol;
using PrintBit.Infrastructure.Services.SerialService;

namespace PrintBit.Hardware.Devices.ESP32;

public sealed class Esp32Device : IEsp32Device, IDisposable
{
    private readonly ILogger<Esp32Device> _logger;
    private readonly ISerialConnection _serialConnection;
    private readonly object _stateLock = new();

    private string? _apIp;
    private string? _staIp;
    private string? _kioskIp;
    private bool _disposed;

    public string? ApIp
    {
        get
        {
            lock (_stateLock)
            {
                return _apIp;
            }
        }
        private set
        {
            lock (_stateLock)
            {
                _apIp = value;
            }
        }
    }

    public string? StaIp
    {
        get
        {
            lock (_stateLock)
            {
                return _staIp;
            }
        }
        private set
        {
            lock (_stateLock)
            {
                _staIp = value;
            }
        }
    }

    public string? KioskIp
    {
        get
        {
            lock (_stateLock)
            {
                return _kioskIp;
            }
        }
        private set
        {
            lock (_stateLock)
            {
                _kioskIp = value;
            }
        }
    }

    public bool IsConnected => _serialConnection.IsConnected;

    public event EventHandler<Esp32TelemetryEvent>? TelemetryReceived;

    public Esp32Device(
        ISerialConnection serialConnection,
        ILogger<Esp32Device> logger)
    {
        _serialConnection = serialConnection ?? throw new ArgumentNullException(nameof(serialConnection));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));

        _serialConnection.LineReceived += OnLineReceived;
    }

    public Esp32Device(
        ILogger<Esp32Device> logger,
        ISerialConnection serialConnection)
        : this(serialConnection, logger)
    {
    }

    public void SendKioskIpAnnouncement(string ip, int port, string path)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        ArgumentException.ThrowIfNullOrWhiteSpace(ip);
        ArgumentException.ThrowIfNullOrWhiteSpace(path);

        var trimmedIp = ip.Trim();
        var trimmedPath = path.Trim();
        var normalizedPath = trimmedPath.StartsWith('/') ? trimmedPath : "/" + trimmedPath;
        var command = $"KIOSK_IP {trimmedIp} {port} {normalizedPath}";

        _logger.LogInformation("Sending KIOSK_IP announcement: {Command}", command);
        _serialConnection.SendLine(command);
    }

    public void SendWifiCommand(string action)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        ArgumentException.ThrowIfNullOrWhiteSpace(action);

        var trimmedAction = action.Trim();
        var command = $"WIFI {trimmedAction}";

        _logger.LogInformation("Sending WIFI command: {Command}", command);
        _serialConnection.SendLine(command);
    }

    public void SendCommand(string command)
    {
        ArgumentNullException.ThrowIfNull(command);
        _serialConnection.SendLine(command);
    }

    private void OnLineReceived(object? sender, string line)
    {
        if (Esp32TelemetryParser.TryParse(line, out var telemetry) && telemetry is not null)
        {
            _logger.LogDebug(
                "Parsed ESP32 telemetry: {Type} = {Value}",
                telemetry.Type,
                telemetry.Value);

            switch (telemetry.Type)
            {
                case Esp32TelemetryType.ApIp:
                    ApIp = telemetry.Value;
                    break;
                case Esp32TelemetryType.StaIp:
                    StaIp = telemetry.Value;
                    break;
                case Esp32TelemetryType.KioskIp:
                    KioskIp = telemetry.Value;
                    break;
            }

            try
            {
                TelemetryReceived?.Invoke(this, telemetry);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error occurred while dispatching TelemetryReceived event");
            }
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _serialConnection.LineReceived -= OnLineReceived;
        GC.SuppressFinalize(this);
    }
}