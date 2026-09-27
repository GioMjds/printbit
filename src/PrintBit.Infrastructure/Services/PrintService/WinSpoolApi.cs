using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace PrintBit.Infrastructure.Services.PrintService;

[SupportedOSPlatform("windows")]
public static class WinSpoolApi
{
    public const uint PRINTER_STATUS_PAUSED = 0x00000001;
    public const uint PRINTER_STATUS_ERROR = 0x00000002;
    public const uint PRINTER_STATUS_PENDING_DELETION = 0x00000004;
    public const uint PRINTER_STATUS_PAPER_JAM = 0x00000008;
    public const uint PRINTER_STATUS_PAPER_OUT = 0x00000010;
    public const uint PRINTER_STATUS_MANUAL_FEED = 0x00000020;
    public const uint PRINTER_STATUS_PAPER_PROBLEM = 0x00000040;
    public const uint PRINTER_STATUS_OFFLINE = 0x00000080;
    public const uint PRINTER_STATUS_IO_ACTIVE = 0x00000100;
    public const uint PRINTER_STATUS_BUSY = 0x00000200;
    public const uint PRINTER_STATUS_PRINTING = 0x00000400;
    public const uint PRINTER_STATUS_OUTPUT_BIN_FULL = 0x00000800;
    public const uint PRINTER_STATUS_NOT_AVAILABLE = 0x00001000;
    public const uint PRINTER_STATUS_WAITING = 0x00002000;
    public const uint PRINTER_STATUS_PROCESSING = 0x00004000;
    public const uint PRINTER_STATUS_INITIALIZING = 0x00008000;
    public const uint PRINTER_STATUS_WARMING_UP = 0x00010000;
    public const uint PRINTER_STATUS_TONER_LOW = 0x00020000;
    public const uint PRINTER_STATUS_NO_TONER = 0x00040000;
    public const uint PRINTER_STATUS_PAGE_PUNT = 0x00080000;
    public const uint PRINTER_STATUS_USER_INTERVENTION = 0x00100000;
    public const uint PRINTER_STATUS_OUT_OF_MEMORY = 0x00200000;
    public const uint PRINTER_STATUS_DOOR_OPEN = 0x00400000;
    public const uint PRINTER_STATUS_SERVER_UNKNOWN = 0x00800000;
    public const uint PRINTER_STATUS_POWER_SAVE = 0x01000000;

    public const uint FATAL_STATUS_MASK = PRINTER_STATUS_ERROR |
                                          PRINTER_STATUS_PAPER_JAM |
                                          PRINTER_STATUS_PAPER_OUT |
                                          PRINTER_STATUS_PAPER_PROBLEM |
                                          PRINTER_STATUS_OFFLINE |
                                          PRINTER_STATUS_OUTPUT_BIN_FULL |
                                          PRINTER_STATUS_NO_TONER |
                                          PRINTER_STATUS_USER_INTERVENTION |
                                          PRINTER_STATUS_DOOR_OPEN;

    public const int PRINTER_CONTROL_SET_STATUS = 4;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct PRINTER_INFO_2
    {
        public string? pServerName;
        public string? pPrinterName;
        public string? pShareName;
        public string? pPortName;
        public string? pDriverName;
        public string? pComment;
        public string? pLocation;
        public IntPtr pDevMode;
        public string? pSepFile;
        public string? pPrintProcessor;
        public string? pDatatype;
        public string? pParameters;
        public IntPtr pSecurityDescriptor;
        public uint Attributes;
        public uint Priority;
        public uint DefaultPriority;
        public uint StartTime;
        public uint UntilTime;
        public uint Status;
        public uint cJobs;
        public uint AveragePPM;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct DOC_INFO_1
    {
        public string? pDocName;
        public string? pOutputFile;
        public string? pDatatype;
    }

    [DllImport("winspool.drv", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern bool GetPrinter(IntPtr hPrinter, int dwLevel, IntPtr pPrinter, int cbBuf, out int pcbNeeded);

    [DllImport("winspool.drv", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern bool SetPrinter(IntPtr hPrinter, int dwLevel, IntPtr pPrinter, int dwCommand);

    [DllImport("winspool.drv", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern int StartDocPrinter(IntPtr hPrinter, int level, ref DOC_INFO_1 di1);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    public static bool GetPrinterStatus(string printerName, out uint status, out string description)
    {
        status = 0;
        description = "Unknown";

        if (!OpenPrinter(printerName, out IntPtr hPrinter, IntPtr.Zero))
        {
            description = "Failed to OpenPrinter";
            return false;
        }

        try
        {
            _ = GetPrinter(hPrinter, 2, IntPtr.Zero, 0, out int cbNeeded);
            if (cbNeeded <= 0)
            {
                description = "GetPrinter reported buffer size <= 0";
                return false;
            }

            IntPtr pPrinter = Marshal.AllocHGlobal(cbNeeded);
            try
            {
                if (GetPrinter(hPrinter, 2, pPrinter, cbNeeded, out _))
                {
                    var info = Marshal.PtrToStructure<PRINTER_INFO_2>(pPrinter);
                    status = info.Status;
                    description = GetStatusDescription(status);
                    return true;
                }
                else
                {
                    description = "GetPrinter call failed";
                    return false;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(pPrinter);
            }
        }
        catch (Exception ex)
        {
            description = $"Exception: {ex.Message}";
            return false;
        }
        finally
        {
            _ = ClosePrinter(hPrinter);
        }
    }

    public static bool NudgePrinter(string printerName)
    {
        if (!OpenPrinter(printerName, out IntPtr hPrinter, IntPtr.Zero))
        {
            return false;
        }

        try
        {
            var di = new DOC_INFO_1
            {
                pDocName = "Status Nudge",
                pOutputFile = null,
                pDatatype = "RAW"
            };

            int docId = StartDocPrinter(hPrinter, 1, ref di);
            if (docId > 0)
            {
                _ = EndDocPrinter(hPrinter);
                return true;
            }
        }
        catch
        {
            // Ignore nudge failures
        }
        finally
        {
            _ = ClosePrinter(hPrinter);
        }

        return false;
    }

    public static bool SetPrinterStatusReset(string printerName)
    {
        if (!OpenPrinter(printerName, out IntPtr hPrinter, IntPtr.Zero))
        {
            return false;
        }

        try
        {
            return SetPrinter(hPrinter, 0, IntPtr.Zero, PRINTER_CONTROL_SET_STATUS);
        }
        catch
        {
            return false;
        }
        finally
        {
            _ = ClosePrinter(hPrinter);
        }
    }

    public static string GetStatusDescription(uint status)
    {
        var flags = new List<string>();
        if ((status & PRINTER_STATUS_PAUSED) != 0) flags.Add("PAUSED");
        if ((status & PRINTER_STATUS_ERROR) != 0) flags.Add("ERROR");
        if ((status & PRINTER_STATUS_PENDING_DELETION) != 0) flags.Add("PENDING_DELETION");
        if ((status & PRINTER_STATUS_PAPER_JAM) != 0) flags.Add("PAPER_JAM");
        if ((status & PRINTER_STATUS_PAPER_OUT) != 0) flags.Add("PAPER_OUT");
        if ((status & PRINTER_STATUS_MANUAL_FEED) != 0) flags.Add("MANUAL_FEED");
        if ((status & PRINTER_STATUS_PAPER_PROBLEM) != 0) flags.Add("PAPER_PROBLEM");
        if ((status & PRINTER_STATUS_OFFLINE) != 0) flags.Add("OFFLINE");
        if ((status & PRINTER_STATUS_BUSY) != 0) flags.Add("BUSY");
        if ((status & PRINTER_STATUS_PRINTING) != 0) flags.Add("PRINTING");
        if ((status & PRINTER_STATUS_OUTPUT_BIN_FULL) != 0) flags.Add("OUTPUT_BIN_FULL");
        if ((status & PRINTER_STATUS_NOT_AVAILABLE) != 0) flags.Add("NOT_AVAILABLE");
        if ((status & PRINTER_STATUS_WAITING) != 0) flags.Add("WAITING");
        if ((status & PRINTER_STATUS_PROCESSING) != 0) flags.Add("PROCESSING");
        if ((status & PRINTER_STATUS_INITIALIZING) != 0) flags.Add("INITIALIZING");
        if ((status & PRINTER_STATUS_WARMING_UP) != 0) flags.Add("WARMING_UP");
        if ((status & PRINTER_STATUS_TONER_LOW) != 0) flags.Add("TONER_LOW");
        if ((status & PRINTER_STATUS_NO_TONER) != 0) flags.Add("NO_TONER");
        if ((status & PRINTER_STATUS_PAGE_PUNT) != 0) flags.Add("PAGE_PUNT");
        if ((status & PRINTER_STATUS_USER_INTERVENTION) != 0) flags.Add("USER_INTERVENTION");
        if ((status & PRINTER_STATUS_OUT_OF_MEMORY) != 0) flags.Add("OUT_OF_MEMORY");
        if ((status & PRINTER_STATUS_DOOR_OPEN) != 0) flags.Add("DOOR_OPEN");
        if ((status & PRINTER_STATUS_SERVER_UNKNOWN) != 0) flags.Add("SERVER_UNKNOWN");
        if ((status & PRINTER_STATUS_POWER_SAVE) != 0) flags.Add("POWER_SAVE");

        return flags.Count > 0 ? string.Join("|", flags) : "READY";
    }
}
