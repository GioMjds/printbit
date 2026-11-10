export interface DocumentQueryInput {
  filename?: string | null;
  documentId?: string | null;
  token?: string | null;
}

/**
 * Query for per-document session endpoints (preview, color-analysis).
 * documentId identifies the upload; filename is kept for older servers.
 */
export function buildDocumentQuery({
  filename,
  documentId,
  token,
}: DocumentQueryInput): URLSearchParams {
  const params = new URLSearchParams();
  if (filename) params.set('filename', filename);
  if (documentId) params.set('documentId', documentId);
  if (token) params.set('token', token);
  return params;
}
