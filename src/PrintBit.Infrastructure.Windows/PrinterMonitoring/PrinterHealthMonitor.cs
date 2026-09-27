using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Shared.Configurations;

namespace PrintBit.Infrastructure.Windows.PrinterMonitoring;

[SupportedOSPlatform("windows")]
public class PrinterHealthMonitor : BackgroundService, IPrinterHealthMonitor
{
    private readonly ILogger<PrinterHealthMonitor> _logger;
    private readonly HardwareSettings _hardwareSettings;
    private readonly IWorkerEventPipeClient _eventPipe;
    private readonly object _lock = new();

    private bool? _lastOfflineState = null;
    private string? _lastErrorState = null;
    private WorkerPrintEvent? _pendingEvent;
    private DateTimeOffset? _lastHeartbeatSentAt;
    
    private int _fatalErrorCode = 0;
    private string _fatalErrorMessage = string.Empty;

    private readonly record struct PrinterHealthProbes(
        bool WinSpoolAvailable,
        uint WinSpoolStatus,
        string WinSpoolDescription,
        bool WmiAvailable,
        bool IsOffline,
        int DetectedErrorState,
        int ExtendedPrinterStatus,
        bool HasEpsonPopup,
        string EpsonPopupContent,
        string? PortName);

    // Win32 APIs for Epson Status Monitor Popup checking
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    private const uint WmGetText = 0x000D;
    private const uint SendMessageTimeoutAbortIfHung = 0x0002;

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        uint msg,
        UIntPtr wParam,
        StringBuilder lParam,
        uint flags,
        uint timeoutMilliseconds,
        out UIntPtr result);

    private static readonly string[] EpsonErrorKeywords = 
    {
        "out of paper", "paper out", "jam", "ink out", "no ink", "door open", "cover open", "offline", "error", "service"
    };

    public PrinterHealthMonitor(
        ILogger<PrinterHealthMonitor> logger,
        IOptions<HardwareSettings> hardwareOptions,
        IWorkerEventPipeClient eventPipe)
    {
        _logger = logger;
        _hardwareSettings = hardwareOptions.Value;
        _eventPipe = eventPipe;
    }

    public virtual bool IsHealthy(string printerName, out int winSpoolStatus, out string winSpoolDesc)
    {
        var diagnostic = GetDiagnostic(printerName);
        winSpoolStatus = diagnostic.WinSpoolStatus;
        winSpoolDesc = diagnostic.WinSpoolDescription;
        return diagnostic.IsHealthy;
    }

    public bool HasFatalHardwareError(string printerName, out int errorCode, out string errorMessage)
    {
        if (string.Equals(printerName, _hardwareSettings.PrinterName, StringComparison.OrdinalIgnoreCase))
        {
            lock (_lock)
            {
                if (_fatalErrorCode != 0)
                {
                    errorCode = _fatalErrorCode;
                    errorMessage = _fatalErrorMessage;
                    return true;
                }
            }
        }

        var probes = ReadHealthProbes(printerName);
        if (probes.WinSpoolAvailable &&
            (probes.WinSpoolStatus & WinSpoolApi.FATAL_STATUS_MASK) != 0)
        {
            errorCode = (int)probes.WinSpoolStatus;
            errorMessage = $"WinSpool reports: {probes.WinSpoolDescription}";
            return true;
        }

        if (TryGetWmiFailureDescription(printerName, probes, out var wmiDescription))
        {
            errorCode = 3;
            errorMessage = wmiDescription;
            return true;
        }

        if (probes.HasEpsonPopup)
        {
            errorCode = 99;
            errorMessage = $"Epson Popup: {probes.EpsonPopupContent}";
            return true;
        }

        errorCode = 0;
        errorMessage = string.Empty;
        return false;
    }

    public PrinterHealthDiagnostic GetDiagnostic(string printerName)
    {
        var probes = ReadHealthProbes(printerName);
        var printerState = PrinterHealthState.Healthy;
        var issueKind = PrinterHealthIssueKind.None;
        int? wmiCode = null;
        string? wmiDescription = null;

        if (IsPhysicalDetectedErrorState(probes.DetectedErrorState))
        {
            printerState = PrinterHealthState.Fault;
            issueKind = PrinterHealthIssueKind.PhysicalFault;
            wmiCode = probes.DetectedErrorState;
            wmiDescription =
                $"Error {probes.DetectedErrorState} ({DetectedErrorStateDescription(probes.DetectedErrorState)})";
        }
        else if (probes.HasEpsonPopup)
        {
            printerState = PrinterHealthState.Fault;
            issueKind = PrinterHealthIssueKind.PhysicalFault;
        }
        else if (!probes.WmiAvailable)
        {
            printerState = PrinterHealthState.Unavailable;
            issueKind = PrinterHealthIssueKind.WindowsQueueFault;
            wmiDescription = $"Printer queue '{printerName}' not found";
        }
        else if (probes.IsOffline || probes.DetectedErrorState == 9 || probes.ExtendedPrinterStatus == 7 ||
                 (probes.WinSpoolStatus & WinSpoolApi.PRINTER_STATUS_OFFLINE) != 0)
        {
            printerState = PrinterHealthState.Offline;
            issueKind = PrinterHealthIssueKind.WindowsQueueFault;
            (wmiCode, wmiDescription) = DescribeWmiQueueFault(
                probes.IsOffline,
                probes.DetectedErrorState,
                probes.ExtendedPrinterStatus);
        }
        else if (probes.ExtendedPrinterStatus == 11)
        {
            printerState = PrinterHealthState.Unavailable;
            issueKind = PrinterHealthIssueKind.WindowsQueueFault;
            wmiCode = probes.ExtendedPrinterStatus;
            wmiDescription =
                $"Extended status {probes.ExtendedPrinterStatus} ({ExtendedPrinterStatusDescription(probes.ExtendedPrinterStatus)})";
        }
        else if (IsFatalExtendedPrinterStatus(probes.ExtendedPrinterStatus))
        {
            printerState = PrinterHealthState.Fault;
            issueKind = PrinterHealthIssueKind.WindowsQueueFault;
            wmiCode = probes.ExtendedPrinterStatus;
            wmiDescription =
                $"Extended status {probes.ExtendedPrinterStatus} ({ExtendedPrinterStatusDescription(probes.ExtendedPrinterStatus)})";
        }
        else if (!probes.WinSpoolAvailable)
        {
            printerState = PrinterHealthState.Unavailable;
            issueKind = PrinterHealthIssueKind.WindowsQueueFault;
        }
        else if ((probes.WinSpoolStatus & WinSpoolApi.FATAL_STATUS_MASK) != 0)
        {
            printerState = PrinterHealthState.Fault;
            issueKind = PrinterHealthIssueKind.WindowsQueueFault;
        }

        return new PrinterHealthDiagnostic
        {
            PrinterState = printerState,
            IssueKind = issueKind,
            WinSpoolStatus = (int)probes.WinSpoolStatus,
            WinSpoolDescription = probes.WinSpoolDescription,
            WmiCode = wmiCode,
            WmiDescription = wmiDescription,
            EpsonPopupText = probes.HasEpsonPopup ? probes.EpsonPopupContent : null,
            PortName = probes.PortName
        };
    }

    protected virtual bool TryGetWinSpoolStatus(
        string printerName,
        out uint status,
        out string description) =>
        WinSpoolApi.GetPrinterStatus(printerName, out status, out description);

    private PrinterHealthProbes ReadHealthProbes(string printerName)
    {
        var winSpoolAvailable = TryGetWinSpoolStatus(
            printerName,
            out var winSpoolStatus,
            out var winSpoolDescription);
        var wmiAvailable = TryReadMonitorStatus(
            printerName,
            out var isOffline,
            out var detectedErrorState,
            out var extendedPrinterStatus);
        var (hasPopup, _, _, popupContent) = CheckEpsonStatusMonitorPopup(printerName);
        _ = TryReadPrinterPort(printerName, out var portName);

        return new PrinterHealthProbes(
            winSpoolAvailable,
            winSpoolStatus,
            winSpoolDescription,
            wmiAvailable,
            isOffline,
            detectedErrorState,
            extendedPrinterStatus,
            hasPopup,
            popupContent,
            portName);
    }

    public async Task<bool> WaitForPrinterHealthyAsync(
        string printerName,
        int timeoutSeconds,
        CancellationToken cancellationToken)
    {
        _logger.LogInformation("Waiting for printer '{printer}' (timeout: {timeout}s)", printerName, timeoutSeconds);
        var deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);

        while (DateTime.UtcNow < deadline || timeoutSeconds == 0)
        {
            if (cancellationToken.IsCancellationRequested) return false;

            if (IsHealthy(printerName, out var status, out var desc))
            {
                _logger.LogInformation("Printer '{printer}' is healthy.", printerName);
                return true;
            }

            _logger.LogWarning("Printer unhealthy: wsStatus=0x{status:X} ({desc}). Nudging...", status, desc);
            _ = WinSpoolApi.SetPrinterStatusReset(printerName);
            _ = WinSpoolApi.NudgePrinter(printerName);

            if (timeoutSeconds == 0) return false; // immediate check

            await Task.Delay(2000, cancellationToken);
        }
        return false;
    }

    public (bool JobExists, uint StatusMask, string JobStatus, int PagesPrinted, int TotalPages, string? JobId) QueryJobStatus(
        string printerName,
        string documentName)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT Name, Document, StatusMask, JobStatus, JobId, PagesPrinted, TotalPages FROM Win32_PrintJob");

            using var results = searcher.Get();
            (bool JobExists, uint StatusMask, string JobStatus, int PagesPrinted, int TotalPages, string? JobId)? fallback = null;

            foreach (ManagementObject job in results.Cast<ManagementObject>())
            {
                try
                {
                    var jobName = job["Name"]?.ToString() ?? string.Empty;
                    var document = job["Document"]?.ToString() ?? string.Empty;

                    if (jobName.StartsWith(printerName, StringComparison.OrdinalIgnoreCase))
                    {
                        var mask = Convert.ToUInt32(job["StatusMask"] ?? 0u);
                        var status = job["JobStatus"]?.ToString() ?? string.Empty;
                        var printed = Convert.ToInt32(job["PagesPrinted"] ?? 0);
                        var total = Convert.ToInt32(job["TotalPages"] ?? 0);
                        var jobId = Convert.ToUInt32(job["JobId"] ?? 0u).ToString();

                        if (string.IsNullOrEmpty(documentName) ||
                            document.Contains(documentName, StringComparison.OrdinalIgnoreCase))
                        {
                            return (true, mask, status, printed, total, jobId);
                        }

                        // Fallback: active job on this printer when document title differs from file name
                        fallback ??= (true, mask, status, printed, total, jobId);
                    }
                }
                finally
                {
                    job.Dispose();
                }
            }

            if (fallback.HasValue)
            {
                return fallback.Value;
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to query print job status");
        }
        return (false, 0, string.Empty, 0, 0, null);
    }

    public void CancelMatchingJobs(string printerName, string documentName, string? spoolerJobId)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT Name, Document, JobStatus, JobId FROM Win32_PrintJob");

            using var results = searcher.Get();
            foreach (ManagementObject job in results.Cast<ManagementObject>())
            {
                try
                {
                    var jobName = job["Name"]?.ToString() ?? string.Empty;
                    var document = job["Document"]?.ToString() ?? string.Empty;
                    var jobId = Convert.ToUInt32(job["JobId"] ?? 0u).ToString();

                    if (jobName.StartsWith(printerName, StringComparison.OrdinalIgnoreCase) &&
                        (document.Contains(documentName, StringComparison.OrdinalIgnoreCase) || jobId == spoolerJobId))
                    {
                        _logger.LogWarning("Deleting stuck print job {jobId}: {doc}", jobId, document);
                        job.Delete();
                    }
                }
                finally
                {
                    job.Dispose();
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to cancel print job");
        }
    }

    public virtual async Task<bool> BroadcastInitialSnapshotAsync(CancellationToken stoppingToken = default)
    {
        var foundPrinter = TryReadMonitorStatus(
            _hardwareSettings.PrinterName,
            out var isOffline,
            out _,
            out _);
        var isOnline = foundPrinter && !isOffline;

        var initialSnapshot = new WorkerPrintEvent
        {
            Type = WorkerPrintEventType.PrinterStatusSnapshot,
            PrinterName = _hardwareSettings.PrinterName,
            Message = isOnline ? "Printer is online" : "Printer is offline",
            TimestampUtc = DateTime.UtcNow
        };

        return await _eventPipe.PublishAsync(initialSnapshot, stoppingToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("Unified Printer Monitor loop started for {printer}", _hardwareSettings.PrinterName);

        try
        {
            await BroadcastInitialSnapshotAsync(stoppingToken);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to broadcast initial printer status snapshot");
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await MonitorPrinterAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in health monitoring loop");
            }
            await Task.Delay(2000, stoppingToken);
        }
    }

    protected virtual bool TryReadMonitorStatus(
        string printerName,
        out bool isOffline,
        out int detectedErrorState,
        out int extendedPrinterStatus)
    {
        isOffline = false;
        detectedErrorState = 0;
        extendedPrinterStatus = 0;

        try
        {
            var escapedPrinterName = printerName.Replace("'", "''");
            using var searcher = new ManagementObjectSearcher(
                $"SELECT DetectedErrorState, ExtendedPrinterStatus, WorkOffline FROM Win32_Printer WHERE Name = '{escapedPrinterName}'");

            using var results = searcher.Get();
            foreach (ManagementObject printer in results.Cast<ManagementObject>())
            {
                try
                {
                    isOffline = printer["WorkOffline"] is true;
                    extendedPrinterStatus = Convert.ToInt32(printer["ExtendedPrinterStatus"] ?? 0);
                    if (extendedPrinterStatus is 7 or 11)
                    {
                        isOffline = true;
                    }

                    detectedErrorState = Convert.ToInt32(printer["DetectedErrorState"] ?? 0);
                    return true;
                }
                finally
                {
                    printer.Dispose();
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to read printer status for {printerName}", printerName);
        }

        return false;
    }

    protected virtual bool TryReadPrinterPort(string printerName, out string? portName)
    {
        portName = null;

        try
        {
            var escapedPrinterName = printerName.Replace("'", "''");
            using var searcher = new ManagementObjectSearcher(
                $"SELECT PortName FROM Win32_Printer WHERE Name = '{escapedPrinterName}'");
            using var results = searcher.Get();
            foreach (ManagementObject printer in results.Cast<ManagementObject>())
            {
                try
                {
                    portName = printer["PortName"]?.ToString();
                    return true;
                }
                finally
                {
                    printer.Dispose();
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to read printer port for {printerName}", printerName);
        }

        return false;
    }

    protected virtual async Task MonitorPrinterAsync(CancellationToken stoppingToken)
    {
        var foundPrinter = TryReadMonitorStatus(
            _hardwareSettings.PrinterName,
            out var isOffline,
            out var detectedErrorState,
            out var extendedPrinterStatus);

        if (foundPrinter)
        {
            var isFatalWmi = IsFatalDetectedErrorState(detectedErrorState);
            var isFatalExtendedStatus =
                IsFatalExtendedPrinterStatus(extendedPrinterStatus) && extendedPrinterStatus is not (7 or 11);
            var (hasEpsonPopup, _, _, epsonPopupContent) =
                CheckEpsonStatusMonitorPopup(_hardwareSettings.PrinterName);

            if (_lastOfflineState != isOffline)
            {
                _lastOfflineState = isOffline;
                _pendingEvent = new WorkerPrintEvent
                {
                    Type = isOffline ? WorkerPrintEventType.PrinterOffline : WorkerPrintEventType.PrinterOnline,
                    PrinterName = _hardwareSettings.PrinterName,
                    Message = isOffline ? "Printer offline" : "Printer back online"
                };
            }

            lock (_lock)
            {
                if (isFatalWmi || isFatalExtendedStatus || hasEpsonPopup)
                {
                    _fatalErrorCode = isFatalWmi
                        ? detectedErrorState
                        : isFatalExtendedStatus
                            ? extendedPrinterStatus
                            : 99;
                    _fatalErrorMessage = isFatalWmi
                        ? DetectedErrorStateDescription(detectedErrorState)
                        : isFatalExtendedStatus
                            ? ExtendedPrinterStatusDescription(extendedPrinterStatus)
                            : $"Epson Popup: {epsonPopupContent}";

                    var stateIdentifier =
                        $"{detectedErrorState}_{extendedPrinterStatus}_{epsonPopupContent}";
                    if (_lastErrorState != stateIdentifier)
                    {
                        _lastErrorState = stateIdentifier;
                        _pendingEvent = new WorkerPrintEvent
                        {
                            Type = WorkerPrintEventType.PrinterError,
                            PrinterName = _hardwareSettings.PrinterName,
                            FailureStage = "hardware_error",
                            Message = $"Printer error ({_fatalErrorMessage})",
                            ErrorCode = _fatalErrorCode.ToString()
                        };
                    }
                }
                else
                {
                    var recoveredFromError = _lastErrorState is not null || _fatalErrorCode != 0;
                    _fatalErrorCode = 0;
                    _fatalErrorMessage = string.Empty;
                    _lastErrorState = null;

                    if (recoveredFromError)
                    {
                        _pendingEvent = new WorkerPrintEvent
                        {
                            Type = WorkerPrintEventType.PrinterOnline,
                            PrinterName = _hardwareSettings.PrinterName,
                            Message = "Printer is online"
                        };
                    }
                }
            }
        }
        else
        {
            if (_lastOfflineState != true)
            {
                _lastOfflineState = true;
                _pendingEvent = new WorkerPrintEvent
                {
                    Type = WorkerPrintEventType.PrinterOffline,
                    PrinterName = _hardwareSettings.PrinterName,
                    Message = $"Printer queue '{_hardwareSettings.PrinterName}' not found"
                };
            }
            lock (_lock)
            {
                _fatalErrorCode = 1;
                _fatalErrorMessage = $"Printer queue '{_hardwareSettings.PrinterName}' not found";
            }
        }

        if (_pendingEvent is not null && await _eventPipe.SendAsync(_pendingEvent, stoppingToken))
        {
            _pendingEvent = null;
            _lastHeartbeatSentAt = DateTimeOffset.UtcNow;
        }
        else if (_pendingEvent is null)
        {
            var now = DateTimeOffset.UtcNow;
            var heartbeatInterval = TimeSpan.FromSeconds(15);
            if (_lastHeartbeatSentAt is null || (now - _lastHeartbeatSentAt.Value) >= heartbeatInterval)
            {
                var isOnline = foundPrinter && !isOffline && _fatalErrorCode == 0;
                var heartbeat = new WorkerPrintEvent
                {
                    Type = WorkerPrintEventType.PrinterStatusSnapshot,
                    PrinterName = _hardwareSettings.PrinterName,
                    Message = isOnline
                        ? "Printer is online"
                        : (foundPrinter ? $"Printer unhealthy: {_fatalErrorMessage}" : $"Printer queue '{_hardwareSettings.PrinterName}' not found"),
                    TimestampUtc = now.UtcDateTime
                };

                if (await _eventPipe.PublishAsync(heartbeat, stoppingToken))
                {
                    _lastHeartbeatSentAt = now;
                }
            }
        }
    }

    private static bool IsFatalDetectedErrorState(int code) => code switch
    {
        4 => true,  // No Paper
        6 => true,  // No Toner
        7 => true,  // Door Open
        8 => true,  // Jammed
        9 => true,  // Offline
        10 => true, // Service Requested
        11 => true, // Output Bin Full
        _ => false
    };

    private static bool IsPhysicalDetectedErrorState(int code) => code switch
    {
        4 => true,  // No Paper
        6 => true,  // No Toner
        7 => true,  // Door Open
        8 => true,  // Jammed
        10 => true, // Service Requested
        11 => true, // Output Bin Full
        _ => false
    };

    private static (int? Code, string Description) DescribeWmiQueueFault(
        bool isOffline,
        int detectedErrorState,
        int extendedPrinterStatus)
    {
        if (detectedErrorState == 9)
        {
            return (detectedErrorState,
                $"Error {detectedErrorState} ({DetectedErrorStateDescription(detectedErrorState)})");
        }

        if (extendedPrinterStatus == 7)
        {
            return (extendedPrinterStatus,
                $"Extended status {extendedPrinterStatus} ({ExtendedPrinterStatusDescription(extendedPrinterStatus)})");
        }

        return (null, isOffline ? "Offline" : "Queue fault");
    }

    private static bool TryGetWmiFailureDescription(
        string printerName,
        PrinterHealthProbes probes,
        out string description)
    {
        if (!probes.WmiAvailable)
        {
            description = $"Printer queue '{printerName}' not found";
            return true;
        }

        if (probes.IsOffline)
        {
            description = "Offline";
            return true;
        }

        if (IsFatalExtendedPrinterStatus(probes.ExtendedPrinterStatus))
        {
            description =
                $"Extended status {probes.ExtendedPrinterStatus} ({ExtendedPrinterStatusDescription(probes.ExtendedPrinterStatus)})";
            return true;
        }

        if (IsFatalDetectedErrorState(probes.DetectedErrorState))
        {
            description =
                $"Error {probes.DetectedErrorState} ({DetectedErrorStateDescription(probes.DetectedErrorState)})";
            return true;
        }

        description = string.Empty;
        return false;
    }

    private static bool IsFatalExtendedPrinterStatus(int status) => status switch
    {
        6 => true,  // Stopped Printing
        7 => true,  // Offline
        9 => true,  // Error
        11 => true, // Not Available
        _ => false
    };

    private static string ExtendedPrinterStatusDescription(int status) => status switch
    {
        1 => "Other",
        2 => "Unknown",
        3 => "Idle",
        4 => "Printing",
        5 => "Warmup",
        6 => "Stopped Printing",
        7 => "Offline",
        8 => "Paused",
        9 => "Error",
        10 => "Busy",
        11 => "Not Available",
        12 => "Waiting",
        13 => "Processing",
        14 => "Initialization",
        15 => "Power Save",
        16 => "Pending Deletion",
        17 => "I/O Active",
        18 => "Manual Feed",
        _ => $"Status ({status})"
    };

    private static string DetectedErrorStateDescription(int code) => code switch
    {
        3 => "Low Paper",
        4 => "No Paper",
        5 => "Low Toner",
        6 => "No Toner",
        7 => "Door Open",
        8 => "Jammed",
        9 => "Offline",
        10 => "Service Requested",
        11 => "Output Bin Full",
        _ => $"Unknown Error ({code})"
    };

    protected virtual (bool HasPopup, int ProcessId, string WindowTitle, string Content) CheckEpsonStatusMonitorPopup(string printerName)
    {
        bool found = false;
        int targetPid = 0;
        string foundTitle = string.Empty;
        string foundContent = string.Empty;

        try
        {
            _ = EnumWindows((hWnd, lParam) =>
            {
                if (IsWindowVisible(hWnd))
                {
                    var sb = new StringBuilder(256);
                    _ = GetWindowText(hWnd, sb, 256);
                    string title = sb.ToString();

                    if (title.StartsWith("EPSON Status Monitor 3", StringComparison.OrdinalIgnoreCase))
                    {
                        var textBuilder = new StringBuilder();
                        textBuilder.AppendLine(title);

                        _ = EnumChildWindows(hWnd, (childHwnd, childLParam) =>
                        {
                            if (IsWindowVisible(childHwnd))
                            {
                                string childText = ReadCrossProcessWindowText(childHwnd);
                                if (childText.Length > 0)
                                {
                                    textBuilder.AppendLine(childText);
                                }
                            }
                            return true;
                        }, IntPtr.Zero);

                        string fullContent = textBuilder.ToString();
                        bool isError = ContainsEpsonErrorKeyword(fullContent);

                        if (isError)
                        {
                            var printerParts = printerName.Split(new[] { ' ', '-', '_' }, StringSplitOptions.RemoveEmptyEntries)
                                .Where(part => !string.Equals(part, "Series", StringComparison.OrdinalIgnoreCase) &&
                                               !string.Equals(part, "Printer", StringComparison.OrdinalIgnoreCase) &&
                                               !string.Equals(part, "Epson", StringComparison.OrdinalIgnoreCase))
                                .ToList();

                            bool nameMatches = printerParts.Count > 0
                                ? printerParts.Any(part => fullContent.Contains(part, StringComparison.OrdinalIgnoreCase))
                                : fullContent.Contains(printerName, StringComparison.OrdinalIgnoreCase);

                            if (nameMatches)
                            {
                                _ = GetWindowThreadProcessId(hWnd, out uint pid);
                                found = true;
                                targetPid = (int)pid;
                                foundTitle = title;
                                
                                // Clean up the content string for Kiosk display (remove newlines and generic text)
                                var cleanContent = string.Join(" | ", fullContent
                                    .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                                    .Where(l => !l.Contains("EPSON Status Monitor") && !l.Contains("Buy EPSON Ink")));
                                foundContent = cleanContent.Length > 0 ? cleanContent : "Epson popup error";
                                return false;
                            }
                        }
                    }
                }
                return true;
            }, IntPtr.Zero);
        }
        catch
        {
            // ignored
        }
        return (found, targetPid, foundTitle, foundContent);
    }

    internal static bool ContainsEpsonErrorKeyword(string content) =>
        EpsonErrorKeywords.Any(keyword =>
            content.Contains(keyword, StringComparison.OrdinalIgnoreCase));

    private static string ReadCrossProcessWindowText(IntPtr hWnd)
    {
        var text = new StringBuilder(2048);
        IntPtr sendResult = SendMessageTimeout(
            hWnd,
            WmGetText,
            (UIntPtr)text.Capacity,
            text,
            SendMessageTimeoutAbortIfHung,
            200,
            out _);

        return sendResult == IntPtr.Zero ? string.Empty : text.ToString();
    }
}
