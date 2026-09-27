using Microsoft.Extensions.Logging;
using PrintBit.Shared.Enums;

namespace PrintBit.Application.StateMachine;

public class TransactionStateMachine
{
    private const decimal ReadyThreshold = 5m;

    private readonly ILogger<TransactionStateMachine> _logger;

    public TransactionState CurrentState { get; private set; }
        = TransactionState.Idle;

    public decimal CurrentBalance { get; private set; } 

    public string? LastFailureReason { get; private set; }

    public TransactionStateMachine(
        ILogger<TransactionStateMachine> logger)
    {
        _logger = logger;
    }

    public bool TryInsertCoin(decimal amount)
    {
        if (amount <= 0)
        {
            return RejectTransition(
                action: "InsertCoin",
                reason: $"Coin amount must be positive. Amount={amount}");
        }

        if (CurrentState is not TransactionState.Idle and not TransactionState.Pending)
        {
            return RejectTransition(
                action: "InsertCoin",
                reason: $"Cannot accept coins in state {CurrentState}");
        }

        CurrentBalance += amount;

        LastFailureReason = null;

        CurrentState = TransactionState.Pending;

        _logger.LogInformation(
            "Coin inserted: {amount} | Balance: {balance}",
            amount,
            CurrentBalance);

        if (CurrentBalance >= ReadyThreshold)
        {
            CurrentState = TransactionState.ReadyToPrint;

            _logger.LogInformation(
                "Transaction ready to print | Balance: {balance}",
                CurrentBalance);
        }

        return true;
    }

    public bool TryStartPrinting()
    {
        if (CurrentState != TransactionState.ReadyToPrint)
        {
            return RejectTransition(
                action: "StartPrinting",
                reason: $"State must be {TransactionState.ReadyToPrint}");
        }

        LastFailureReason = null;

        CurrentState = TransactionState.Printing;

        _logger.LogInformation(
            "Printing started");

        return true;
    }

    public bool TryStartVerifying()
    {
        if (CurrentState != TransactionState.Printing)
        {
            return RejectTransition(
                action: "StartVerifying",
                reason: $"State must be {TransactionState.Printing}");
        }

        CurrentState = TransactionState.Verifying;

        _logger.LogInformation(
            "Print verification started");

        return true;
    }

    public bool TryMarkSuccess()
    {
        if (CurrentState != TransactionState.Verifying)
        {
            return RejectTransition(
                action: "MarkSuccess",
                reason: $"State must be {TransactionState.Verifying}");
        }

        LastFailureReason = null;

        CurrentState = TransactionState.Success;

        _logger.LogInformation(
            "Transaction succeeded");

        return true;
    }

    public bool TryMarkFailed(string reason)
    {
        if (CurrentState is TransactionState.Success or TransactionState.Failed)
        {
            return RejectTransition(
                action: "MarkFailed",
                reason: $"Terminal state reached: {CurrentState}");
        }

        LastFailureReason = reason;

        CurrentState = TransactionState.Failed;

        _logger.LogError(
            "Transaction failed: {reason}",
            reason);

        return true;
    }

    public void Reset()
    {
        CurrentBalance = 0;

        LastFailureReason = null;

        CurrentState = TransactionState.Idle;

        _logger.LogInformation(
            "Transaction reset");
    }

    private bool RejectTransition(
        string action,
        string reason)
    {
        _logger.LogWarning(
            "Rejected transition | Action={action} | State={state} | Reason={reason}",
            action,
            CurrentState,
            reason);

        return false;
    }
}
