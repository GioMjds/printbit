using System;
using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;

namespace PrintBit.Infrastructure.IPC;

public static class WorkerCommandPipeSecurity
{
    /// <summary>
    /// Creates a secure PipeSecurity configuration for the admin recovery command pipe.
    /// Grants FullControl to LocalSystem and the current service identity, and ReadWrite to BUILTIN\Administrators.
    /// Excludes WorldSid (Everyone) and AuthenticatedUserSid.
    /// </summary>
    [SupportedOSPlatform("windows")]
    public static PipeSecurity CreatePipeSecurity(string? allowedClientIdentity = null)
    {
        var pipeSecurity = new PipeSecurity();
        var grantedSids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        using var currentIdentity = WindowsIdentity.GetCurrent();
        if (currentIdentity.User != null)
        {
            AddAccessRuleIfMissing(
                pipeSecurity,
                grantedSids,
                currentIdentity.User,
                PipeAccessRights.FullControl,
                AccessControlType.Allow);
        }

        AddAccessRuleIfMissing(
            pipeSecurity,
            grantedSids,
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow);

        AddAccessRuleIfMissing(
            pipeSecurity,
            grantedSids,
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            PipeAccessRights.ReadWrite,
            AccessControlType.Allow);

        if (!string.IsNullOrWhiteSpace(allowedClientIdentity))
        {
            var clientSid = ResolveIdentity(allowedClientIdentity.Trim());
            if (clientSid.IsWellKnown(WellKnownSidType.WorldSid) ||
                clientSid.IsWellKnown(WellKnownSidType.AuthenticatedUserSid))
            {
                throw new ArgumentException(
                    "Worker command pipe client identity must not grant a broad Windows principal.",
                    nameof(allowedClientIdentity));
            }

            AddAccessRuleIfMissing(
                pipeSecurity,
                grantedSids,
                clientSid,
                PipeAccessRights.ReadWrite,
                AccessControlType.Allow);
        }

        return pipeSecurity;
    }

    [SupportedOSPlatform("windows")]
    private static SecurityIdentifier ResolveIdentity(string identity)
    {
        if (identity.StartsWith("S-", StringComparison.OrdinalIgnoreCase))
        {
            return new SecurityIdentifier(identity);
        }

        return (SecurityIdentifier)new NTAccount(identity)
            .Translate(typeof(SecurityIdentifier));
    }

    [SupportedOSPlatform("windows")]
    private static void AddAccessRuleIfMissing(
        PipeSecurity pipeSecurity,
        ISet<string> grantedSids,
        SecurityIdentifier sid,
        PipeAccessRights rights,
        AccessControlType accessControlType)
    {
        if (!grantedSids.Add(sid.Value))
        {
            return;
        }

        pipeSecurity.AddAccessRule(new PipeAccessRule(sid, rights, accessControlType));
    }

    /// <summary>
    /// Creates a NamedPipeServerStream configured with secure ACL on Windows,
    /// enforcing admin-only and LocalSystem access for the command pipe.
    /// </summary>
    public static NamedPipeServerStream CreateServerStream(
        string pipeName,
        int maxNumberOfServerInstances = 1,
        PipeTransmissionMode transmissionMode = PipeTransmissionMode.Byte,
        PipeOptions options = PipeOptions.Asynchronous,
        string? allowedClientIdentity = null)
    {
        if (OperatingSystem.IsWindows())
        {
            var pipeSecurity = CreatePipeSecurity(allowedClientIdentity);
            return NamedPipeServerStreamAcl.Create(
                pipeName,
                PipeDirection.InOut,
                maxNumberOfServerInstances,
                transmissionMode,
                options,
                inBufferSize: 0,
                outBufferSize: 0,
                pipeSecurity);
        }

        return new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            maxNumberOfServerInstances,
            transmissionMode,
            options);
    }
}
