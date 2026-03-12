/**
 * Generates a minimal single-page test PDF using only built-in Node.js APIs.
 * No npm dependencies. Uses the standard Type1 Helvetica font (always available
 * in PDF readers and print drivers — no font embedding needed).
 *
 * The resulting PDF is suitable for printing via SumatraPDF to verify a printer
 * is correctly installed and producing output after setup or replacement.
 */

/**
 * Encodes a JavaScript string as a safe PDF literal string.
 * Escapes backslashes, open/close parentheses, and strips non-Latin1 chars.
 */
function pdfStr(text: string): string {
  let latin1only = "";

  for (const ch of text) {
    if (ch.charCodeAt(0) <= 0xff) latin1only += ch;
  }

  return latin1only;
}

/**
 * Builds a PDF xref entry — exactly 20 bytes per the PDF 1.4 spec.
 * Format: "nnnnnnnnnn ggggg x\r\n" (10 + 1 + 5 + 1 + 1 + \r + \n = 20 bytes).
 */
function xrefEntry(offset: number, gen: number, kind: 'n' | 'f'): string {
  return `${String(offset).padStart(10, '0')} ${String(gen).padStart(5, '0')} ${kind}\r\n`;
}

export function generateTestPagePdf(now: Date = new Date()): Buffer {
  const dateStr = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // ── Page content stream ─────────────────────────────────────────────────────
  // Uses Tm (absolute text matrix) for positioning — avoids Td accumulation.
  // All characters are ASCII so WinAnsiEncoding / Helvetica renders them safely.
  //
  // A4 page = 595 x 842 pt. Text starts near the top-left margin (50, 762).

  const S = (x: number, y: number, text: string): string =>
    `1 0 0 1 ${x} ${y} Tm\n(${pdfStr(text)}) Tj`;

  const streamLines = [
    'BT',

    // ── Title ──────────────────────────────────────────────────────────────
    '/F1 18 Tf',
    S(50, 762, 'PrintBit Kiosk - Printer Test Page'),

    // ── Metadata ───────────────────────────────────────────────────────────
    '/F1 10 Tf',
    S(50, 736, `Generated: ${dateStr}`),
    S(50, 722, 'This test was triggered from the PrintBit Admin Panel.'),
    S(50, 708, 'No user payment was charged.'),

    // ── Divider ────────────────────────────────────────────────────────────
    S(50, 686, '-'.repeat(62)),

    // ── Instruction ────────────────────────────────────────────────────────
    '/F1 11 Tf',
    S(
      50,
      668,
      'If this page printed clearly, the printer is working correctly.',
    ),
    S(50, 652, 'If it did not print, check:'),

    '/F1 10 Tf',
    S(68, 636, '- Printer power, USB/network cable, and driver installation'),
    S(68, 620, '- Default printer is set correctly in Windows Settings'),
    S(68, 604, '- No paper jam or paper-out condition'),
    S(68, 588, '- SumatraPDF is present at bin/SumatraPDF.exe'),

    // ── Checklist ──────────────────────────────────────────────────────────
    S(50, 564, '-'.repeat(62)),
    '/F1 11 Tf',
    S(50, 546, 'Print Quality Checklist (tick after visual inspection):'),

    '/F1 10 Tf',
    S(68, 530, '[ ]  Text is sharp and legible at normal reading distance'),
    S(68, 514, '[ ]  No horizontal banding, streaks, or smearing'),
    S(68, 498, '[ ]  Page margins are even on all four sides'),
    S(68, 482, '[ ]  Paper fed and ejected cleanly without jamming'),
    S(68, 466, '[ ]  No ghost images or double-printing artifacts'),

    S(50, 444, '-'.repeat(62)),

    // ── Footer ─────────────────────────────────────────────────────────────
    '/F1 9 Tf',
    S(50, 424, 'PrintBit Kiosk Management System'),
    S(50, 412, 'https://github.com/GioMjds/printbit'),

    'ET',
  ].join('\n');

  const streamBuf = Buffer.from(streamLines, 'latin1');
  const streamLength = streamBuf.length;

  // ── PDF object buffers ──────────────────────────────────────────────────────

  const o1 = Buffer.from(
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    'latin1',
  );

  const o2 = Buffer.from(
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    'latin1',
  );

  const o3 = Buffer.from(
    '3 0 obj\n' +
      '<< /Type /Page /Parent 2 0 R\n' +
      '   /MediaBox [0 0 595 842]\n' +
      '   /Contents 4 0 R\n' +
      '   /Resources << /Font << /F1 5 0 R >> >> >>\n' +
      'endobj\n',
    'latin1',
  );

  const o4 = Buffer.concat([
    Buffer.from(`4 0 obj\n<< /Length ${streamLength} >>\nstream\n`, 'latin1'),
    streamBuf,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);

  const o5 = Buffer.from(
    '5 0 obj\n' +
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica\n' +
      '   /Encoding /WinAnsiEncoding >>\n' +
      'endobj\n',
    'latin1',
  );

  // ── Assemble: header → objects → xref → trailer ────────────────────────────

  const header = Buffer.from('%PDF-1.4\n', 'latin1');

  const objects = [o1, o2, o3, o4, o5];
  const offsets: number[] = [];
  let bytePos = header.length;

  for (const obj of objects) {
    offsets.push(bytePos);
    bytePos += obj.length;
  }

  const xrefOffset = bytePos;

  // xref section: keyword line + subsection header + (1 free + N in-use) entries
  const xrefSection =
    'xref\n' +
    `0 ${objects.length + 1}\n` +
    xrefEntry(0, 65535, 'f') +
    offsets.map((o) => xrefEntry(o, 0, 'n')).join('');

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.concat([
    header,
    ...objects,
    Buffer.from(xrefSection, 'latin1'),
    Buffer.from(trailer, 'latin1'),
  ]);
}
