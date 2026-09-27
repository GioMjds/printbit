using System;
using System.Collections.Generic;
using System.Text;

namespace PrintBit.Infrastructure.Services.PrintService
{
    public interface IPrintService
    {
        Task<PrintJobResult> PrintAsync(
            PrintJobRequest request,
            CancellationToken cancellationToken = default);
    }
}
