using PrintBit.Infrastructure.Services.PrintService;
using Xunit;

namespace PrintBit.Tests;

public class PrintPlanBuilderTests
{
    [Fact]
    public void Build_WithStructuredPageSelection_ReturnsCorrectPlan()
    {
        var settings = new PrintJobSettings
        {
            Copies = 1,
            PageSelection = new PageSelectionDto(
                "custom",
                new[]
                {
                    new PageRangeDto(1, 5),
                    new PageRangeDto(7, 9),
                    new PageRangeDto(15, 15),
                    new PageRangeDto(22, 25)
                }
            )
        };

        var plan = PrintPlanBuilder.Build(30, settings);

        Assert.Equal(13, plan.TotalSelectedPages);
        Assert.Equal(new[] { 1, 2, 3, 4, 5, 7, 8, 9, 15, 22, 23, 24, 25 }, plan.SelectedPages);
        Assert.Equal("1-5,7-9,15,22-25", plan.NormalizedRangeString);
    }

    [Fact]
    public void Build_WithOverlappingRanges_MergesPagesCorrectly()
    {
        var settings = new PrintJobSettings
        {
            Copies = 1,
            PageSelection = new PageSelectionDto(
                "custom",
                new[]
                {
                    new PageRangeDto(1, 5),
                    new PageRangeDto(4, 9)
                }
            )
        };

        var plan = PrintPlanBuilder.Build(30, settings);

        Assert.Equal(9, plan.TotalSelectedPages);
        Assert.Equal(Enumerable.Range(1, 9), plan.SelectedPages);
        Assert.Equal("1-9", plan.NormalizedRangeString);
    }

    [Fact]
    public void Build_WithLegacyString_FallsBackSuccessfully()
    {
        var settings = new PrintJobSettings
        {
            Copies = 1,
            PageRange = "1-3, 5, 7-9"
        };

        var plan = PrintPlanBuilder.Build(30, settings);

        Assert.Equal(7, plan.TotalSelectedPages);
        Assert.Equal(new[] { 1, 2, 3, 5, 7, 8, 9 }, plan.SelectedPages);
        Assert.Equal("1-3,5,7-9", plan.NormalizedRangeString);
    }

    [Fact]
    public void Build_SinglePageSelection_ReturnsSinglePage()
    {
        var settings = new PrintJobSettings
        {
            Copies = 1,
            PageSelection = new PageSelectionDto(
                "single",
                new[] { new PageRangeDto(4, 4) }
            )
        };

        var plan = PrintPlanBuilder.Build(10, settings);
        Assert.Single(plan.SelectedPages);
        Assert.Equal(4, plan.SelectedPages[0]);
        Assert.Equal("4", plan.NormalizedRangeString);
    }

    [Fact]
    public void Build_WhenRangeExceedsPageCount_ThrowsInvalidDataException()
    {
        var settings = new PrintJobSettings
        {
            Copies = 1,
            PageSelection = new PageSelectionDto(
                "custom",
                new[] { new PageRangeDto(1, 35) }
            )
        };

        Assert.Throws<InvalidDataException>(() => PrintPlanBuilder.Build(30, settings));
    }
}
