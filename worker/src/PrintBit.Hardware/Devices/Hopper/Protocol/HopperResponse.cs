namespace PrintBit.Hardware.Devices.Hopper.Protocol;

public enum HopperResponseKind
{
    Ack,
    Progress,
    Done,
    Error
}

public abstract record HopperResponse(string RequestId)
{
    public abstract HopperResponseKind Kind { get; }
}

public sealed record HopperAckResponse(string RequestId) : HopperResponse(RequestId)
{
    public override HopperResponseKind Kind => HopperResponseKind.Ack;
}

public sealed record HopperProgressResponse(string RequestId, int Dispensed, int Total) : HopperResponse(RequestId)
{
    public override HopperResponseKind Kind => HopperResponseKind.Progress;
}

public sealed record HopperDoneResponse(string RequestId, int DispensedCount = 0) : HopperResponse(RequestId)
{
    public override HopperResponseKind Kind => HopperResponseKind.Done;
}

public sealed record HopperErrorResponse(string RequestId, string Code, string Detail) : HopperResponse(RequestId)
{
    public override HopperResponseKind Kind => HopperResponseKind.Error;
}
