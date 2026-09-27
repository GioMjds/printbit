using Microsoft.Extensions.Logging;
using PrintBit.Application.Events;
using PrintBit.Application.StateMachine;

namespace PrintBit.Application.Handlers;

public class CoinInsertedHandler
{
    private readonly ILogger<CoinInsertedHandler> _logger;

    private readonly TransactionStateMachine _stateMachine;

    public CoinInsertedHandler(
        ILogger<CoinInsertedHandler> logger,
        TransactionStateMachine stateMachine)
    {
        _logger = logger;
        _stateMachine = stateMachine;
    }

    public void Handle(CoinInsertedEvent evt)
    {
        _logger.LogInformation(
            "Handling coin inserted event: {amount}",
            evt.Amount);

        _stateMachine.TryInsertCoin(evt.Amount);
    }
}
