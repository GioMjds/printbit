using System.IO.Pipes;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Shared.Configurations;
using Xunit;

namespace PrintBit.Tests;

public class WorkerEventPipeClientTests
{
    [Fact]
    public async Task SupervisorSnapshotIsTopLevelJsonUsingContractSerializer()
    {
        var snapshot = PrinterSupervisorSnapshot.Ready(42, DateTime.UtcNow, "Printer", "USB007");
        var json = await Receive(client => client.PublishSupervisorAsync(snapshot));
        Assert.Equal(JsonSerializer.Serialize(snapshot, WorkerJson.Options), json);
        using var document = JsonDocument.Parse(json);
        Assert.Equal("PrinterSupervisorSnapshot", document.RootElement.GetProperty("type").GetString());
        Assert.Equal(42, document.RootElement.GetProperty("sequence").GetInt64());
        Assert.Equal("ready", document.RootElement.GetProperty("status").GetString());
        Assert.False(document.RootElement.TryGetProperty("supervisorSnapshot", out _));
        Assert.False(document.RootElement.TryGetProperty("transactionId", out _));
    }

    [Fact]
    public async Task LegacyEventsUseSameContractSerializer()
    {
        var evt = new WorkerPrintEvent { Type = WorkerPrintEventType.PrintStarted, TransactionId = "txn" };
        var json = await Receive(client => client.PublishAsync(evt));
        Assert.Equal(JsonSerializer.Serialize(evt, WorkerJson.Options), json);
    }

    private static async Task<string> Receive(Func<IWorkerEventPipeClient, Task<bool>> send)
    {
        var pipeName = "printbit-supervisor-test-" + Guid.NewGuid().ToString("N");
        await using var server = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var connected = server.WaitForConnectionAsync(deadline.Token);
        IWorkerEventPipeClient client = new WorkerEventPipeClient(NullLogger<WorkerEventPipeClient>.Instance,
            Options.Create(new IpcSettings { WorkerReturnPipeName = pipeName }));
        var sent = send(client);
        await connected;
        using var reader = new StreamReader(server);
        var json = await reader.ReadLineAsync(deadline.Token);
        Assert.True(await sent);
        return json!;
    }
}
