using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace PrintBit.Infrastructure.Windows.Networking;

public interface IKioskNetworkPlatform
{
    Task<KioskNetworkSnapshot> PrepareAsync(IReadOnlyList<string> preferredSubnetPrefixes, int port, CancellationToken cancellationToken);
}