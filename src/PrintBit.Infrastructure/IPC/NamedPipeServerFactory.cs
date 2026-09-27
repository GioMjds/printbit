using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;

namespace PrintBit.Infrastructure.IPC;

public static class NamedPipeServerFactory
{
    public static NamedPipeServerStream CreateForCurrentUserAndAdministrators(
        string pipeName,
        PipeDirection direction,
        int maxNumberOfServerInstances = NamedPipeServerStream.MaxAllowedServerInstances,
        PipeTransmissionMode transmissionMode = PipeTransmissionMode.Byte,
        PipeOptions options = PipeOptions.Asynchronous)
    {
        if (!OperatingSystem.IsWindows())
        {
            return new NamedPipeServerStream(
                pipeName,
                direction,
                maxNumberOfServerInstances,
                transmissionMode,
                options);
        }

        var pipeSecurity = new PipeSecurity();
        using var currentIdentity = WindowsIdentity.GetCurrent();
        if (currentIdentity.User != null)
        {
            pipeSecurity.AddAccessRule(new PipeAccessRule(
                currentIdentity.User,
                PipeAccessRights.FullControl,
                AccessControlType.Allow));
        }

        pipeSecurity.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            PipeAccessRights.ReadWrite,
            AccessControlType.Allow));

        return NamedPipeServerStreamAcl.Create(
            pipeName,
            direction,
            maxNumberOfServerInstances,
            transmissionMode,
            options,
            inBufferSize: 0,
            outBufferSize: 0,
            pipeSecurity);
    }

    public static NamedPipeServerStream Create(
        string pipeName,
        PipeDirection direction,
        int maxNumberOfServerInstances = NamedPipeServerStream.MaxAllowedServerInstances,
        PipeTransmissionMode transmissionMode = PipeTransmissionMode.Byte,
        PipeOptions options = PipeOptions.Asynchronous)
    {
        if (OperatingSystem.IsWindows())
        {
            var pipeSecurity = new PipeSecurity();

            using var currentIdentity = WindowsIdentity.GetCurrent();
            if (currentIdentity.User != null)
            {
                pipeSecurity.AddAccessRule(new PipeAccessRule(
                    currentIdentity.User,
                    PipeAccessRights.FullControl,
                    AccessControlType.Allow));
            }

            pipeSecurity.AddAccessRule(new PipeAccessRule(
                new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
                PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance,
                AccessControlType.Allow));

            pipeSecurity.AddAccessRule(new PipeAccessRule(
                new SecurityIdentifier(WellKnownSidType.WorldSid, null),
                PipeAccessRights.ReadWrite,
                AccessControlType.Allow));

            return NamedPipeServerStreamAcl.Create(
                pipeName,
                direction,
                maxNumberOfServerInstances,
                transmissionMode,
                options,
                inBufferSize: 0,
                outBufferSize: 0,
                pipeSecurity);
        }

        return new NamedPipeServerStream(
            pipeName,
            direction,
            maxNumberOfServerInstances,
            transmissionMode,
            options);
    }
}
