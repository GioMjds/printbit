using System;

namespace PrintBit.Infrastructure.Services.PrintService;

public interface ISystemClock
{
    DateTime UtcNow { get; }
}
