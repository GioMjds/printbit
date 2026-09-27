using System.Threading;
using System.Threading.Tasks;

namespace PrintBit.Infrastructure.Windows.Time;

public interface ITrustedTimeProvider
{
    Task<TrustedTimeSnapshot> GetStatusAsync(string? ntpServer, int maxDriftMs, CancellationToken cancellationToken);
}