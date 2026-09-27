namespace PrintBit.Shared.Printing
{
    public sealed class PrintJobResult
    {
        public bool Success { get; init; }
        public bool TimedOut { get; init; }
        public bool PrinterOffline { get; init; }
        public bool SpoolerFailure { get; init; }
        public string? ErrorMessage { get; init; }
        public TimeSpan Duration { get; init; }
        public static PrintJobResult Ok(TimeSpan duration) => new()
        {
            Success = true,
            Duration = duration,
        };
        public static PrintJobResult Fail(
            string message,
            bool timeout = false,
            bool printerOffline = false,
            bool spoolerFailure = false
        )
        {
            return new PrintJobResult
            {
                Success = false,
                TimedOut = timeout,
                PrinterOffline = printerOffline,
                SpoolerFailure = spoolerFailure,
                ErrorMessage = message,
            };
        }
    }
}
