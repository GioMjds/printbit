namespace PrintBit.Shared.Configurations;

public class HardwareSettings
{
    public bool EnableCoinSimulation { get; set; }

    public string Esp32Port { get; set; } = "COM3";

    public int Esp32BaudRate { get; set; } = 115200;

    public int PrintTimeoutSeconds { get; set; } = 120;

    public string PrinterName { get; set; } = "EPSON L5290 Series";

    public PrinterProfileSettings PrinterProfiles { get; set; } = new();

    // Default queue path is a relative "queue" directory. The watcher resolves
    // it via Path.GetFullPath and creates it on startup if missing, so the same
    // value works in dev and in production. Override in appsettings.json or
    // appsettings.Development.json for environment-specific paths.
    public string PrintQueueDirectory { get; set; } = "queue";

    // Directory the watcher moves failed PDF/JSON sidecars into after a print
    // attempt fails. When null/empty, the watcher falls back to a "failed"
    // sibling of the resolved PrintQueueDirectory. Must match
    // PRINTBIT_WORKER_FAILED_DIR on the Node side so the Node orchestrator
    // can locate retried jobs.
    public string? FailedDirectory { get; set; }

    public string SumatraPath { get; set; } = @"C:\Users\printbit\bin\SumatraPDF.exe";

    public string QpdfPath { get; set; } = @"C:\Users\printbit\bin\qpdf.exe";

    public int PauseTimeoutMinutes { get; set; } = 15;
    public int PostClearGuardDelaySeconds { get; set; } = 3;
}
