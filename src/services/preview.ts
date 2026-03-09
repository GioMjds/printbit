import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import * as XLSX from "xlsx";
import { PREVIEW_CACHE_DIR } from "../config/http";

const execFileAsync = promisify(execFile);

export class PreviewService {
  private resolveLibreOfficePath(): string | null {
    const configured = process.env.PRINTBIT_LIBREOFFICE_PATH;
    if (configured && fs.existsSync(configured)) {
      return configured;
    }

    const candidates = [
      path.join(
        process.env.ProgramFiles ?? "",
        "LibreOffice",
        "program",
        "soffice.exe",
      ),
      path.join(
        process.env["ProgramFiles(x86)"] ?? "",
        "LibreOffice",
        "program",
        "soffice.exe",
      ),
      path.join(
        process.env.ProgramFiles ?? "",
        "LibreOffice",
        "program",
        "soffice.com",
      ),
      path.join(
        process.env["ProgramFiles(x86)"] ?? "",
        "LibreOffice",
        "program",
        "soffice.com",
      ),
    ];

    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }

    const lookup = spawnSync("where.exe", ["soffice"], {
      windowsHide: true,
      encoding: "utf8",
    });
    if (lookup.status === 0 && lookup.stdout) {
      const resolved = lookup.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && fs.existsSync(line));

      if (resolved) return resolved;
    }

    return null;
  }

  async convertToPdfPreview(sourcePath: string): Promise<string> {
    fs.mkdirSync(PREVIEW_CACHE_DIR, { recursive: true });

    const stats = await fs.promises.stat(sourcePath);
    const ext = path.extname(sourcePath).toLowerCase();
    const key = createHash("sha256")
      .update(`${sourcePath}|${stats.mtimeMs}`)
      .digest("hex");

    const cacheSource = path.join(PREVIEW_CACHE_DIR, `${key}${ext}`);
    const cachePdf = path.join(PREVIEW_CACHE_DIR, `${key}.pdf`);
    if (fs.existsSync(cachePdf)) return cachePdf;

    await fs.promises.copyFile(sourcePath, cacheSource);

    if ((ext === ".doc" || ext === ".docx") && process.platform === "win32") {
      try {
        await this.convertViaWordCom(
          path.resolve(cacheSource),
          path.resolve(cachePdf),
        );
        if (fs.existsSync(cachePdf)) return cachePdf;
      } catch {
        // Word not installed or COM failed - fall through to LibreOffice
      }
    }

    const sofficePath = this.resolveLibreOfficePath();
    if (!sofficePath) {
      throw new Error(
        "Preview conversion tool not found. Install Microsoft Word or LibreOffice, or set PRINTBIT_LIBREOFFICE_PATH.",
      );
    }

    try {
      await execFileAsync(
        sofficePath,
        [
          "--headless",
          "--nologo",
          "--nodefault",
          "--norestore",
          "--nolockcheck",
          "--convert-to",
          "pdf",
          "--outdir",
          PREVIEW_CACHE_DIR,
          cacheSource,
        ],
        { timeout: 60000 },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`LibreOffice conversion failed: ${message}`);
    }

    const convertedPdf = path.join(
      PREVIEW_CACHE_DIR,
      `${path.basename(cacheSource, ext)}.pdf`,
    );
    if (!fs.existsSync(convertedPdf)) {
      throw new Error("Document preview conversion failed.");
    }

    if (convertedPdf !== cachePdf) {
      await fs.promises.copyFile(convertedPdf, cachePdf);
    }

    return cachePdf;
  }

  private async convertViaWordCom(
    absSource: string,
    absOutput: string,
  ): Promise<void> {
    const esc = (p: string) => p.replace(/'/g, "''");

    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$word = New-Object -ComObject Word.Application",
      "$word.Visible = $false",
      "$word.DisplayAlerts = 0",
      "try {",
      `  $doc = $word.Documents.Open('${esc(absSource)}')`,
      `  $doc.SaveAs2('${esc(absOutput)}', 17)`,
      "  $doc.Close([ref]$false)",
      "} finally {",
      "  $word.Quit()",
      "  [void][System.Runtime.Interopservices.Marshal]::ReleaseComObject($word)",
      "}",
    ].join("\n");

    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 60_000 },
    );
  }

  private static readonly HTML_PREVIEW_EXTENSIONS = new Set([".xls", ".xlsx"]);

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

    if (ext === ".xlsx" || ext === ".xls") {
      const workbook = XLSX.readFile(sourcePath);
      const sections = workbook.SheetNames.map((name) => {
        const sheet = workbook.Sheets[name];
        const tableHtml = XLSX.utils.sheet_to_html(sheet, {
          id: `sheet-${name}`,
        });
        const label =
          workbook.SheetNames.length > 1
            ? `<div style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#555;margin-bottom:8px">${name}</div>`
            : "";
        return `<div style="height:100vh;overflow:hidden;padding:12px;box-sizing:border-box">${label}${tableHtml}</div>`;
      }).join("");
      return this.wrapPreviewHtml(sections);
    }

    throw new Error(`HTML preview not supported for ${ext}`);
  }
}

export const previewService = new PreviewService();
export const convertToPdfPreview = previewService.convertToPdfPreview.bind(previewService);
export const generateHtmlPreview = previewService.generateHtmlPreview.bind(previewService);
export const supportsHtmlPreview = previewService.supportsHtmlPreview.bind(previewService);