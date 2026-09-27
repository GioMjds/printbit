namespace PrintBit.Infrastructure.Services.DocumentConversion;

/// <summary>
/// Service interface for converting non-PDF document formats into standard PDF documents.
/// </summary>
public interface IDocumentConversionService
{
    /// <summary>
    /// Converts a document or image to PDF asynchronously.
    /// </summary>
    /// <param name="request">The conversion request parameters.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A conversion result indicating success or failure with output details.</returns>
    Task<DocumentConversionResult> ConvertAsync(
        DocumentConversionRequest request,
        CancellationToken cancellationToken = default);
}
