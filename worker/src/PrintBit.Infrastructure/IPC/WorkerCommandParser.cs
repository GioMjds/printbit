using System;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Collections.Generic;
using System.Linq;
using PrintBit.Infrastructure.Services.PrintService;

namespace PrintBit.Infrastructure.IPC;

public static class WorkerCommandParser
{
    public const int DefaultMaxMessageBytes = 8192;

    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter(allowIntegerValues: false) }
    };

    /// <summary>
    /// Reads a single line from the given stream up to a maximum byte limit, stopping at '\n'.
    /// Returns the line (without '\r' or '\n') and whether the line exceeded the byte limit.
    /// </summary>
    public static async Task<(string? Line, bool Oversized)> ReadLineWithLimitAsync(
        Stream stream,
        int maxBytes,
        CancellationToken cancellationToken = default)
    {
        var limit = maxBytes > 0 ? maxBytes : DefaultMaxMessageBytes;
        using var ms = new MemoryStream();
        var buffer = new byte[1024];
        var totalBytes = 0;
        var oversized = false;
        var foundNewline = false;

        while (true)
        {
            var read = await stream.ReadAsync(buffer, 0, buffer.Length, cancellationToken);
            if (read == 0)
            {
                break;
            }

            var newlineIndex = -1;
            for (var i = 0; i < read; i++)
            {
                if (buffer[i] == (byte)'\n')
                {
                    newlineIndex = i;
                    break;
                }
            }

            if (newlineIndex >= 0)
            {
                foundNewline = true;
                totalBytes += newlineIndex;
                if (totalBytes > limit)
                {
                    oversized = true;
                }
                else
                {
                    ms.Write(buffer, 0, newlineIndex);
                }
                break;
            }
            else
            {
                totalBytes += read;
                if (totalBytes > limit)
                {
                    oversized = true;
                    break;
                }
                ms.Write(buffer, 0, read);
            }
        }

        if (oversized)
        {
            return (null, true);
        }

        if (ms.Length == 0 && totalBytes == 0 && !foundNewline)
        {
            return (null, false);
        }

        var line = Encoding.UTF8.GetString(ms.ToArray()).TrimEnd('\r');
        return (line, false);
    }

    /// <summary>
    /// Attempts to strictly parse a JSON line into a PrinterRecoveryCommand.
    /// Validates payload byte count, JSON formatting, RequestId presence, and command Type.
    /// Preserves any extracted RequestId even when validation fails.
    /// </summary>
    public static bool TryParse(
        string? line,
        int maxBytes,
        [NotNullWhen(true)] out PrinterRecoveryCommand? command,
        [NotNullWhen(false)] out string? errorDetail,
        out string requestId)
    {
        command = null;
        errorDetail = null;
        requestId = string.Empty;

        if (string.IsNullOrWhiteSpace(line))
        {
            errorDetail = "Payload is empty";
            return false;
        }

        var limit = maxBytes > 0 ? maxBytes : DefaultMaxMessageBytes;
        if (Encoding.UTF8.GetByteCount(line) > limit)
        {
            errorDetail = $"Payload exceeds maximum allowed size of {limit} bytes";
            return false;
        }

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(line);
        }
        catch (JsonException ex)
        {
            errorDetail = $"Malformed JSON: {ex.Message}";
            return false;
        }

        using (doc)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
            {
                errorDetail = "Payload must be a JSON object";
                return false;
            }

            if (TryGetPropertyCaseInsensitive(doc.RootElement, "requestId", out var reqElem) &&
                reqElem.ValueKind == JsonValueKind.String)
            {
                requestId = reqElem.GetString() ?? string.Empty;
            }

            if (!TryGetPropertyCaseInsensitive(doc.RootElement, "type", out var typeElem) ||
                typeElem.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(typeElem.GetString()))
            {
                errorDetail = "Command type is required";
                command = null;
                return false;
            }

            try
            {
                command = JsonSerializer.Deserialize<PrinterRecoveryCommand>(line, JsonOptions);
            }
            catch (Exception ex)
            {
                errorDetail = $"Invalid command payload: {ex.Message}";
                command = null;
                return false;
            }

            if (command is null)
            {
                errorDetail = "Command could not be deserialized";
                return false;
            }

            if (string.IsNullOrWhiteSpace(command.RequestId))
            {
                errorDetail = "RequestId is required";
                command = null;
                return false;
            }

            if (!Enum.IsDefined(typeof(PrinterRecoveryCommandType), command.Type))
            {
                errorDetail = $"Unknown command type: {command.Type}";
                command = null;
                return false;
            }

            requestId = command.RequestId;
            return true;
        }
    }

    public static bool TryParse(
        string? line,
        int maxBytes,
        [NotNullWhen(true)] out PrinterRecoveryCommand? command,
        [NotNullWhen(false)] out string? errorDetail)
    {
        return TryParse(line, maxBytes, out command, out errorDetail, out _);
    }

    public static bool IsHardwareCommandType(string? type)
    {
        if (string.IsNullOrWhiteSpace(type))
        {
            return false;
        }

        return string.Equals(type, "SimulateCoin", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(type, "DispenseCoins", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(type, "LockCoinSlot", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(type, "UnlockCoinSlot", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(type, "AnnounceKioskIp", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(type, "GetScannerStatus", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(type, "ProbeScanner", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(type, "StartScan", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(type, "CancelScan", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(type, "GetDefenderHealth", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(type, "ScanFileSecurity", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(type, "ListUsbDrives", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(type, "ExportScanToUsb", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(type, "GetTrustedTimeStatus", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(type, "PrepareHotspotPlatform", StringComparison.OrdinalIgnoreCase);
    }

    public static bool TryParseHardwareCommand(
        string? line,
        int maxBytes,
        [NotNullWhen(true)] out WorkerHardwareCommand? command,
        [NotNullWhen(false)] out string? errorDetail,
        out string requestId,
        out string? commandType)
    {
        command = null;
        errorDetail = null;
        requestId = string.Empty;
        commandType = null;

        if (string.IsNullOrWhiteSpace(line))
        {
            errorDetail = "Payload is empty";
            return false;
        }

        var limit = maxBytes > 0 ? maxBytes : DefaultMaxMessageBytes;
        if (Encoding.UTF8.GetByteCount(line) > limit)
        {
            errorDetail = $"Payload exceeds maximum allowed size of {limit} bytes";
            return false;
        }

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(line);
        }
        catch (JsonException ex)
        {
            errorDetail = $"Malformed JSON: {ex.Message}";
            return false;
        }

        using (doc)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
            {
                errorDetail = "Payload must be a JSON object";
                return false;
            }

            if (TryGetPropertyCaseInsensitive(doc.RootElement, "requestId", out var reqElem) &&
                reqElem.ValueKind == JsonValueKind.String)
            {
                requestId = reqElem.GetString() ?? string.Empty;
            }

            if (!TryGetPropertyCaseInsensitive(doc.RootElement, "type", out var typeElem) ||
                typeElem.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(typeElem.GetString()))
            {
                errorDetail = "Command type is required";
                return false;
            }

            commandType = typeElem.GetString();

            if (string.IsNullOrWhiteSpace(requestId))
            {
                errorDetail = "RequestId is required";
                return false;
            }

            if (string.Equals(commandType, "SimulateCoin", StringComparison.OrdinalIgnoreCase))
            {
                if (!TryGetPropertyCaseInsensitive(doc.RootElement, "coinValue", out var valueElem) ||
                    valueElem.ValueKind != JsonValueKind.Number ||
                    !valueElem.TryGetInt32(out var value) || value is not (1 or 5 or 10 or 20))
                {
                    errorDetail = "CoinValue must be 1, 5, 10, or 20";
                    return false;
                }
                command = new SimulateCoinCommand { RequestId = requestId, CoinValue = value };
                return true;
            }
            else if (string.Equals(commandType, "DispenseCoins", StringComparison.OrdinalIgnoreCase))
            {
                if (!TryGetPropertyCaseInsensitive(doc.RootElement, "coinCount", out var coinCountElem) ||
                    coinCountElem.ValueKind != JsonValueKind.Number ||
                    !coinCountElem.TryGetInt32(out var coinCount) ||
                    coinCount <= 0)
                {
                    errorDetail = "CoinCount is required and must be greater than 0";
                    return false;
                }

                int? timeoutMs = null;
                if (TryGetPropertyCaseInsensitive(doc.RootElement, "timeoutMs", out var timeoutElem) &&
                    timeoutElem.ValueKind == JsonValueKind.Number &&
                    timeoutElem.TryGetInt32(out var tMs) &&
                    tMs > 0)
                {
                    timeoutMs = tMs;
                }

                command = new DispenseCoinsCommand
                {
                    RequestId = requestId,
                    CoinCount = coinCount,
                    TimeoutMs = timeoutMs
                };
                return true;
            }
            else if (string.Equals(commandType, "LockCoinSlot", StringComparison.OrdinalIgnoreCase))
            {
                if (!TryGetPropertyCaseInsensitive(doc.RootElement, "ownerId", out var ownerElem) ||
                    ownerElem.ValueKind != JsonValueKind.String ||
                    string.IsNullOrWhiteSpace(ownerElem.GetString()))
                {
                    errorDetail = "OwnerId is required";
                    return false;
                }

                string? reason = null;
                if (TryGetPropertyCaseInsensitive(doc.RootElement, "reason", out var reasonElem) &&
                    reasonElem.ValueKind == JsonValueKind.String)
                {
                    reason = reasonElem.GetString();
                }

                command = new LockCoinSlotCommand
                {
                    RequestId = requestId,
                    OwnerId = ownerElem.GetString()!,
                    Reason = reason
                };
                return true;
            }
            else if (string.Equals(commandType, "UnlockCoinSlot", StringComparison.OrdinalIgnoreCase))
            {
                if (!TryGetPropertyCaseInsensitive(doc.RootElement, "ownerId", out var ownerElem) ||
                    ownerElem.ValueKind != JsonValueKind.String ||
                    string.IsNullOrWhiteSpace(ownerElem.GetString()))
                {
                    errorDetail = "OwnerId is required";
                    return false;
                }

                command = new UnlockCoinSlotCommand
                {
                    RequestId = requestId,
                    OwnerId = ownerElem.GetString()!
                };
                return true;
            }
            else if (string.Equals(commandType, "AnnounceKioskIp", StringComparison.OrdinalIgnoreCase))
            {
                if (!TryGetPropertyCaseInsensitive(doc.RootElement, "ip", out var ipElem) ||
                    ipElem.ValueKind != JsonValueKind.String ||
                    string.IsNullOrWhiteSpace(ipElem.GetString()))
                {
                    errorDetail = "Ip is required";
                    return false;
                }

                if (!TryGetPropertyCaseInsensitive(doc.RootElement, "port", out var portElem) ||
                    portElem.ValueKind != JsonValueKind.Number ||
                    !portElem.TryGetInt32(out var port) ||
                    port <= 0 || port > 65535)
                {
                    errorDetail = "Port is required and must be between 1 and 65535";
                    return false;
                }

                if (!TryGetPropertyCaseInsensitive(doc.RootElement, "path", out var pathElem) ||
                    pathElem.ValueKind != JsonValueKind.String ||
                    string.IsNullOrWhiteSpace(pathElem.GetString()))
                {
                    errorDetail = "Path is required";
                    return false;
                }

                command = new AnnounceKioskIpCommand
                {
                    RequestId = requestId,
                    Ip = ipElem.GetString()!,
                    Port = port,
                    Path = pathElem.GetString()!
                };
                return true;
            }
            else if (string.Equals(commandType, "GetScannerStatus", StringComparison.OrdinalIgnoreCase))
            {
                command = new GetScannerStatusCommand { RequestId = requestId };
                return true;
            }
            else if (string.Equals(commandType, "ProbeScanner", StringComparison.OrdinalIgnoreCase))
            {
                command = new ProbeScannerCommand { RequestId = requestId };
                return true;
            }
            else if (string.Equals(commandType, "StartScan", StringComparison.OrdinalIgnoreCase))
            {
                var source = "flatbed";
                if (TryGetPropertyCaseInsensitive(doc.RootElement, "source", out var srcElem) &&
                    srcElem.ValueKind == JsonValueKind.String)
                {
                    source = srcElem.GetString() ?? "flatbed";
                }

                var dpi = 300;
                if (TryGetPropertyCaseInsensitive(doc.RootElement, "dpi", out var dpiElem) &&
                    dpiElem.ValueKind == JsonValueKind.Number &&
                    dpiElem.TryGetInt32(out var parsedDpi))
                {
                    dpi = parsedDpi;
                }

                var colorMode = "colored";
                if (TryGetPropertyCaseInsensitive(doc.RootElement, "colorMode", out var colorElem) &&
                    colorElem.ValueKind == JsonValueKind.String)
                {
                    colorMode = colorElem.GetString() ?? "colored";
                }

                var format = "pdf";
                if (TryGetPropertyCaseInsensitive(doc.RootElement, "format", out var fmtElem) &&
                    fmtElem.ValueKind == JsonValueKind.String)
                {
                    format = fmtElem.GetString() ?? "pdf";
                }

                string? paperSize = null;
                if (TryGetPropertyCaseInsensitive(doc.RootElement, "paperSize", out var paperElem) &&
                    paperElem.ValueKind == JsonValueKind.String)
                {
                    paperSize = paperElem.GetString();
                }

                string? outputDir = null;
                if (TryGetPropertyCaseInsensitive(doc.RootElement, "outputDir", out var outElem) &&
                    outElem.ValueKind == JsonValueKind.String)
                {
                    outputDir = outElem.GetString();
                }

                command = new StartScanCommand
                {
                    RequestId = requestId,
                    Source = source,
                    Dpi = dpi,
                    ColorMode = colorMode,
                    Format = format,
                    PaperSize = paperSize,
                    OutputDir = outputDir
                };
                return true;
            }
            else if (string.Equals(commandType, "CancelScan", StringComparison.OrdinalIgnoreCase))
            {
                var targetId = string.Empty;
                if (TryGetPropertyCaseInsensitive(doc.RootElement, "targetRequestId", out var targetElem) &&
                    targetElem.ValueKind == JsonValueKind.String)
                {
                    targetId = targetElem.GetString() ?? string.Empty;
                }

                command = new CancelScanCommand
                {
                    RequestId = requestId,
                    TargetRequestId = targetId
                };
                return true;
            }
            else if (string.Equals(commandType, "GetDefenderHealth", StringComparison.OrdinalIgnoreCase))
            {
                command = new GetDefenderHealthCommand { RequestId = requestId };
                return true;
            }
            else if (string.Equals(commandType, "ScanFileSecurity", StringComparison.OrdinalIgnoreCase))
            {
                if (!TryGetPropertyCaseInsensitive(doc.RootElement, "filePath", out var fileElem) ||
                    fileElem.ValueKind != JsonValueKind.String ||
                    string.IsNullOrWhiteSpace(fileElem.GetString()))
                {
                    errorDetail = "FilePath is required";
                    return false;
                }

                var filePath = fileElem.GetString()!;
                if (!Path.IsPathFullyQualified(filePath))
                {
                    errorDetail = "FilePath must be an absolute path";
                    return false;
                }

                command = new ScanFileSecurityCommand
                {
                    RequestId = requestId,
                    FilePath = filePath
                };
                return true;
            }
            else if (string.Equals(commandType, "ListUsbDrives", StringComparison.OrdinalIgnoreCase))
            {
                command = new ListUsbDrivesCommand { RequestId = requestId };
                return true;
            }
            else if (string.Equals(commandType, "ExportScanToUsb", StringComparison.OrdinalIgnoreCase))
            {
                if (!TryGetPropertyCaseInsensitive(doc.RootElement, "sourcePath", out var srcElem) ||
                    srcElem.ValueKind != JsonValueKind.String ||
                    string.IsNullOrWhiteSpace(srcElem.GetString()))
                {
                    errorDetail = "SourcePath is required";
                    return false;
                }

                var sourcePath = srcElem.GetString()!;
                if (!Path.IsPathFullyQualified(sourcePath))
                {
                    errorDetail = "SourcePath must be an absolute path";
                    return false;
                }

                if (!TryGetPropertyCaseInsensitive(doc.RootElement, "drive", out var driveElem) ||
                    driveElem.ValueKind != JsonValueKind.String ||
                    string.IsNullOrWhiteSpace(driveElem.GetString()))
                {
                    errorDetail = "Drive is required";
                    return false;
                }

                var drive = driveElem.GetString()!;
                if (!System.Text.RegularExpressions.Regex.IsMatch(drive, "^[A-Za-z]:$"))
                {
                    errorDetail = "Drive must match format 'X:'";
                    return false;
                }

                command = new ExportScanToUsbCommand
                {
                    RequestId = requestId,
                    SourcePath = sourcePath,
                    Drive = drive
                };
                return true;
            }
            else if (string.Equals(commandType, "GetTrustedTimeStatus", StringComparison.OrdinalIgnoreCase))
            {
                string? ntpServer = null;
                if (TryGetPropertyCaseInsensitive(doc.RootElement, "ntpServer", out var ntpElem) &&
                    ntpElem.ValueKind == JsonValueKind.String &&
                    !string.IsNullOrWhiteSpace(ntpElem.GetString()))
                {
                    ntpServer = ntpElem.GetString()!;
                    if (!System.Text.RegularExpressions.Regex.IsMatch(ntpServer, "^[A-Za-z0-9._:-]+$"))
                    {
                        errorDetail = "NtpServer contains invalid characters";
                        return false;
                    }
                }

                var maxDriftMs = 60_000;
                if (TryGetPropertyCaseInsensitive(doc.RootElement, "maxDriftMs", out var driftElem) &&
                    driftElem.ValueKind == JsonValueKind.Number)
                {
                    if (!driftElem.TryGetInt32(out var parsedDrift) || parsedDrift < 0)
                    {
                        errorDetail = "MaxDriftMs must be a non-negative integer";
                        return false;
                    }
                    maxDriftMs = parsedDrift;
                }

                command = new GetTrustedTimeStatusCommand
                {
                    RequestId = requestId,
                    NtpServer = ntpServer,
                    MaxDriftMs = maxDriftMs
                };
                return true;
            }
            else if (string.Equals(commandType, "PrepareHotspotPlatform", StringComparison.OrdinalIgnoreCase))
            {
                if (!TryGetPropertyCaseInsensitive(doc.RootElement, "port", out var portElem) ||
                    portElem.ValueKind != JsonValueKind.Number ||
                    !portElem.TryGetInt32(out var port) ||
                    port is <= 0 or > 65535)
                {
                    errorDetail = "Port is required and must be between 1 and 65535";
                    return false;
                }

                var prefixes = new List<string>();
                if (TryGetPropertyCaseInsensitive(doc.RootElement, "preferredSubnetPrefixes", out var prefixElem) &&
                    prefixElem.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in prefixElem.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(item.GetString()))
                        {
                            errorDetail = "PreferredSubnetPrefixes must contain non-empty strings";
                            return false;
                        }
                        var p = item.GetString()!;
                        if (!System.Text.RegularExpressions.Regex.IsMatch(p, @"^(?:\d{1,3}\.){1,3}$"))
                        {
                            errorDetail = $"PreferredSubnetPrefix '{p}' has invalid format";
                            return false;
                        }
                        prefixes.Add(p);
                    }
                }

                command = new PrepareHotspotPlatformCommand
                {
                    RequestId = requestId,
                    PreferredSubnetPrefixes = prefixes,
                    Port = port
                };
                return true;
            }
            else
            {
                errorDetail = $"Unknown command type: {commandType}";
                return false;
            }
        }
    }

    public static bool TryParseHardwareCommand(
        string? line,
        int maxBytes,
        [NotNullWhen(true)] out WorkerHardwareCommand? command,
        [NotNullWhen(false)] out string? errorDetail,
        out string requestId)
    {
        return TryParseHardwareCommand(line, maxBytes, out command, out errorDetail, out requestId, out _);
    }

    public static bool TryParseHardwareCommand(
        string? line,
        int maxBytes,
        [NotNullWhen(true)] out WorkerHardwareCommand? command,
        [NotNullWhen(false)] out string? errorDetail)
    {
        return TryParseHardwareCommand(line, maxBytes, out command, out errorDetail, out _, out _);
    }

    private static bool TryGetPropertyCaseInsensitive(JsonElement element, string propertyName, out JsonElement value)
    {
        foreach (var prop in element.EnumerateObject())
        {
            if (string.Equals(prop.Name, propertyName, StringComparison.OrdinalIgnoreCase))
            {
                value = prop.Value;
                return true;
            }
        }
        value = default;
        return false;
    }
}
