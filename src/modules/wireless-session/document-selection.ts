export interface SelectableDocument {
  documentId: string;
  filename: string;
}

export interface DocumentSelector {
  documentId?: string | null;
  filename?: string | null;
}

/**
 * Resolves which uploaded document a request means.
 *
 * documentId is unique and always wins. filename is a legacy fallback that can
 * only ever match the first of several same-named uploads. A requested but
 * unknown id or name returns undefined; it never silently falls back to a
 * different document.
 */
export function selectRequestedDocument<T extends SelectableDocument>(
  docs: readonly T[],
  { documentId, filename }: DocumentSelector,
  fallback?: T,
): T | undefined {
  if (documentId) return docs.find((doc) => doc.documentId === documentId);
  if (filename) return docs.find((doc) => doc.filename === filename);
  return fallback ?? docs[0];
}
