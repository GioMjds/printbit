using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using PrintBit.Shared.Power;

namespace PrintBit.Infrastructure.Windows.PowerMonitoring;

[SupportedOSPlatform("windows")]
public partial class NativePowerStatusProvider : IPowerStatusProvider
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct SYSTEM_POWER_STATUS
    {
        public byte ACLineStatus;
        public byte BatteryFlag;
        public byte BatteryLifePercent;
        public byte SystemStatusFlag;
        public int BatteryLifeTime;
        public int BatteryFullLifeTime;
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS lpSystemPowerStatus);

    public bool TryGetStatus(out PowerStatusSnapshot snapshot, out string? error)
    {
        if (!GetSystemPowerStatus(out var raw))
        {
            var win32Error = Marshal.GetLastPInvokeError();
            error = $"GetSystemPowerStatus failed with Win32 error {win32Error}";
            snapshot = new PowerStatusSnapshot(
                AcLineStatus.Unknown,
                IsCharging: null,
                BatteryPercentage: null,
                IsBatteryLow: null,
                IsBatteryCritical: null);
            return false;
        }

        error = null;
        snapshot = MapStatus(raw);
        return true;
    }

    internal static PowerStatusSnapshot MapStatus(SYSTEM_POWER_STATUS raw)
    {
        var acStatus = raw.ACLineStatus switch
        {
            0 => AcLineStatus.Offline,
            1 => AcLineStatus.Online,
            _ => AcLineStatus.Unknown
        };

        bool? isCharging = null;
        bool? isBatteryLow = null;
        bool? isBatteryCritical = null;

        if (raw.BatteryFlag != 255)
        {
            isCharging = (raw.BatteryFlag & 8) != 0;
            isBatteryLow = (raw.BatteryFlag & 2) != 0;
            isBatteryCritical = (raw.BatteryFlag & 4) != 0;
        }

        int? batteryPercentage = raw.BatteryLifePercent != 255
            ? raw.BatteryLifePercent
            : null;

        return new PowerStatusSnapshot(
            acStatus,
            isCharging,
            batteryPercentage,
            isBatteryLow,
            isBatteryCritical);
    }
}
