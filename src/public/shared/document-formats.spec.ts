import * as fs from 'fs';
import * as path from 'path';
import {
  SAVE_AS_PDF_HOWTO,
  WORD_CONVERTING_MESSAGE,
  WORD_CONVERTING_TIP,
  WORD_CONVERTING_TITLE,
  WORD_QUEUE_NOTE,
  acceptedFormatsSummary,
  classifyPreparationFailure,
  describePreparationFailure,
  fileInputAccept,
  isWordFile,
  pdfRecommendation,
} from './document-formats';

describe('isWordFile', () => {
  it('matches doc and docx only', () => {
    expect(isWordFile('Report.DOCX')).toBe(true);
    expect(isWordFile('old.doc')).toBe(true);
    expect(isWordFile('a.pdf')).toBe(false);
    expect(isWordFile('docx')).toBe(false);
    expect(isWordFile(undefined)).toBe(false);
  });
});

describe('accepted formats', () => {
  it('drops Word when conversion is off', () => {
    expect(acceptedFormatsSummary(false)).not.toMatch(/word/i);
    expect(fileInputAccept(false)).not.toMatch(/\.docx?/);
    expect(pdfRecommendation(false)).toMatch(/PDF and image files only/);
  });

  it('lists Word when conversion is on', () => {
    expect(acceptedFormatsSummary(true)).toMatch(/Word/);
    expect(fileInputAccept(true)).toContain('.docx');
  });
});

describe('classifyPreparationFailure', () => {
  it.each([
    ['LibreOffice document conversion timed out after 120 seconds.', 'timeout'],
    ['Document conversion timed out after 90s waiting for the worker.', 'timeout'],
    ['Document conversion service is offline (\\\\.\\pipe\\x): ENOENT', 'unavailable'],
    ["LibreOffice executable not found at configured path: 'C:\\x'.", 'unavailable'],
    ['Failed to start LibreOffice: access denied', 'unavailable'],
    ['LibreOffice conversion failed (exit code 1): source file could not be loaded', 'unreadable'],
    ['Document is encrypted', 'unreadable'],
    ['Something odd', 'unknown'],
    [null, 'unknown'],
  ])('%s -> %s', (raw, kind) => {
    expect(classifyPreparationFailure(raw)).toBe(kind);
  });
});

describe('describePreparationFailure', () => {
  it('tells Word customers to send a PDF', () => {
    const copy = describePreparationFailure('a.docx', 'timed out');
    expect(copy.isWord).toBe(true);
    expect(copy.phoneAction).toMatch(/PDF/);
    expect(copy.kioskAction).toMatch(/PDF/);
  });

  it('never leaks the raw worker error', () => {
    const raw = 'LibreOffice conversion failed (exit code 77): boom';
    const copy = describePreparationFailure('a.docx', raw);
    expect(Object.values(copy).join(' ')).not.toContain('exit code');
  });
});

describe('translations', () => {
  const load = (lang: string): Record<string, string> =>
    JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '../../locales', lang, 'translation.json'),
        'utf8',
      ),
    );

  it('has a Filipino entry for every customer-facing sentence', () => {
    const fil = load('fil');
    const en = load('en');
    const sentences = new Set<string>([
      acceptedFormatsSummary(true),
      acceptedFormatsSummary(false),
      pdfRecommendation(true),
      pdfRecommendation(false),
      SAVE_AS_PDF_HOWTO,
      WORD_QUEUE_NOTE,
      WORD_CONVERTING_TITLE,
      WORD_CONVERTING_MESSAGE,
      WORD_CONVERTING_TIP,
    ]);
    for (const name of ['a.docx', 'a.pdf']) {
      for (const raw of ['timed out', 'offline', 'exit code 1', 'x']) {
        const c = describePreparationFailure(name, raw);
        [c.title, c.reason, c.kioskAction, c.phoneAction].forEach((s) =>
          sentences.add(s),
        );
      }
    }
    const missing = [...sentences].filter((s) => !fil[s] || !en[s]);
    expect(missing).toEqual([]);
  });
});
