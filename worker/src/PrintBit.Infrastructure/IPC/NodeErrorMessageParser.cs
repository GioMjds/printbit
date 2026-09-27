using System.Text;
using System.Text.Json;

namespace PrintBit.Infrastructure.IPC;

public static class NodeErrorMessageParser
{
    public const int DefaultMaxMessageBytes = 8192;

    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    public static bool TryParse(
        string line,
        int maxMessageBytes,
        out NodeErrorMessage? message,
        out string? errorCode)
    {
        message = null;
        errorCode = null;

        if (string.IsNullOrWhiteSpace(line))
        {
            errorCode = "EmptyPayload";
            return false;
        }

        var limit = maxMessageBytes > 0
            ? maxMessageBytes
            : DefaultMaxMessageBytes;

        if (Encoding.UTF8.GetByteCount(line) > limit)
        {
            errorCode = "PayloadTooLarge";
            return false;
        }

        try
        {
            message = JsonSerializer.Deserialize<NodeErrorMessage>(line, Options);
        }
        catch (JsonException)
        {
            errorCode = "InvalidJson";
            return false;
        }

        if (message is null || string.IsNullOrWhiteSpace(message.Message))
        {
            message = null;
            errorCode = "MissingMessage";
            return false;
        }

        return true;
    }
}
