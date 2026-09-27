using System;
using System.Runtime.Versioning;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Shared.Configurations;

namespace PrintBit.Infrastructure.Windows.PrinterMonitoring;

[SupportedOSPlatform("windows")]
public class PrinterRecoveryService : IPrinterRecoveryService
{
    private const string DefaultPrinterName = "EPSON L5290 Series";
    private const string RestartSpoolerAction = "RestartSpooler";
    private const string StartSpoolerAction = "StartSpooler";

    private readonly IPrinterHealthMonitor _healthMonitor;
    private readonly IPrintSpoolerController _spoolerController;
    private readonly IPrinterOperationCoordinator _coordinator;
    private readonly PrinterRecoverySettings _recoverySettings;
    private readonly HardwareSettings? _hardwareSettings;
    private readonly ILogger<PrinterRecoveryService>? _logger;

    public PrinterRecoveryService(
        IPrinterHealthMonitor healthMonitor,
        IPrintSpoolerController spoolerController,
        IPrinterOperationCoordinator coordinator,
        IOptions<PrinterRecoverySettings> recoverySettings,
        IOptions<HardwareSettings>? hardwareSettings = null,
        ILogger<PrinterRecoveryService>? logger = null)
    {
        _healthMonitor = healthMonitor ?? throw new ArgumentNullException(nameof(healthMonitor));
        _spoolerController = spoolerController ?? throw new ArgumentNullException(nameof(spoolerController));
        _coordinator = coordinator ?? throw new ArgumentNullException(nameof(coordinator));
        _recoverySettings = recoverySettings?.Value ?? new PrinterRecoverySettings();
        _hardwareSettings = hardwareSettings?.Value;
        _logger = logger;
    }

    public async Task<PrinterRecoveryResult> GetStatusAsync(CancellationToken cancellationToken)
    {
        var startedAt = DateTime.UtcNow;
        var printerName = ResolvePrinterName();

        var spoolerStatus = await _spoolerController.GetStatusAsync(cancellationToken);
        var diagnostic = _healthMonitor.GetDiagnostic(printerName);

        PrinterRecoveryOutcome outcome;
        string message;

        if (spoolerStatus.IsRunning && diagnostic.IsHealthy)
        {
            outcome = PrinterRecoveryOutcome.Healthy;
            message = "Printer and print spooler are healthy.";
        }
        else if (diagnostic.IssueKind == PrinterHealthIssueKind.PhysicalFault)
        {
            outcome = PrinterRecoveryOutcome.ManualInterventionRequired;
            message = !string.IsNullOrWhiteSpace(diagnostic.WinSpoolDescription)
                ? diagnostic.WinSpoolDescription
                : (!string.IsNullOrWhiteSpace(diagnostic.WmiDescription)
                    ? diagnostic.WmiDescription
                    : "Physical printer fault detected. Manual intervention required.");
        }
        else if (!spoolerStatus.IsRunning)
        {
            outcome = PrinterRecoveryOutcome.ManualInterventionRequired;
            message = "Print Spooler service is not running.";
        }
        else
        {
            outcome = PrinterRecoveryOutcome.ManualInterventionRequired;
            message = !string.IsNullOrWhiteSpace(diagnostic.WinSpoolDescription)
                ? diagnostic.WinSpoolDescription
                : (!string.IsNullOrWhiteSpace(diagnostic.WmiDescription)
                    ? diagnostic.WmiDescription
                    : "Printer fault or offline state detected.");
        }

        return new PrinterRecoveryResult
        {
            RequestId = string.Empty,
            Type = PrinterRecoveryCommandType.GetPrinterRecoveryStatus,
            Outcome = outcome,
            Action = null,
            SpoolerState = MapSpoolerState(spoolerStatus),
            PrinterState = diagnostic.PrinterState.ToString(),
            IssueKind = diagnostic.IssueKind.ToString(),
            Message = message,
            StartedAt = startedAt,
            CompletedAt = DateTime.UtcNow
        };
    }

    public Task<PrinterRecoveryResult> AttemptRepairAsync(CancellationToken cancellationToken) =>
        AttemptRepairCoreAsync(null, cancellationToken);

    public Task<PrinterRecoveryResult> AttemptRepairAsync(SupervisorDecision decision, CancellationToken cancellationToken) =>
        AttemptRepairCoreAsync(decision, cancellationToken);

    public async Task<PrinterRecoveryResult> RestartSpoolerAsync(string? targetPrinterName, CancellationToken cancellationToken)
    {
        var startedAt = DateTime.UtcNow;

        if (!_coordinator.TryAcquireRecovery(out var lease) || lease == null)
        {
            _logger?.LogWarning("RestartSpoolerAsync rejected: operation lease could not be acquired (worker busy).");
            return new PrinterRecoveryResult
            {
                RequestId = string.Empty,
                Type = PrinterRecoveryCommandType.RestartPrintSpooler,
                Outcome = PrinterRecoveryOutcome.WorkerBusy,
                Action = null,
                SpoolerState = null,
                PrinterState = null,
                IssueKind = null,
                Message = "Printer spooler restart is unavailable while an operation is active.",
                StartedAt = startedAt,
                CompletedAt = DateTime.UtcNow
            };
        }

        using (lease)
        {
            var printerName = !string.IsNullOrWhiteSpace(targetPrinterName)
                ? targetPrinterName
                : ResolvePrinterName();

            var diagnostic = _healthMonitor.GetDiagnostic(printerName);

            // Check for physical fault before attempting restart — cannot fix via spooler
            if (diagnostic.IssueKind == PrinterHealthIssueKind.PhysicalFault)
            {
                var physicalMsg = !string.IsNullOrWhiteSpace(diagnostic.WinSpoolDescription)
                    ? diagnostic.WinSpoolDescription
                    : (!string.IsNullOrWhiteSpace(diagnostic.WmiDescription)
                        ? diagnostic.WmiDescription
                        : "Physical printer fault detected. Manual intervention required.");

                _logger?.LogWarning(
                    "RestartSpoolerAsync: Printer '{PrinterName}' has physical fault ({Message}). Spooler restart cannot fix a physical fault.",
                    printerName,
                    physicalMsg);

                return new PrinterRecoveryResult
                {
                    RequestId = string.Empty,
                    Type = PrinterRecoveryCommandType.RestartPrintSpooler,
                    Outcome = PrinterRecoveryOutcome.ManualInterventionRequired,
                    Action = null,
                    SpoolerState = null,
                    PrinterState = diagnostic.PrinterState.ToString(),
                    IssueKind = diagnostic.IssueKind.ToString(),
                    Message = physicalMsg,
                    StartedAt = startedAt,
                    CompletedAt = DateTime.UtcNow
                };
            }

            _logger?.LogInformation(
                "RestartSpoolerAsync: Restarting Print Spooler for printer '{PrinterName}' (admin-requested).",
                printerName);

            var restartResult = await _spoolerController.RestartAsync(cancellationToken);
            if (!restartResult.Success)
            {
                var errorMsg = $"Print Spooler restart failed: {restartResult.Error}";
                _logger?.LogError("RestartSpoolerAsync: {Message}", errorMsg);

                return new PrinterRecoveryResult
                {
                    RequestId = string.Empty,
                    Type = PrinterRecoveryCommandType.RestartPrintSpooler,
                    Outcome = PrinterRecoveryOutcome.RestartFailed,
                    Action = RestartSpoolerAction,
                    SpoolerState = MapSpoolerState(restartResult),
                    PrinterState = diagnostic.PrinterState.ToString(),
                    IssueKind = diagnostic.IssueKind.ToString(),
                    Message = errorMsg,
                    StartedAt = startedAt,
                    CompletedAt = DateTime.UtcNow
                };
            }

            // Poll health monitor until healthy or timeout
            var recheckTimeoutSeconds = Math.Max(0, _recoverySettings.HealthRecheckTimeoutSeconds);
            var intervalSeconds = Math.Max(0, _recoverySettings.HealthRecheckIntervalSeconds);
            var deadline = DateTime.UtcNow.AddSeconds(recheckTimeoutSeconds);

            var latestDiagnostic = _healthMonitor.GetDiagnostic(printerName);

            while (!latestDiagnostic.IsHealthy && DateTime.UtcNow < deadline)
            {
                var delayMs = (int)(intervalSeconds * 1000);
                if (delayMs > 0)
                {
                    await Task.Delay(delayMs, cancellationToken);
                }

                latestDiagnostic = _healthMonitor.GetDiagnostic(printerName);

                if (delayMs == 0)
                {
                    break;
                }
            }

            if (latestDiagnostic.IsHealthy)
            {
                _logger?.LogInformation(
                    "RestartSpoolerAsync: Printer '{PrinterName}' is healthy after spooler restart.",
                    printerName);

                return new PrinterRecoveryResult
                {
                    RequestId = string.Empty,
                    Type = PrinterRecoveryCommandType.RestartPrintSpooler,
                    Outcome = PrinterRecoveryOutcome.Recovered,
                    Action = RestartSpoolerAction,
                    SpoolerState = MapSpoolerState(restartResult),
                    PrinterState = latestDiagnostic.PrinterState.ToString(),
                    IssueKind = latestDiagnostic.IssueKind.ToString(),
                    Message = "Print Spooler restarted successfully and printer health confirmed.",
                    StartedAt = startedAt,
                    CompletedAt = DateTime.UtcNow
                };
            }
            else if (latestDiagnostic.IssueKind == PrinterHealthIssueKind.PhysicalFault)
            {
                var physicalMsg = $"Print Spooler restarted, but physical printer fault detected ({latestDiagnostic.PrinterState}, {latestDiagnostic.IssueKind}). Manual intervention required.";
                _logger?.LogWarning("RestartSpoolerAsync: {Message}", physicalMsg);

                return new PrinterRecoveryResult
                {
                    RequestId = string.Empty,
                    Type = PrinterRecoveryCommandType.RestartPrintSpooler,
                    Outcome = PrinterRecoveryOutcome.ManualInterventionRequired,
                    Action = null,
                    SpoolerState = MapSpoolerState(restartResult),
                    PrinterState = latestDiagnostic.PrinterState.ToString(),
                    IssueKind = latestDiagnostic.IssueKind.ToString(),
                    Message = physicalMsg,
                    StartedAt = startedAt,
                    CompletedAt = DateTime.UtcNow
                };
            }
            else
            {
                var failureMsg = $"Print Spooler restarted, but printer remained unhealthy ({latestDiagnostic.PrinterState}, {latestDiagnostic.IssueKind}) after recheck deadline.";
                _logger?.LogWarning("RestartSpoolerAsync: {Message}", failureMsg);

                return new PrinterRecoveryResult
                {
                    RequestId = string.Empty,
                    Type = PrinterRecoveryCommandType.RestartPrintSpooler,
                    Outcome = PrinterRecoveryOutcome.RestartFailed,
                    Action = RestartSpoolerAction,
                    SpoolerState = MapSpoolerState(restartResult),
                    PrinterState = latestDiagnostic.PrinterState.ToString(),
                    IssueKind = latestDiagnostic.IssueKind.ToString(),
                    Message = failureMsg,
                    StartedAt = startedAt,
                    CompletedAt = DateTime.UtcNow
                };
            }
        }
    }


    private async Task<PrinterRecoveryResult> AttemptRepairCoreAsync(SupervisorDecision? decision, CancellationToken cancellationToken)
    {
        var startedAt = DateTime.UtcNow;

        if (!_coordinator.TryAcquireRecovery(out var lease) || lease == null)
        {
            _logger?.LogWarning("AttemptRepairAsync rejected: operation lease could not be acquired (worker busy).");
            return new PrinterRecoveryResult
            {
                RequestId = string.Empty,
                Type = PrinterRecoveryCommandType.AttemptPrinterRecovery,
                Outcome = PrinterRecoveryOutcome.WorkerBusy,
                Action = null,
                SpoolerState = null,
                PrinterState = null,
                IssueKind = null,
                Message = "Printer recovery is unavailable while an operation is active.",
                StartedAt = startedAt,
                CompletedAt = DateTime.UtcNow
            };
        }

        using (lease)
        {
            var printerName = ResolvePrinterName();

            var spoolerStatus = await _spoolerController.GetStatusAsync(cancellationToken);
            var diagnostic = _healthMonitor.GetDiagnostic(printerName);

            // 1. If healthy and spooler running: no action needed
            if (spoolerStatus.IsRunning && diagnostic.IsHealthy)
            {
                _logger?.LogInformation("AttemptRepairAsync: Printer '{PrinterName}' is healthy. No repair needed.", printerName);
                return new PrinterRecoveryResult
                {
                    RequestId = string.Empty,
                    Type = PrinterRecoveryCommandType.AttemptPrinterRecovery,
                    Outcome = PrinterRecoveryOutcome.Healthy,
                    Action = null,
                    SpoolerState = MapSpoolerState(spoolerStatus),
                    PrinterState = diagnostic.PrinterState.ToString(),
                    IssueKind = diagnostic.IssueKind.ToString(),
                    Message = "Printer is healthy. No recovery action needed.",
                    StartedAt = startedAt,
                    CompletedAt = DateTime.UtcNow
                };
            }

            // 2. Physical fault: requires manual intervention, do not restart spooler
            if (diagnostic.IssueKind == PrinterHealthIssueKind.PhysicalFault)
            {
                var physicalMsg = !string.IsNullOrWhiteSpace(diagnostic.WinSpoolDescription)
                    ? diagnostic.WinSpoolDescription
                    : (!string.IsNullOrWhiteSpace(diagnostic.WmiDescription)
                        ? diagnostic.WmiDescription
                        : "Physical printer fault detected. Manual intervention required.");

                _logger?.LogWarning(
                    "AttemptRepairAsync: Printer '{PrinterName}' has physical fault ({Message}). Spooler recovery bypassed.",
                    printerName,
                    physicalMsg);

                return new PrinterRecoveryResult
                {
                    RequestId = string.Empty,
                    Type = PrinterRecoveryCommandType.AttemptPrinterRecovery,
                    Outcome = PrinterRecoveryOutcome.ManualInterventionRequired,
                    Action = null,
                    SpoolerState = MapSpoolerState(spoolerStatus),
                    PrinterState = diagnostic.PrinterState.ToString(),
                    IssueKind = diagnostic.IssueKind.ToString(),
                    Message = physicalMsg,
                    StartedAt = startedAt,
                    CompletedAt = DateTime.UtcNow
                };
            }

            // Revalidate evidence inside the lease: an earlier policy decision may be stale.
            var observedDecision = !string.IsNullOrEmpty(spoolerStatus.ErrorMessage)
                ? SupervisorDecision.None
                : spoolerStatus.IsRunning
                    ? diagnostic.IssueKind == PrinterHealthIssueKind.WindowsQueueFault
                        ? SupervisorDecision.RestartSpooler : SupervisorDecision.None
                    : string.Equals(spoolerStatus.Status, "Stopped", StringComparison.OrdinalIgnoreCase)
                        ? SupervisorDecision.StartSpooler : SupervisorDecision.None;
            if (observedDecision == SupervisorDecision.None || (decision.HasValue && decision != observedDecision))
            {
                return new PrinterRecoveryResult
                {
                    Type = PrinterRecoveryCommandType.AttemptPrinterRecovery,
                    Outcome = PrinterRecoveryOutcome.ManualInterventionRequired,
                    SpoolerState = MapSpoolerState(spoolerStatus),
                    PrinterState = diagnostic.PrinterState.ToString(),
                    IssueKind = diagnostic.IssueKind.ToString(),
                    Message = "No confirmed Windows-side recovery action is currently safe. Recheck printer status.",
                    StartedAt = startedAt,
                    CompletedAt = DateTime.UtcNow
                };
            }

            var action = observedDecision == SupervisorDecision.StartSpooler ? StartSpoolerAction : RestartSpoolerAction;
            _logger?.LogInformation(
                "AttemptRepairAsync: Printer '{PrinterName}' has recoverable fault ({State}, {IssueKind}). Attempting {Action}.",
                printerName,
                diagnostic.PrinterState,
                diagnostic.IssueKind,
                action);

            var restartResult = observedDecision == SupervisorDecision.RestartSpooler
                ? await _spoolerController.RestartAsync(cancellationToken)
                : await _spoolerController.StartAsync(cancellationToken);
            if (!restartResult.Success)
            {
                var errorMsg = $"Print Spooler {action} failed: {restartResult.Error}";
                _logger?.LogError("AttemptRepairAsync: {Message}", errorMsg);

                return new PrinterRecoveryResult
                {
                    RequestId = string.Empty,
                    Type = PrinterRecoveryCommandType.AttemptPrinterRecovery,
                    Outcome = PrinterRecoveryOutcome.RestartFailed,
                    Action = action,
                    SpoolerState = MapSpoolerState(restartResult),
                    PrinterState = diagnostic.PrinterState.ToString(),
                    IssueKind = diagnostic.IssueKind.ToString(),
                    Message = errorMsg,
                    StartedAt = startedAt,
                    CompletedAt = DateTime.UtcNow
                };
            }

            // 4. Poll read-only diagnostic until healthy or timeout
            var recheckTimeoutSeconds = Math.Max(0, _recoverySettings.HealthRecheckTimeoutSeconds);
            var intervalSeconds = Math.Max(0, _recoverySettings.HealthRecheckIntervalSeconds);
            var deadline = DateTime.UtcNow.AddSeconds(recheckTimeoutSeconds);

            var latestDiagnostic = _healthMonitor.GetDiagnostic(printerName);

            while (!latestDiagnostic.IsHealthy && DateTime.UtcNow < deadline)
            {
                var delayMs = (int)(intervalSeconds * 1000);
                if (delayMs > 0)
                {
                    await Task.Delay(delayMs, cancellationToken);
                }

                latestDiagnostic = _healthMonitor.GetDiagnostic(printerName);

                if (delayMs == 0)
                {
                    break;
                }
            }

            if (latestDiagnostic.IsHealthy)
            {
                _logger?.LogInformation(
                    "AttemptRepairAsync: Printer '{PrinterName}' restored to healthy after {Action}.",
                    printerName, action);

                return new PrinterRecoveryResult
                {
                    RequestId = string.Empty,
                    Type = PrinterRecoveryCommandType.AttemptPrinterRecovery,
                    Outcome = PrinterRecoveryOutcome.Recovered,
                    Action = action,
                    SpoolerState = MapSpoolerState(restartResult),
                    PrinterState = latestDiagnostic.PrinterState.ToString(),
                    IssueKind = latestDiagnostic.IssueKind.ToString(),
                    Message = $"Print Spooler {action} completed successfully and printer health restored.",
                    StartedAt = startedAt,
                    CompletedAt = DateTime.UtcNow
                };
            }
            else if (latestDiagnostic.IssueKind == PrinterHealthIssueKind.PhysicalFault)
            {
                var physicalMsg = $"Print Spooler {action} completed, but physical printer fault detected ({latestDiagnostic.PrinterState}, {latestDiagnostic.IssueKind}). Manual intervention required.";
                _logger?.LogWarning("AttemptRepairAsync: {Message}", physicalMsg);

                return new PrinterRecoveryResult
                {
                    RequestId = string.Empty,
                    Type = PrinterRecoveryCommandType.AttemptPrinterRecovery,
                    Outcome = PrinterRecoveryOutcome.ManualInterventionRequired,
                    Action = null,
                    SpoolerState = MapSpoolerState(restartResult),
                    PrinterState = latestDiagnostic.PrinterState.ToString(),
                    IssueKind = latestDiagnostic.IssueKind.ToString(),
                    Message = physicalMsg,
                    StartedAt = startedAt,
                    CompletedAt = DateTime.UtcNow
                };
            }
            else
            {
                var failureMsg = $"Print Spooler {action} completed, but printer remained unhealthy ({latestDiagnostic.PrinterState}, {latestDiagnostic.IssueKind}) after recheck deadline.";
                _logger?.LogWarning("AttemptRepairAsync: {Message}", failureMsg);

                return new PrinterRecoveryResult
                {
                    RequestId = string.Empty,
                    Type = PrinterRecoveryCommandType.AttemptPrinterRecovery,
                    Outcome = PrinterRecoveryOutcome.RestartFailed,
                    Action = action,
                    SpoolerState = MapSpoolerState(restartResult),
                    PrinterState = latestDiagnostic.PrinterState.ToString(),
                    IssueKind = latestDiagnostic.IssueKind.ToString(),
                    Message = failureMsg,
                    StartedAt = startedAt,
                    CompletedAt = DateTime.UtcNow
                };
            }
        }
    }

    private static SpoolerStateDto MapSpoolerState(SpoolerStatusSnapshot snapshot) =>
        new()
        {
            IsRunning = snapshot.IsRunning,
            Status = snapshot.Status,
            ErrorMessage = snapshot.ErrorMessage
        };

    private static SpoolerStateDto MapSpoolerState(SpoolerRestartResult restartResult) =>
        new()
        {
            IsRunning = string.Equals(restartResult.FinalStatus, "Running", StringComparison.OrdinalIgnoreCase),
            Status = restartResult.FinalStatus,
            ErrorMessage = restartResult.Error
        };

    private string ResolvePrinterName()
    {
        if (!string.IsNullOrWhiteSpace(_recoverySettings.PrinterName))
        {
            return _recoverySettings.PrinterName;
        }

        if (!string.IsNullOrWhiteSpace(_hardwareSettings?.PrinterName))
        {
            return _hardwareSettings.PrinterName;
        }

        return DefaultPrinterName;
    }
}
