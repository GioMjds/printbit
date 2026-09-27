using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Shared.Configurations;

namespace PrintBit.Tests;

public class PrinterProfileResolverTests
{
    [Fact]
    public void Resolve_Standard_UsesConfiguredStandardQueue()
    {
        var settings = new HardwareSettings
        {
            PrinterName = "EPSON L5290 Series",
            PrinterProfiles = new PrinterProfileSettings
            {
                Standard = "PrintBit - Standard",
                High = "PrintBit - High"
            }
        };

        Assert.Equal(
            "PrintBit - Standard",
            PrinterProfileResolver.Resolve(settings, "standard"));
    }

    [Fact]
    public void Resolve_Standard_FallsBackToPhysicalPrinterName()
    {
        var settings = new HardwareSettings
        {
            PrinterName = "EPSON L5290 Series"
        };

        Assert.Equal(
            "EPSON L5290 Series",
            PrinterProfileResolver.Resolve(settings, "standard"));
    }

    [Fact]
    public void Resolve_High_UsesConfiguredHighQueue()
    {
        var settings = new HardwareSettings
        {
            PrinterName = "EPSON L5290 Series",
            PrinterProfiles = new PrinterProfileSettings
            {
                High = "PrintBit - High"
            }
        };

        Assert.Equal(
            "PrintBit - High",
            PrinterProfileResolver.Resolve(settings, "HIGH"));
    }

    [Fact]
    public void Resolve_HighWithoutConfiguredQueue_RejectsDispatch()
    {
        var settings = new HardwareSettings
        {
            PrinterName = "EPSON L5290 Series"
        };

        var error = Assert.Throws<InvalidOperationException>(
            () => PrinterProfileResolver.Resolve(settings, "high"));

        Assert.Contains("High-quality printer profile", error.Message);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("draft")]
    [InlineData("600dpi")]
    public void Resolve_UnknownQuality_RejectsDispatch(string? quality)
    {
        var settings = new HardwareSettings
        {
            PrinterName = "EPSON L5290 Series",
            PrinterProfiles = new PrinterProfileSettings
            {
                High = "PrintBit - High"
            }
        };

        Assert.Throws<ArgumentException>(
            () => PrinterProfileResolver.Resolve(settings, quality));
    }

    [Fact]
    public void Resolve_StandardLandscape_UsesConfiguredStandardLandscapeQueue()
    {
        var settings = new HardwareSettings
        {
            PrinterName = "EPSON L5290 Series",
            PrinterProfiles = new PrinterProfileSettings
            {
                Standard = "EPSON L5290 Series",
                High = "PrintBit - High",
                StandardLandscape = "PrintBit - Landscape",
                HighLandscape = "PrintBit - High - Landscape"
            }
        };

        Assert.Equal(
            "PrintBit - Landscape",
            PrinterProfileResolver.Resolve(settings, "standard", "landscape"));
    }

    [Fact]
    public void Resolve_HighLandscape_UsesConfiguredHighLandscapeQueue()
    {
        var settings = new HardwareSettings
        {
            PrinterName = "EPSON L5290 Series",
            PrinterProfiles = new PrinterProfileSettings
            {
                Standard = "EPSON L5290 Series",
                High = "PrintBit - High",
                StandardLandscape = "PrintBit - Landscape",
                HighLandscape = "PrintBit - High - Landscape"
            }
        };

        Assert.Equal(
            "PrintBit - High - Landscape",
            PrinterProfileResolver.Resolve(settings, "high", "landscape"));
    }

    [Fact]
    public void Resolve_HighLandscape_FallsBackToStandardLandscapeWhenHighLandscapeMissing()
    {
        var settings = new HardwareSettings
        {
            PrinterName = "EPSON L5290 Series",
            PrinterProfiles = new PrinterProfileSettings
            {
                Standard = "EPSON L5290 Series",
                High = "PrintBit - High",
                StandardLandscape = "PrintBit - Landscape"
            }
        };

        Assert.Equal(
            "PrintBit - Landscape",
            PrinterProfileResolver.Resolve(settings, "high", "landscape"));
    }

    [Fact]
    public void Resolve_Landscape_FallsBackToQualityProfileWhenNoLandscapeConfigured()
    {
        var settings = new HardwareSettings
        {
            PrinterName = "EPSON L5290 Series",
            PrinterProfiles = new PrinterProfileSettings
            {
                Standard = "EPSON L5290 Series",
                High = "PrintBit - High"
            }
        };

        Assert.Equal(
            "EPSON L5290 Series",
            PrinterProfileResolver.Resolve(settings, "standard", "landscape"));
        Assert.Equal(
            "PrintBit - High",
            PrinterProfileResolver.Resolve(settings, "high", "landscape"));
    }

    [Fact]
    public void Resolve_PortraitExplicit_UsesPortraitQueue()
    {
        var settings = new HardwareSettings
        {
            PrinterName = "EPSON L5290 Series",
            PrinterProfiles = new PrinterProfileSettings
            {
                Standard = "EPSON L5290 Series",
                High = "PrintBit - High",
                StandardLandscape = "PrintBit - Landscape",
                HighLandscape = "PrintBit - High - Landscape"
            }
        };

        Assert.Equal(
            "EPSON L5290 Series",
            PrinterProfileResolver.Resolve(settings, "standard", "portrait"));
        Assert.Equal(
            "PrintBit - High",
            PrinterProfileResolver.Resolve(settings, "high", "portrait"));
    }
}
