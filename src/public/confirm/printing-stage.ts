export interface PrintingStageInput {
  pagesPrinted: number;
  totalPages: number | null;
}

export interface PrintingStage {
  label: string;
  progress: number | null;
}

export function getExpectedPrintPages(input: {
  selectedPages: number;
  copies: number;
}): number {
  const selectedPages = Number.isFinite(input.selectedPages)
    ? Math.max(1, Math.floor(input.selectedPages))
    : 1;
  const copies = Number.isFinite(input.copies)
    ? Math.max(1, Math.floor(input.copies))
    : 1;
  return selectedPages * copies;
}

export function getMonotonicPrintedPages(input: {
  displayedPages: number;
  incomingPages: number;
  totalPages: number | null;
}): number {
  const displayedPages = Number.isFinite(input.displayedPages)
    ? Math.max(0, Math.floor(input.displayedPages))
    : 0;
  const incomingPages = Number.isFinite(input.incomingPages)
    ? Math.max(0, Math.floor(input.incomingPages))
    : 0;
  const latestPages = Math.max(displayedPages, incomingPages);

  return input.totalPages && Number.isFinite(input.totalPages)
    ? Math.min(latestPages, Math.floor(input.totalPages))
    : latestPages;
}

export function getPrintingStage(input: PrintingStageInput): PrintingStage {
  if (!input.totalPages) {
    return { label: 'Preparing your print job…', progress: null };
  }

  if (input.pagesPrinted <= 0) {
    return { label: 'Preparing your print job…', progress: 0 };
  }

  const currentPage = Math.min(input.pagesPrinted, input.totalPages);
  return {
    label: `Printing page ${currentPage} of ${input.totalPages}`,
    progress: Math.round((currentPage / input.totalPages) * 100),
  };
}
