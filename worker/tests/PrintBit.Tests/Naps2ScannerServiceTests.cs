using System.Reflection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PrintBit.Infrastructure.Windows.Scanning;
using PrintBit.Shared.Configurations;
using Xunit;

namespace PrintBit.Tests;

public sealed class Naps2ScannerServiceTests : IDisposable
{
    private readonly string _tempDirectory = Path.Combine(Path.GetTempPath(), $"PrintBit-Naps2Tests-{Guid.NewGuid():N}");

    public Naps2ScannerServiceTests()
    {
        Directory.CreateDirectory(_tempDirectory);
    }

    [Fact]
    public async Task ProbeCapabilitiesAsync_PrefersWiaBeforeTwain()
    {
        var driverLog = Path.Combine(_tempDirectory, "drivers.txt");
        var naps2Path = CreateNaps2Script($$"""
            @echo off
            echo %3>>"{{driverLog}}"
            if /I "%3"=="wia" (
                echo EPSON L5290 Series
                exit /b 0
            )

            exit /b 1
            """);
        var service = CreateService(naps2Path);

        var capabilities = await service.ProbeCapabilitiesAsync();

        Assert.True(capabilities.Available);
        Assert.Equal(["wia"], await File.ReadAllLinesAsync(driverLog));
    }

    [Fact]
    public async Task ProbeCapabilitiesAsync_KillsTimedOutProbeBeforeItCanFinish()
    {
        var completionMarker = Path.Combine(_tempDirectory, "probe-finished.txt");
        var naps2Path = CreateNaps2Script($$"""
            @echo off
            ping 127.0.0.1 -n 4 > nul
            echo finished>"{{completionMarker}}"
            exit /b 0
            """);
        var service = CreateService(naps2Path, probeTimeoutSeconds: 1);

        var capabilities = await service.ProbeCapabilitiesAsync();
        await Task.Delay(TimeSpan.FromSeconds(4));

        Assert.False(capabilities.Available);
        Assert.False(File.Exists(completionMarker));
    }

    [Fact]
    public void BuildNaps2Args_DisablesSavedProfiles()
    {
        var args = InvokeBuildNaps2Args("glass", "A4");

        Assert.Contains("--noprofile", args, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("glass", "A4", "--pagesize 216x297mm")]
    [InlineData("feeder", "A4", "--pagesize a4")]
    [InlineData("feeder", "Letter", "--pagesize letter")]
    [InlineData("feeder", "Legal", "--pagesize 216x330mm")]
    public void BuildNaps2Args_UsesDeterministicPageSize(
        string source, string paperSize, string expectedPageSize)
    {
        var args = InvokeBuildNaps2Args(source, paperSize);
        Assert.Contains("--noprofile", args, StringComparison.Ordinal);
        Assert.Contains(expectedPageSize, args, StringComparison.Ordinal);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDirectory))
        {
            Directory.Delete(_tempDirectory, recursive: true);
        }
    }

    private Naps2ScannerService CreateService(string naps2Path, int probeTimeoutSeconds = 5) =>
        new(
            NullLogger<Naps2ScannerService>.Instance,
            NullLogger<StubScannerService>.Instance,
            Options.Create(new ScannerSettings
            {
                Naps2Path = naps2Path,
                PreferredScannerName = "EPSON L5290 Series",
                ProbeTimeoutSeconds = probeTimeoutSeconds,
                EnableStubFallback = false
            }));

    private static string InvokeBuildNaps2Args(string source, string paperSize)
    {
        var method = typeof(Naps2ScannerService).GetMethod(
            "BuildNaps2Args",
            BindingFlags.NonPublic | BindingFlags.Static);

        return (string)method!.Invoke(null,
        [
            @"C:\PrintBit\scan.pdf",
            "wia",
            "EPSON L5290 Series",
            source,
            300,
            "color",
            paperSize
        ])!;
    }

    private string CreateNaps2Script(string content)
    {
        var path = Path.Combine(_tempDirectory, "naps2.cmd");
        File.WriteAllText(path, content.Replace("\n", "\r\n"));
        return path;
    }
}
