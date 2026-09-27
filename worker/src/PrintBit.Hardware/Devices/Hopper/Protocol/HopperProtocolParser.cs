using System.Diagnostics.CodeAnalysis;

namespace PrintBit.Hardware.Devices.Hopper.Protocol;

public static class HopperProtocolParser
{
    private const string LegacyRequestId = "legacy";
    private const string LegacyErrorCode = "ERROR";
    private const string LegacyErrorDetail = "Legacy hopper error";

    public static bool TryParse(string? rawLine, [NotNullWhen(true)] out HopperResponse? response)
    {
        response = null;
        if (string.IsNullOrWhiteSpace(rawLine))
        {
            return false;
        }

        var trimmed = rawLine.Trim();

        // Legacy fallback without prefix: "DONE" or "HOPPER:DONE"
        if (string.Equals(trimmed, "DONE", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(trimmed, "HOPPER:DONE", StringComparison.OrdinalIgnoreCase))
        {
            response = new HopperDoneResponse(LegacyRequestId, 0);
            return true;
        }

        var tokens = trimmed.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (tokens.Length == 0)
        {
            return false;
        }

        // Legacy fallback without prefix: "START <count>"
        if (string.Equals(tokens[0], "START", StringComparison.OrdinalIgnoreCase))
        {
            if (tokens.Length == 2 && int.TryParse(tokens[1], out var count) && count >= 0)
            {
                response = new HopperAckResponse(LegacyRequestId);
                return true;
            }

            return false;
        }

        // All other supported protocol lines begin with HOPPER (or HOPPER:)
        var prefix = tokens[0].TrimEnd(':');
        if (!string.Equals(prefix, "HOPPER", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (tokens.Length < 2)
        {
            return false;
        }

        var verb = tokens[1];

        // Legacy fallback: "HOPPER OK"
        if (string.Equals(verb, "OK", StringComparison.OrdinalIgnoreCase))
        {
            if (tokens.Length == 2)
            {
                response = new HopperDoneResponse(LegacyRequestId, 0);
                return true;
            }

            return false;
        }

        // Structured: "HOPPER ACK <requestId>"
        if (string.Equals(verb, "ACK", StringComparison.OrdinalIgnoreCase))
        {
            if (tokens.Length == 3)
            {
                response = new HopperAckResponse(tokens[2]);
                return true;
            }

            return false;
        }

        // Structured: "HOPPER PROGRESS <requestId> <dispensed> <total>"
        if (string.Equals(verb, "PROGRESS", StringComparison.OrdinalIgnoreCase))
        {
            if (tokens.Length == 5 &&
                int.TryParse(tokens[3], out var dispensed) && dispensed >= 0 &&
                int.TryParse(tokens[4], out var total) && total >= 0)
            {
                response = new HopperProgressResponse(tokens[2], dispensed, total);
                return true;
            }

            return false;
        }

        // "HOPPER DONE": Legacy fallback (length == 2) or structured (length == 3 or 4)
        if (string.Equals(verb, "DONE", StringComparison.OrdinalIgnoreCase))
        {
            if (tokens.Length == 2)
            {
                // Legacy: HOPPER DONE
                response = new HopperDoneResponse(LegacyRequestId, 0);
                return true;
            }

            if (tokens.Length == 3)
            {
                // Structured: HOPPER DONE <requestId> (defaults dispensedCount to 0)
                response = new HopperDoneResponse(tokens[2], 0);
                return true;
            }

            if (tokens.Length == 4)
            {
                // Structured: HOPPER DONE <requestId> <dispensedCount>
                if (int.TryParse(tokens[3], out var dispensedCount) && dispensedCount >= 0)
                {
                    response = new HopperDoneResponse(tokens[2], dispensedCount);
                    return true;
                }

                return false;
            }

            return false;
        }

        // "HOPPER ERR" or "HOPPER ERROR":
        // Legacy fallback (length == 2) or structured (length >= 3)
        if (string.Equals(verb, "ERR", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(verb, "ERROR", StringComparison.OrdinalIgnoreCase))
        {
            if (tokens.Length == 2)
            {
                // Legacy: HOPPER ERROR (without requestId) or HOPPER ERR
                response = new HopperErrorResponse(LegacyRequestId, LegacyErrorCode, LegacyErrorDetail);
                return true;
            }

            var requestId = tokens[2];
            var code = tokens.Length > 3 ? tokens[3].ToUpperInvariant() : "UNKNOWN";
            var detail = tokens.Length > 4
                ? string.Join(" ", tokens, 4, tokens.Length - 4)
                : code;

            response = new HopperErrorResponse(requestId, code, detail);
            return true;
        }

        return false;
    }
}
