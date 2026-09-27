using Microsoft.Extensions.Logging;

namespace PrintBit.Infrastructure.Services.WatchdogService;

public class WatchdogService
{
    private readonly ILogger<WatchdogService> _logger;

    public WatchdogService(
        ILogger<WatchdogService> logger)
    {
        _logger = logger;
    }

    public void Heartbeat()
    {
        _logger.LogInformation(
            "Hardware watchdog heartbeat: {time}",
            DateTime.UtcNow);
    }
}