using System;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Moq;
using PrintBit.HardwareService.Services;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Shared.Configurations;
using Xunit;

namespace PrintBit.Tests;

public class WorkerCommandPipeTests
{
    private readonly Mock<IPrinterRecoveryService> _recoveryServiceMock;
    private readonly Mock<ILogger<WorkerCommandPipeHostedService>> _loggerMock;
    private readonly IpcSettings _ipcSettings;

    public WorkerCommandPipeTests()
    {
        _recoveryServiceMock = new Mock<IPrinterRecoveryService>();
        _loggerMock = new Mock<ILogger<WorkerCommandPipeHostedService>>();
        _ipcSettings = new IpcSettings
        {
            WorkerCommandPipeName = "test-worker-commands-" + Guid.NewGuid().ToString("N"),
            MaxMessageBytes = 8192
        };
    }

    private WorkerCommandPipeHostedService CreateHostedService()
    {
        return new WorkerCommandPipeHostedService(
            _loggerMock.Object,
            _recoveryServiceMock.Object,
            Options.Create(_ipcSettings));
    }

    #region 1. Command Parser Tests (Valid Cases)

    [Fact]
    public void Parser_ValidGetPrinterRecoveryStatus_ParsesSuccessfully()
    {
        const string json = "{\"requestId\":\"req-001\",\"type\":\"GetPrinterRecoveryStatus\",\"timestampUtc\":\"2026-09-02T01:00:00Z\"}";

        var parsed = WorkerCommandParser.TryParse(
            json,
            maxBytes: 8192,
            out var command,
            out var errorDetail,
            out var requestId);

        Assert.True(parsed);
        Assert.Null(errorDetail);
        Assert.NotNull(command);
        Assert.Equal("req-001", requestId);
        Assert.Equal("req-001", command.RequestId);
        Assert.Equal(PrinterRecoveryCommandType.GetPrinterRecoveryStatus, command.Type);
    }

    [Fact]
    public void Parser_ValidAttemptPrinterRecovery_ParsesSuccessfully()
    {
        const string json = "{\"requestId\":\"req-002\",\"type\":\"AttemptPrinterRecovery\",\"timestampUtc\":\"2026-09-02T01:05:00Z\"}";

        var parsed = WorkerCommandParser.TryParse(
            json,
            maxBytes: 8192,
            out var command,
            out var errorDetail,
            out var requestId);

        Assert.True(parsed);
        Assert.Null(errorDetail);
        Assert.NotNull(command);
        Assert.Equal("req-002", requestId);
        Assert.Equal("req-002", command.RequestId);
        Assert.Equal(PrinterRecoveryCommandType.AttemptPrinterRecovery, command.Type);
    }

    #endregion

    #region 2. Command Parser Tests (Invalid Cases)

    [Fact]
    public void Parser_MalformedJson_ReturnsFalseAndError()
    {
        const string json = "{not-valid-json";

        var parsed = WorkerCommandParser.TryParse(
            json,
            maxBytes: 8192,
            out var command,
            out var errorDetail,
            out var requestId);

        Assert.False(parsed);
        Assert.Null(command);
        Assert.NotNull(errorDetail);
        Assert.Equal(string.Empty, requestId);
    }

    [Fact]
    public void Parser_EmptyOrWhitespaceString_ReturnsFalseAndError()
    {
        var parsed1 = WorkerCommandParser.TryParse(
            "",
            maxBytes: 8192,
            out var command1,
            out var errorDetail1,
            out var requestId1);

        Assert.False(parsed1);
        Assert.Null(command1);
        Assert.NotNull(errorDetail1);
        Assert.Equal(string.Empty, requestId1);

        var parsed2 = WorkerCommandParser.TryParse(
            "   \r\n",
            maxBytes: 8192,
            out var command2,
            out var errorDetail2,
            out var requestId2);

        Assert.False(parsed2);
        Assert.Null(command2);
        Assert.NotNull(errorDetail2);
        Assert.Equal(string.Empty, requestId2);
    }

    [Fact]
    public void Parser_OversizedPayload_ReturnsFalseWithoutParsing()
    {
        var largePayload = "{\"requestId\":\"req-big\",\"type\":\"GetPrinterRecoveryStatus\",\"extra\":\""
            + new string('a', 100) + "\"}";

        var parsed = WorkerCommandParser.TryParse(
            largePayload,
            maxBytes: 50,
            out var command,
            out var errorDetail,
            out var requestId);

        Assert.False(parsed);
        Assert.Null(command);
        Assert.NotNull(errorDetail);
        Assert.Equal(string.Empty, requestId);
    }

    [Fact]
    public void Parser_UnknownCommandType_ReturnsFalseAndExtractsRequestId()
    {
        const string json = "{\"requestId\":\"req-unknown\",\"type\":\"UnknownCommand\"}";

        var parsed = WorkerCommandParser.TryParse(
            json,
            maxBytes: 8192,
            out var command,
            out var errorDetail,
            out var requestId);

        Assert.False(parsed);
        Assert.Null(command);
        Assert.NotNull(errorDetail);
        Assert.Equal("req-unknown", requestId);
    }

    [Fact]
    public void Parser_MissingRequestId_ReturnsFalse()
    {
        const string json = "{\"type\":\"GetPrinterRecoveryStatus\"}";

        var parsed = WorkerCommandParser.TryParse(
            json,
            maxBytes: 8192,
            out var command,
            out var errorDetail,
            out var requestId);

        Assert.False(parsed);
        Assert.Null(command);
        Assert.NotNull(errorDetail);
        Assert.Equal(string.Empty, requestId);
    }

    [Theory]
    [InlineData("{\"requestId\":\"req-no-type\"}", "req-no-type")]
    [InlineData("{\"requestId\":\"req-wrong-prop\",\"command\":\"AttemptPrinterRecovery\"}", "req-wrong-prop")]
    [InlineData("{\"requestId\":\"req-empty-type\",\"type\":\"\"}", "req-empty-type")]
    [InlineData("{\"requestId\":\"req-whitespace-type\",\"type\":\"   \"}", "req-whitespace-type")]
    public void Parser_MissingOrEmptyTypeProperty_ReturnsFalseAndPreservesRequestId(
        string json,
        string expectedRequestId)
    {
        var parsed = WorkerCommandParser.TryParse(
            json,
            maxBytes: 8192,
            out var command,
            out var errorDetail,
            out var requestId);

        Assert.False(parsed);
        Assert.Null(command);
        Assert.NotNull(errorDetail);
        Assert.Equal(expectedRequestId, requestId);
        Assert.Contains("type", errorDetail, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ReadLineWithLimitAsync_EmptyLineWithNewline_ReturnsEmptyStringNotEof()
    {
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes("\n"));
        var (line, oversized) = await WorkerCommandParser.ReadLineWithLimitAsync(stream, 8192);

        Assert.False(oversized);
        Assert.NotNull(line);
        Assert.Equal(string.Empty, line);
    }

    [Fact]
    public async Task ProcessRequestAsync_EmptyLineWithNewline_ReturnsInvalidRequest()
    {
        var service = CreateHostedService();

        using var inputStream = new MemoryStream(Encoding.UTF8.GetBytes("\n"));
        using var outputStream = new MemoryStream();

        var result = await service.ProcessRequestAsync(inputStream, outputStream, CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(string.Empty, result.RequestId);
        Assert.Equal(PrinterRecoveryOutcome.InvalidRequest, result.Outcome);
        Assert.Contains("empty", result.Message, StringComparison.OrdinalIgnoreCase);

        _recoveryServiceMock.Verify(r => r.GetStatusAsync(It.IsAny<CancellationToken>()), Times.Never);
        _recoveryServiceMock.Verify(r => r.AttemptRepairAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    #endregion

    #region 3. Pipe Security Test (Windows)

    [Fact]
    public void CreatePipeSecurity_Windows_GrantsOnlyAuthorizedPrincipals()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var security = WorkerCommandPipeSecurity.CreatePipeSecurity();
        Assert.NotNull(security);

        var rules = security.GetAccessRules(includeExplicit: true, includeInherited: false, typeof(SecurityIdentifier));

        bool foundAdmin = false;
        bool foundSystem = false;
        bool foundCurrentUser = false;
        var currentIdentity = WindowsIdentity.GetCurrent();

        foreach (PipeAccessRule rule in rules)
        {
            var sid = rule.IdentityReference as SecurityIdentifier;
            Assert.NotNull(sid);

            // Must NOT contain WorldSid (Everyone)
            Assert.False(
                sid.IsWellKnown(WellKnownSidType.WorldSid),
                "PipeSecurity must not contain WorldSid (Everyone).");

            // Must NOT contain AuthenticatedUserSid
            Assert.False(
                sid.IsWellKnown(WellKnownSidType.AuthenticatedUserSid),
                "PipeSecurity must not contain AuthenticatedUserSid.");

            if (sid.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid))
            {
                foundAdmin = true;
                Assert.Equal(PipeAccessRights.ReadWrite, rule.PipeAccessRights & PipeAccessRights.ReadWrite);
                Assert.Equal(AccessControlType.Allow, rule.AccessControlType);
            }
            else if (sid.IsWellKnown(WellKnownSidType.LocalSystemSid))
            {
                foundSystem = true;
                Assert.Equal(PipeAccessRights.FullControl, rule.PipeAccessRights & PipeAccessRights.FullControl);
                Assert.Equal(AccessControlType.Allow, rule.AccessControlType);
            }
            else if (currentIdentity.User != null && sid == currentIdentity.User)
            {
                foundCurrentUser = true;
                Assert.Equal(PipeAccessRights.FullControl, rule.PipeAccessRights & PipeAccessRights.FullControl);
                Assert.Equal(AccessControlType.Allow, rule.AccessControlType);
            }
        }

        Assert.True(foundAdmin, "PipeSecurity must contain BUILTIN\\Administrators.");
        Assert.True(foundSystem, "PipeSecurity must contain LocalSystem.");
        if (currentIdentity.User != null)
        {
            Assert.True(foundCurrentUser, "PipeSecurity must contain current service identity.");
        }
    }

    [Fact]
    public void CreatePipeSecurity_Windows_GrantsConfiguredClientSidReadWrite()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var clientSid = new SecurityIdentifier(WellKnownSidType.LocalServiceSid, null);
        var security = WorkerCommandPipeSecurity.CreatePipeSecurity(clientSid.Value);
        var rules = security.GetAccessRules(true, false, typeof(SecurityIdentifier));

        var clientRules = rules
            .OfType<PipeAccessRule>()
            .Where(rule => Equals(rule.IdentityReference, clientSid))
            .ToArray();

        var clientRule = Assert.Single(clientRules);
        Assert.Equal(AccessControlType.Allow, clientRule.AccessControlType);
        Assert.Equal(PipeAccessRights.ReadWrite, clientRule.PipeAccessRights & PipeAccessRights.ReadWrite);
        Assert.NotEqual(PipeAccessRights.FullControl, clientRule.PipeAccessRights & PipeAccessRights.FullControl);
    }

    [Theory]
    [InlineData(WellKnownSidType.WorldSid)]
    [InlineData(WellKnownSidType.AuthenticatedUserSid)]
    public void CreatePipeSecurity_Windows_RejectsBroadConfiguredPrincipal(WellKnownSidType sidType)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var broadSid = new SecurityIdentifier(sidType, null);
        Assert.Throws<ArgumentException>(
            () => WorkerCommandPipeSecurity.CreatePipeSecurity(broadSid.Value));
    }

    [Fact]
    public void CreatePipeSecurity_Windows_RejectsUnresolvableConfiguredAccount()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var missingAccount = $"PRINTBIT-MISSING\\{Guid.NewGuid():N}";
        Assert.Throws<IdentityNotMappedException>(
            () => WorkerCommandPipeSecurity.CreatePipeSecurity(missingAccount));
    }

    #endregion

    #region 4. Dispatch Test: GetPrinterRecoveryStatus

    [Fact]
    public async Task ProcessRequestAsync_ValidGetPrinterRecoveryStatus_CallsGetStatusAsyncAndReturnsResult()
    {
        var service = CreateHostedService();

        _recoveryServiceMock
            .Setup(r => r.GetStatusAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new PrinterRecoveryResult
            {
                RequestId = string.Empty,
                Type = PrinterRecoveryCommandType.GetPrinterRecoveryStatus,
                Outcome = PrinterRecoveryOutcome.Healthy,
                SpoolerState = new SpoolerStateDto
                {
                    IsRunning = true,
                    Status = "Running",
                    ErrorMessage = null
                },
                PrinterState = "Healthy",
                IssueKind = "None",
                Message = "Printer is healthy.",
                StartedAt = DateTime.UtcNow,
                CompletedAt = DateTime.UtcNow
            });

        const string requestJson = "{\"requestId\":\"req-get-1\",\"type\":\"GetPrinterRecoveryStatus\"}\n";
        using var inputStream = new MemoryStream(Encoding.UTF8.GetBytes(requestJson));
        using var outputStream = new MemoryStream();

        var result = await service.ProcessRequestAsync(inputStream, outputStream, CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal("req-get-1", result.RequestId);
        Assert.Equal(PrinterRecoveryCommandType.GetPrinterRecoveryStatus, result.Type);
        Assert.Equal(PrinterRecoveryOutcome.Healthy, result.Outcome);
        Assert.NotNull(result.SpoolerState);
        Assert.True(result.SpoolerState.IsRunning);
        Assert.Equal("Running", result.SpoolerState.Status);
        Assert.Null(result.SpoolerState.ErrorMessage);

        _recoveryServiceMock.Verify(r => r.GetStatusAsync(It.IsAny<CancellationToken>()), Times.Once);
        _recoveryServiceMock.Verify(r => r.AttemptRepairAsync(It.IsAny<CancellationToken>()), Times.Never);

        // Verify outputStream contains single-line JSON with newline
        var responseString = Encoding.UTF8.GetString(outputStream.ToArray());
        Assert.EndsWith("\n", responseString);

        var deserialized = JsonSerializer.Deserialize<PrinterRecoveryResult>(
            responseString.TrimEnd('\r', '\n'),
            WorkerCommandParser.JsonOptions);
        Assert.NotNull(deserialized);
        Assert.Equal("req-get-1", deserialized.RequestId);
        Assert.Equal(PrinterRecoveryOutcome.Healthy, deserialized.Outcome);
        Assert.NotNull(deserialized.SpoolerState);
        Assert.True(deserialized.SpoolerState.IsRunning);
        Assert.Equal("Running", deserialized.SpoolerState.Status);
        Assert.Null(deserialized.SpoolerState.ErrorMessage);
    }

    #endregion

    #region 5. Dispatch Test: AttemptPrinterRecovery

    [Fact]
    public async Task ProcessRequestAsync_ValidAttemptPrinterRecovery_CallsAttemptRepairAsyncAndReturnsResult()
    {
        var service = CreateHostedService();

        _recoveryServiceMock
            .Setup(r => r.AttemptRepairAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new PrinterRecoveryResult
            {
                RequestId = string.Empty,
                Type = PrinterRecoveryCommandType.AttemptPrinterRecovery,
                Outcome = PrinterRecoveryOutcome.Recovered,
                Action = "RestartSpooler",
                SpoolerState = new SpoolerStateDto
                {
                    IsRunning = true,
                    Status = "Running",
                    ErrorMessage = null
                },
                PrinterState = "Healthy",
                IssueKind = "None",
                Message = "Recovered after Spooler restart.",
                StartedAt = DateTime.UtcNow,
                CompletedAt = DateTime.UtcNow
            });

        const string requestJson = "{\"requestId\":\"req-repair-1\",\"type\":\"AttemptPrinterRecovery\"}\n";
        using var inputStream = new MemoryStream(Encoding.UTF8.GetBytes(requestJson));
        using var outputStream = new MemoryStream();

        var result = await service.ProcessRequestAsync(inputStream, outputStream, CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal("req-repair-1", result.RequestId);
        Assert.Equal(PrinterRecoveryCommandType.AttemptPrinterRecovery, result.Type);
        Assert.Equal(PrinterRecoveryOutcome.Recovered, result.Outcome);
        Assert.Equal("RestartSpooler", result.Action);
        Assert.NotNull(result.SpoolerState);
        Assert.True(result.SpoolerState.IsRunning);
        Assert.Equal("Running", result.SpoolerState.Status);
        Assert.Null(result.SpoolerState.ErrorMessage);

        _recoveryServiceMock.Verify(r => r.AttemptRepairAsync(It.IsAny<CancellationToken>()), Times.Once);
        _recoveryServiceMock.Verify(r => r.GetStatusAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    #endregion

    #region 6. Invalid Request Tests (Never Calls Service)

    [Theory]
    [InlineData("{bad-json\n", "")]
    [InlineData("{\"requestId\":\"req-unk\",\"type\":\"InvalidCommandType\"}\n", "req-unk")]
    [InlineData("{\"type\":\"GetPrinterRecoveryStatus\"}\n", "")]
    public async Task ProcessRequestAsync_InvalidPayload_DoesNotCallServiceAndReturnsInvalidRequest(
        string requestPayload,
        string expectedRequestId)
    {
        var service = CreateHostedService();

        using var inputStream = new MemoryStream(Encoding.UTF8.GetBytes(requestPayload));
        using var outputStream = new MemoryStream();

        var result = await service.ProcessRequestAsync(inputStream, outputStream, CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(expectedRequestId, result.RequestId);
        Assert.Equal(PrinterRecoveryOutcome.InvalidRequest, result.Outcome);
        Assert.False(string.IsNullOrWhiteSpace(result.Message));

        _recoveryServiceMock.Verify(r => r.GetStatusAsync(It.IsAny<CancellationToken>()), Times.Never);
        _recoveryServiceMock.Verify(r => r.AttemptRepairAsync(It.IsAny<CancellationToken>()), Times.Never);

        var responseString = Encoding.UTF8.GetString(outputStream.ToArray());
        Assert.EndsWith("\n", responseString);
    }

    [Fact]
    public async Task ProcessRequestAsync_OversizedPayload_DoesNotCallServiceAndReturnsInvalidRequest()
    {
        var smallSettings = new IpcSettings
        {
            WorkerCommandPipeName = "test-pipe",
            MaxMessageBytes = 40
        };
        var service = new WorkerCommandPipeHostedService(
            _loggerMock.Object,
            _recoveryServiceMock.Object,
            Options.Create(smallSettings));

        var largeJson = "{\"requestId\":\"req-large\",\"type\":\"GetPrinterRecoveryStatus\",\"extra\":\"too large\"}\n";
        using var inputStream = new MemoryStream(Encoding.UTF8.GetBytes(largeJson));
        using var outputStream = new MemoryStream();

        var result = await service.ProcessRequestAsync(inputStream, outputStream, CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(PrinterRecoveryOutcome.InvalidRequest, result.Outcome);
        Assert.Contains("exceeded", result.Message, StringComparison.OrdinalIgnoreCase);

        _recoveryServiceMock.Verify(r => r.GetStatusAsync(It.IsAny<CancellationToken>()), Times.Never);
        _recoveryServiceMock.Verify(r => r.AttemptRepairAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    #endregion

    #region 7. RequestId Preservation Test

    [Fact]
    public async Task ProcessRequestAsync_PreservesRequestId_AcrossRequestAndResponse()
    {
        var service = CreateHostedService();
        const string customRequestId = "client-assigned-correlation-id-9876";

        _recoveryServiceMock
            .Setup(r => r.GetStatusAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new PrinterRecoveryResult
            {
                RequestId = string.Empty, // Service doesn't know RequestId
                Type = PrinterRecoveryCommandType.GetPrinterRecoveryStatus,
                Outcome = PrinterRecoveryOutcome.Healthy,
                Message = "All good"
            });

        var requestJson = $"{{\"requestId\":\"{customRequestId}\",\"type\":\"GetPrinterRecoveryStatus\"}}\n";
        using var inputStream = new MemoryStream(Encoding.UTF8.GetBytes(requestJson));
        using var outputStream = new MemoryStream();

        var result = await service.ProcessRequestAsync(inputStream, outputStream, CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(customRequestId, result.RequestId);

        var responseString = Encoding.UTF8.GetString(outputStream.ToArray());
        var deserialized = JsonSerializer.Deserialize<PrinterRecoveryResult>(
            responseString.TrimEnd('\r', '\n'),
            WorkerCommandParser.JsonOptions);
        Assert.NotNull(deserialized);
        Assert.Equal(customRequestId, deserialized.RequestId);
    }

    #endregion

    #region 8. End-to-End Pipe Client/Server Test

    [Fact]
    public async Task EndToEnd_PipeClientServer_ExecutesCommandAndClosesConnection()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var pipeName = "test-e2e-pipe-" + Guid.NewGuid().ToString("N");
        var ipcSettings = new IpcSettings
        {
            WorkerCommandPipeName = pipeName,
            MaxMessageBytes = 8192
        };

        _recoveryServiceMock
            .Setup(r => r.GetStatusAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new PrinterRecoveryResult
            {
                RequestId = string.Empty,
                Type = PrinterRecoveryCommandType.GetPrinterRecoveryStatus,
                Outcome = PrinterRecoveryOutcome.Healthy,
                SpoolerState = new SpoolerStateDto
                {
                    IsRunning = true,
                    Status = "Running",
                    ErrorMessage = null
                },
                PrinterState = "Healthy",
                IssueKind = "None",
                Message = "Printer is ready."
            });

        var hostedService = new WorkerCommandPipeHostedService(
            _loggerMock.Object,
            _recoveryServiceMock.Object,
            Options.Create(ipcSettings));

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        // Start hosted service in background
        var hostedServiceTask = hostedService.StartAsync(cts.Token);

        // Allow pipe listener to initialize
        await Task.Delay(100, cts.Token);

        // Connect client
        await using var clientStream = new NamedPipeClientStream(
            ".",
            pipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous);

        await clientStream.ConnectAsync(3000, cts.Token);
        Assert.True(clientStream.IsConnected);

        // Send single-line command
        const string commandLine = "{\"requestId\":\"e2e-req-1\",\"type\":\"GetPrinterRecoveryStatus\"}\n";
        var requestBytes = Encoding.UTF8.GetBytes(commandLine);
        await clientStream.WriteAsync(requestBytes, cts.Token);
        await clientStream.FlushAsync(cts.Token);

        // Read single-line JSON response
        using var reader = new StreamReader(clientStream, Encoding.UTF8, leaveOpen: true);
        var responseLine = await reader.ReadLineAsync(cts.Token);

        Assert.NotNull(responseLine);
        Assert.False(string.IsNullOrWhiteSpace(responseLine));

        var result = JsonSerializer.Deserialize<PrinterRecoveryResult>(responseLine, WorkerCommandParser.JsonOptions);
        Assert.NotNull(result);
        Assert.Equal("e2e-req-1", result.RequestId);
        Assert.Equal(PrinterRecoveryCommandType.GetPrinterRecoveryStatus, result.Type);
        Assert.Equal(PrinterRecoveryOutcome.Healthy, result.Outcome);
        Assert.NotNull(result.SpoolerState);
        Assert.True(result.SpoolerState.IsRunning);
        Assert.Equal("Running", result.SpoolerState.Status);
        Assert.Null(result.SpoolerState.ErrorMessage);

        // Verify that after single response, the server closes/disconnects the pipe (next read yields EOF)
        var nextLine = await reader.ReadLineAsync(cts.Token);
        Assert.Null(nextLine);

        // Stop hosted service
        await hostedService.StopAsync(cts.Token);
        await hostedServiceTask;
    }

    [Fact]
    public async Task HostedService_AcceptsSecondClientWhileFirstRequestIsStillRunning()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var pipeName = "test-concurrent-pipe-" + Guid.NewGuid().ToString("N");
        var firstRequestStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirstRequest = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var callCount = 0;

        _recoveryServiceMock
            .Setup(r => r.GetStatusAsync(It.IsAny<CancellationToken>()))
            .Returns<CancellationToken>(async cancellationToken =>
            {
                var currentCall = Interlocked.Increment(ref callCount);
                if (currentCall == 1)
                {
                    firstRequestStarted.TrySetResult();
                    await releaseFirstRequest.Task.WaitAsync(cancellationToken);
                }

                return new PrinterRecoveryResult
                {
                    Type = PrinterRecoveryCommandType.GetPrinterRecoveryStatus,
                    Outcome = PrinterRecoveryOutcome.Healthy,
                    Message = "Printer is ready."
                };
            });

        var hostedService = new WorkerCommandPipeHostedService(
            _loggerMock.Object,
            _recoveryServiceMock.Object,
            Options.Create(new IpcSettings
            {
                WorkerCommandPipeName = pipeName,
                MaxMessageBytes = 8192
            }));

        using var serviceCts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await hostedService.StartAsync(serviceCts.Token);

        var firstResponseTask = SendStatusCommandAsync(pipeName, "concurrent-1", serviceCts.Token);
        await firstRequestStarted.Task.WaitAsync(TimeSpan.FromSeconds(3), serviceCts.Token);

        var secondResponseTask = SendStatusCommandAsync(pipeName, "concurrent-2", serviceCts.Token);
        var secondResponse = await secondResponseTask.WaitAsync(TimeSpan.FromSeconds(2), serviceCts.Token);

        Assert.Equal("concurrent-2", secondResponse.RequestId);
        Assert.Equal(PrinterRecoveryOutcome.Healthy, secondResponse.Outcome);

        releaseFirstRequest.TrySetResult();
        var firstResponse = await firstResponseTask.WaitAsync(TimeSpan.FromSeconds(2), serviceCts.Token);
        Assert.Equal("concurrent-1", firstResponse.RequestId);

        await hostedService.StopAsync(serviceCts.Token);
    }

    [Fact]
    public async Task HostedService_ContinuesAfterMalformedClientRequest()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var pipeName = "test-isolated-client-pipe-" + Guid.NewGuid().ToString("N");
        _recoveryServiceMock
            .Setup(r => r.GetStatusAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new PrinterRecoveryResult
            {
                Type = PrinterRecoveryCommandType.GetPrinterRecoveryStatus,
                Outcome = PrinterRecoveryOutcome.Healthy,
                Message = "Printer is ready."
            });

        var hostedService = new WorkerCommandPipeHostedService(
            _loggerMock.Object,
            _recoveryServiceMock.Object,
            Options.Create(new IpcSettings { WorkerCommandPipeName = pipeName }));
        using var serviceCts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await hostedService.StartAsync(serviceCts.Token);

        var malformedResponseLine = await SendRawCommandAsync(
            pipeName,
            "{not-json}\n",
            serviceCts.Token);
        var malformedResponse = JsonSerializer.Deserialize<PrinterRecoveryResult>(
            malformedResponseLine,
            WorkerCommandParser.JsonOptions);
        Assert.NotNull(malformedResponse);
        Assert.Equal(PrinterRecoveryOutcome.InvalidRequest, malformedResponse.Outcome);

        var validResponse = await SendStatusCommandAsync(pipeName, "after-malformed", serviceCts.Token);
        Assert.Equal("after-malformed", validResponse.RequestId);
        Assert.Equal(PrinterRecoveryOutcome.Healthy, validResponse.Outcome);

        await hostedService.StopAsync(serviceCts.Token);
    }

    [Fact]
    public async Task HostedService_StopCancelsAndAwaitsActiveClientHandlers()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var pipeName = "test-shutdown-pipe-" + Guid.NewGuid().ToString("N");
        var requestStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _recoveryServiceMock
            .Setup(r => r.GetStatusAsync(It.IsAny<CancellationToken>()))
            .Returns<CancellationToken>(async cancellationToken =>
            {
                requestStarted.TrySetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                return new PrinterRecoveryResult();
            });

        var hostedService = new WorkerCommandPipeHostedService(
            _loggerMock.Object,
            _recoveryServiceMock.Object,
            Options.Create(new IpcSettings { WorkerCommandPipeName = pipeName }));
        await hostedService.StartAsync(CancellationToken.None);

        var clientTask = SendStatusCommandAsync(pipeName, "shutdown-1", CancellationToken.None);
        await requestStarted.Task.WaitAsync(TimeSpan.FromSeconds(3));

        using var stopCts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        await hostedService.StopAsync(stopCts.Token);
        await Assert.ThrowsAnyAsync<Exception>(
            async () => await clientTask.WaitAsync(TimeSpan.FromSeconds(1)));
    }

    private static async Task<PrinterRecoveryResult> SendStatusCommandAsync(
        string pipeName,
        string requestId,
        CancellationToken cancellationToken)
    {
        var responseLine = await SendRawCommandAsync(
            pipeName,
            $"{{\"requestId\":\"{requestId}\",\"type\":\"GetPrinterRecoveryStatus\"}}\n",
            cancellationToken);

        return JsonSerializer.Deserialize<PrinterRecoveryResult>(
            responseLine,
            WorkerCommandParser.JsonOptions)!;
    }

    private static async Task<string> SendRawCommandAsync(
        string pipeName,
        string request,
        CancellationToken cancellationToken)
    {
        await using var client = new NamedPipeClientStream(
            ".",
            pipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous);
        await client.ConnectAsync(3000, cancellationToken);

        var requestBytes = Encoding.UTF8.GetBytes(request);
        await client.WriteAsync(requestBytes, cancellationToken);
        await client.FlushAsync(cancellationToken);

        using var reader = new StreamReader(client, Encoding.UTF8, leaveOpen: true);
        var responseLine = await reader.ReadLineAsync(cancellationToken);
        Assert.False(string.IsNullOrWhiteSpace(responseLine));
        return responseLine;
    }

    #endregion
}
