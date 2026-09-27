using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintBit.Application.Events;
using PrintBit.Application.StateMachine;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Shared.Configurations;

namespace PrintBit.Application.Handlers;

public class StartPrintHandler
{
    private readonly ILogger<StartPrintHandler> _logger;

    private readonly TransactionStateMachine _stateMachine;

    private readonly IPrintService _printService;

    private readonly HardwareSettings _settings;

    public StartPrintHandler(
        ILogger<StartPrintHandler> logger,
        TransactionStateMachine stateMachine,
        IPrintService printService,
        IOptions<HardwareSettings> options)
    {
        _logger = logger;
        _stateMachine = stateMachine;
        _printService = printService;
        _settings = options.Value;
    }

    public async Task HandleAsync(
        StartPrintEvent evt,
        CancellationToken cancellationToken = default)
    {
        if (!_stateMachine.TryStartPrinting())
        {
            _logger.LogWarning(
                "Print start ignored because state is {state}",
                _stateMachine.CurrentState);

            return;
        }

        try
        {
            var result = await _printService.PrintAsync(
                new PrintJobRequest
                {
                    FilePath = evt.FilePath,
                    PrinterName = _settings.PrinterName
                },
                cancellationToken);

            if (result.SumatraProcessSucceeded)
            {
                _stateMachine.TryStartVerifying();
            }

            if (!result.Success)
            {
                _stateMachine.TryMarkFailed(
                    $"Stage={result.FailureStage}; Message={result.Message}");

                _logger.LogError(
                    "Print failed | Stage={stage} | Message={message}",
                    result.FailureStage,
                    result.Message);

                return;
            }

            if (!_stateMachine.TryMarkSuccess())
            {
                _logger.LogError(
                    "Print result was successful but state transition to Success was rejected. Current state: {state}",
                    _stateMachine.CurrentState);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            _stateMachine.TryMarkFailed("Print cancelled by host shutdown");
            throw;
        }
        catch (Exception ex)
        {
            _stateMachine.TryMarkFailed($"Unhandled print exception: {ex.Message}");

            _logger.LogError(
                ex,
                "Print transaction failed with exception");
        }
    }
}
