using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Shared.Configurations;
using PrintBit.Shared.Power;

namespace PrintBit.Infrastructure.Windows.PowerMonitoring;

public class PowerMonitorService : BackgroundService
{
    private readonly ILogger<PowerMonitorService> _logger;
    private readonly IPowerStatusProvider _powerProvider;
    private readonly IPowerSafetyGate _gate;
    private readonly IPrinterHealthMonitor _healthMonitor;
    private readonly IWorkerEventPipeClient _eventPipe;
    private readonly HardwareSettings _hardwareSettings;
    private readonly PowerSettings _powerSettings;
    private readonly PowerSafetyStateMachine _stateMachine;

    private readonly string _instanceId = Guid.NewGuid().ToString();
    private long _sequenceNumber;

    private PowerStatusSnapshot? _lastSnapshot;
    private PowerOperationalState? _lastState;
    private DateTimeOffset? _lastHeartbeatSentAt;
    private WorkerPrintEvent? _pendingEvent;

    public PowerMonitorService(
        ILogger<PowerMonitorService> logger,
        IPowerStatusProvider powerProvider,
        IPowerSafetyGate gate,
        IPrinterHealthMonitor healthMonitor,
        IWorkerEventPipeClient eventPipe,
        IOptions<HardwareSettings> hardwareOptions,
        IOptions<PowerSettings> powerOptions,
        PowerSafetyStateMachine? stateMachine = null)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _powerProvider = powerProvider ?? throw new ArgumentNullException(nameof(powerProvider));
        _gate = gate ?? throw new ArgumentNullException(nameof(gate));
        _healthMonitor = healthMonitor ?? throw new ArgumentNullException(nameof(healthMonitor));
        _eventPipe = eventPipe ?? throw new ArgumentNullException(nameof(eventPipe));
        _hardwareSettings = hardwareOptions?.Value ?? new HardwareSettings();
        _powerSettings = powerOptions?.Value ?? new PowerSettings();
        _stateMachine = stateMachine ?? (powerOptions is not null ? new PowerSafetyStateMachine(powerOptions) : new PowerSafetyStateMachine());
    }

    public string InstanceId => _instanceId;
    public long SequenceNumber => Interlocked.Read(ref _sequenceNumber);
    public WorkerPrintEvent? PendingEvent => _pendingEvent;
    public PowerSafetyStateMachine StateMachine => _stateMachine;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var intervalSeconds = _powerSettings.PollIntervalSeconds > 0 ? _powerSettings.PollIntervalSeconds : 2;
        var interval = TimeSpan.FromSeconds(intervalSeconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await PollOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[POWER] Unexpected error in power monitoring loop");
            }

            try
            {
                await Task.Delay(interval, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    public Task PollOnceAsync(CancellationToken cancellationToken = default) =>
        PollOnceAsync(DateTimeOffset.UtcNow, cancellationToken);

    public async Task PollOnceAsync(DateTimeOffset now, CancellationToken cancellationToken = default)
    {
        bool providerSucceeded = _powerProvider.TryGetStatus(out var snapshot, out var providerError);
        if (!providerSucceeded)
        {
            _logger.LogWarning("[POWER] Failed to query power status: {Error}", providerError ?? "Unknown provider error");
            snapshot = new PowerStatusSnapshot(AcLineStatus.Unknown, null, null, null, null);
        }

        int spoolStatus = 0;
        string spoolDesc = string.Empty;
        bool isPrinterHealthy = _healthMonitor.IsHealthy(_hardwareSettings.PrinterName, out spoolStatus, out spoolDesc);

        var newState = _stateMachine.Advance(snapshot, isPrinterHealthy, now);
        _gate.Apply(newState);

        bool isInitial = _lastState is null;
        bool stateChanged = !isInitial && newState != _lastState!.Value;
        bool snapshotChanged = !isInitial && !Equals(snapshot, _lastSnapshot);

        var heartbeatInterval = TimeSpan.FromSeconds(
            _powerSettings.HeartbeatIntervalSeconds > 0 ? _powerSettings.HeartbeatIntervalSeconds : 10);
        bool isHeartbeat = !isInitial && !stateChanged && !snapshotChanged &&
            (_lastHeartbeatSentAt is null || (now - _lastHeartbeatSentAt.Value) >= heartbeatInterval);

        if (isInitial || stateChanged || snapshotChanged || isHeartbeat)
        {
            var eventType = (stateChanged || snapshotChanged)
                ? WorkerPrintEventType.PowerStatusChanged
                : WorkerPrintEventType.PowerStatusSnapshot;

            var evt = new WorkerPrintEvent
            {
                Type = eventType,
                PowerStatus = snapshot,
                OperationalState = newState,
                AcceptingTransactions = newState == PowerOperationalState.Operational,
                PowerSourceInstanceId = _instanceId,
                PowerSequence = Interlocked.Increment(ref _sequenceNumber),
                TimestampUtc = now.UtcDateTime
            };

            _lastState = newState;
            _lastSnapshot = snapshot;
            _lastHeartbeatSentAt = now;

            bool sent = await _eventPipe.SendAsync(evt, cancellationToken);
            if (sent)
            {
                _pendingEvent = null;

                if (eventType == WorkerPrintEventType.PowerStatusSnapshot && !isInitial)
                {
                    _logger.LogDebug("[POWER] Sent heartbeat snapshot seq {Seq}, state {State}", evt.PowerSequence, evt.OperationalState);
                }
                else
                {
                    _logger.LogInformation(
                        "[POWER] Sent {Type} seq {Seq}, state {State}, AC: {AcStatus}, accepting: {Accepting}",
                        evt.Type,
                        evt.PowerSequence,
                        evt.OperationalState,
                        snapshot.AcLineStatus,
                        evt.AcceptingTransactions);
                }
            }
            else
            {
                _pendingEvent = evt;
                _logger.LogWarning(
                    "[POWER] Failed to send {Type} seq {Seq} to return pipe; retained for retry",
                    evt.Type,
                    evt.PowerSequence);
            }
        }
        else if (_pendingEvent is not null)
        {
            bool sent = await _eventPipe.SendAsync(_pendingEvent, cancellationToken);
            if (sent)
            {
                if (_pendingEvent.Type == WorkerPrintEventType.PowerStatusSnapshot)
                {
                    _lastHeartbeatSentAt = now;
                    _logger.LogDebug("[POWER] Sent retained heartbeat snapshot seq {Seq}", _pendingEvent.PowerSequence);
                }
                else
                {
                    _logger.LogInformation("[POWER] Sent retained event seq {Seq}", _pendingEvent.PowerSequence);
                }
                _pendingEvent = null;
            }
            else
            {
                _logger.LogWarning("[POWER] Retried sending event seq {Seq} to return pipe but failed; still retained", _pendingEvent.PowerSequence);
            }
        }
    }
}
