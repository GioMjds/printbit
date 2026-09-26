import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PREVIEW_CACHE_DIR } from '@/config/http.config';
import { convertDocumentViaWorker } from '@/services/document-conversion-pipe';

export class PreviewService {
  private readonly inFlightConversions = new Map<string, Promise<string>>();

  /** Creates a session-owned PDF artifact instead of an evictable preview. */
  async convertToPdfArtifact(
    sourcePath: string,
    artifactPath: string,
  ): Promise<string> {
    const resolvedArtifactPath = path.resolve(artifactPath);
    if (path.extname(resolvedArtifactPath).toLowerCase() !== '.pdf') {
      throw new Error('Document conversion artifact must be a PDF file.');
    }
    if (path.resolve(sourcePath) === resolvedArtifactPath) {
      throw new Error('Document conversion artifact must not replace its source file.');
    }
    if (fs.existsSync(resolvedArtifactPath)) return resolvedArtifactPath;

    const existing = this.inFlightConversions.get(resolvedArtifactPath);
    if (existing) return existing;

    const conversion = this.convertToPdfArtifactUncached(
      sourcePath,
      resolvedArtifactPath,
    );
    this.inFlightConversions.set(resolvedArtifactPath, conversion);
    try {
      return await conversion;
    } finally {
      this.inFlightConversions.delete(resolvedArtifactPath);
    }
  }

  async convertToPdfPreview(sourcePath: string): Promise<string> {
    const resolvedPath = path.resolve(sourcePath);
    if (path.extname(resolvedPath).toLowerCase() === '.pdf') {
      return resolvedPath;
    }

    fs.mkdirSync(PREVIEW_CACHE_DIR, { recursive: true });

    const stats = await fs.promises.stat(sourcePath);
    const key = createHash('sha256')
      .update(`${sourcePath}|${stats.mtimeMs}`)
      .digest('hex');
    const cachePdf = path.join(PREVIEW_CACHE_DIR, `${key}.pdf`);

    if (fs.existsSync(cachePdf)) return cachePdf;

    const existing = this.inFlightConversions.get(cachePdf);
    if (existing) return existing;

    const conversion = this.convertToPdfPreviewUncached(sourcePath, cachePdf);
    this.inFlightConversions.set(cachePdf, conversion);

    try {
      return await conversion;
    } finally {
      this.inFlightConversions.delete(cachePdf);
    }
  }

  private async convertToPdfPreviewUncached(
    sourcePath: string,
    cachePdf: string,
  ): Promise<string> {
    const result = await convertDocumentViaWorker(sourcePath, {
      outputDirectory: PREVIEW_CACHE_DIR,
    });

    if (!result.success || !result.outputPath) {
      throw new Error(
        result.errorMessage ?? 'Document preview conversion failed.',
      );
    }

    if (result.outputPath !== cachePdf) {
      try {
        await fs.promises.rename(result.outputPath, cachePdf);
      } catch {
        // Cross-volume rename can fail (EXDEV); fall back to copy+delete.
        await fs.promises.copyFile(result.outputPath, cachePdf);
        await fs.promises.unlink(result.outputPath).catch(() => {});
      }
    }

    return cachePdf;
  }

  private async convertToPdfArtifactUncached(
    sourcePath: string,
    artifactPath: string,
  ): Promise<string> {
    const outputDirectory = path.dirname(artifactPath);
    await fs.promises.mkdir(outputDirectory, { recursive: true });
    const result = await convertDocumentViaWorker(sourcePath, { outputDirectory });
    if (!result.success || !result.outputPath) {
      throw new Error(result.errorMessage ?? 'Document conversion failed.');
    }

    const reportedOutputPath = path.resolve(result.outputPath);
    const resolvedOutputDirectory = path.resolve(outputDirectory);
    const relativeOutputPath = path.relative(
      resolvedOutputDirectory,
      reportedOutputPath,
    );
    if (
      relativeOutputPath === '..' ||
      relativeOutputPath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeOutputPath)
    ) {
      throw new Error('Document conversion worker returned an invalid output path.');
    }

    if (reportedOutputPath !== artifactPath) {
      try {
        await fs.promises.rename(reportedOutputPath, artifactPath);
      } catch {
        await fs.promises.copyFile(reportedOutputPath, artifactPath);
        await fs.promises.unlink(reportedOutputPath).catch(() => {});
      }
    }
    return artifactPath;
  }

  private static readonly HTML_PREVIEW_EXTENSIONS = new Set(['.xls', '.xlsx']);

  supportsHtmlPreview(ext: string): boolean {
    return PreviewService.HTML_PREVIEW_EXTENSIONS.has(ext.toLowerCase());
  }

  private wrapPreviewHtml(body: string): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{height:100%;overflow:auto;scrollbar-width:none}
    html::-webkit-scrollbar,body::-webkit-scrollbar{display:none}
    body{font-family:sans-serif;font-size:13px;line-height:1.5;padding:16px;color:#111;background:#fff}
    table{border-collapse:collapse;width:100%;font-size:12px}
    td,th{border:1px solid #d0d0d0;padding:4px 8px;white-space:pre-wrap;word-break:break-word}
    th{background:#f5f5f5;font-weight:600}
    h1,h2,h3,h4{margin:8px 0 4px}
    p{margin-bottom:6px}
  </style></head><body>${body}</body></html>`;
  }

  async generateHtmlPreview(sourcePath: string): Promise<string> {
    const ext = path.extname(sourcePath).toLowerCase();

    if (ext === '.xlsx' || ext === '.xls') {
      const XLSX = await import('xlsx');
      const workbook = XLSX.readFile(sourcePath);
      if (workbook.SheetNames.length === 0) {
        return this.wrapPreviewHtml(
          '<div style="padding:20px;color:#555">Spreadsheet has no visible sheets.</div>',
        );
      }

      const sections = workbook.SheetNames.map((name) => {
        const sheet = workbook.Sheets[name];
        const ref = sheet?.['!ref'];
        const tableHtml =
          sheet && typeof ref === 'string'
            ? XLSX.utils.sheet_to_html(sheet, {
                id: `sheet-${name}`,
              })
            : '<div style="font-size:12px;color:#666;border:1px dashed #ccc;padding:10px">This sheet is empty.</div>';
        const label =
          workbook.SheetNames.length > 1
            ? `<div style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#555;margin-bottom:8px">${name}</div>`
            : '';
        return `<div style="height:100vh;overflow:hidden;padding:12px;box-sizing:border-box">${label}${tableHtml}</div>`;
      }).join('');
      return this.wrapPreviewHtml(sections);
    }

    throw new Error(`HTML preview not supported for ${ext}`);
  }
}

export const previewService = new PreviewService();
export const convertToPdfPreview =
  previewService.convertToPdfPreview.bind(previewService);
export const convertToPdfArtifact =
  previewService.convertToPdfArtifact.bind(previewService);
export const generateHtmlPreview =
  previewService.generateHtmlPreview.bind(previewService);
export const supportsHtmlPreview =
  previewService.supportsHtmlPreview.bind(previewService);
