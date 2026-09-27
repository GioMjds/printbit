using Microsoft.Extensions.Logging.Abstractions;
using PrintBit.Application.StateMachine;
using PrintBit.Shared.Enums;

namespace PrintBit.Tests;

public class TransactionStateMachineTests
{
    [Fact]
    public void ValidFlow_ReachesSuccess()
    {
        var sut = CreateSut();

        Assert.True(sut.TryInsertCoin(2));
        Assert.True(sut.TryInsertCoin(3));
        Assert.Equal(TransactionState.ReadyToPrint, sut.CurrentState);

        Assert.True(sut.TryStartPrinting());
        Assert.True(sut.TryStartVerifying());
        Assert.True(sut.TryMarkSuccess());

        Assert.Equal(TransactionState.Success, sut.CurrentState);
        Assert.Equal(5m, sut.CurrentBalance);
    }

    [Fact]
    public void InvalidTransition_IsRejected()
    {
        var sut = CreateSut();

        var accepted = sut.TryStartPrinting();

        Assert.False(accepted);
        Assert.Equal(TransactionState.Idle, sut.CurrentState);
    }

    [Fact]
    public void FailureState_HoldsUntilReset()
    {
        var sut = CreateSut();

        sut.TryInsertCoin(5);
        sut.TryStartPrinting();
        sut.TryMarkFailed("spooler verification failed");

        Assert.Equal(TransactionState.Failed, sut.CurrentState);
        Assert.False(sut.TryInsertCoin(1));

        sut.Reset();

        Assert.Equal(TransactionState.Idle, sut.CurrentState);
        Assert.Equal(0m, sut.CurrentBalance);
        Assert.Null(sut.LastFailureReason);
    }

    private static TransactionStateMachine CreateSut()
    {
        return new TransactionStateMachine(
            NullLogger<TransactionStateMachine>.Instance);
    }
}
