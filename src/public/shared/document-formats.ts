// Customer-facing copy about accepted file formats and failed Word-to-PDF
// conversions, shared by the kiosk /print page and the phone /upload page.
//
// kiosk-i18n translates by exact sentence match, so every string here is a
// fixed sentence with no filename or number inside it. When you add or change
// one, add the same key to src/locales/en and src/locales/fil translation.json.

export function isWordFile(filename?: string | null): boolean {
  const ext = /\.([^.]+)$/.exec(filename?.trim() ?? '')?.[1]?.toLowerCase();
  return ext === 'doc' || ext === 'docx';
}

export function acceptedFormatsSummary(wordEnabled: boolean): string {
  return wordEnabled
    ? 'PDF, Word, JPG, PNG, GIF, WebP, and BMP files · up to 25 MB each'
    : 'PDF, JPG, PNG, GIF, WebP, and BMP files · up to 25 MB each';
}

export function fileInputAccept(wordEnabled: boolean): string {
  return wordEnabled
    ? '.pdf,.doc,.docx,.jpeg,.jpg,.png,.gif,.webp,.bmp,image/jpeg,image/png,image/gif,image/webp,image/bmp'
    : '.pdf,.jpeg,.jpg,.png,.gif,.webp,.bmp,image/jpeg,image/png,image/gif,image/webp,image/bmp';
}

/** The "send a PDF" reminder, worded for whether Word uploads are on. */
export function pdfRecommendation(wordEnabled: boolean): string {
  return wordEnabled
    ? 'Send a PDF for the fastest printing. Word files are converted to PDF at the kiosk, which takes longer and can fail.'
    : 'This kiosk accepts PDF and image files only. Save Word files as PDF before sending.';
}

export const SAVE_AS_PDF_HOWTO =
  'To save as PDF: in Word, tap File, then Save As, then PDF. In Google Docs, tap Share & export, then Save as, then PDF.';

export const WORD_QUEUE_NOTE = 'Converts to PDF at the kiosk · may take a minute';
export const WORD_CONVERTING_TITLE = 'Converting your Word file to PDF…';
export const WORD_CONVERTING_MESSAGE = 'This can take up to a minute.';
export const WORD_CONVERTING_TIP = 'Tip: send a PDF next time to skip this step.';

export type PreparationFailureKind =
  | 'timeout'
  | 'unavailable'
  | 'unreadable'
  | 'unknown';

/** Buckets the raw server/worker error so customers get a reason, not a log line. */
export function classifyPreparationFailure(
  rawError?: string | null,
): PreparationFailureKind {
  const text = rawError?.toLowerCase() ?? '';
  if (/timed out|timeout|taking longer/.test(text)) return 'timeout';
  if (
    /offline|unavailable|not responding|failed to start|not found at configured path|closed the connection|unreadable response|failed to send conversion/.test(
      text,
    )
  ) {
    return 'unavailable';
  }
  if (
    /exit code|corrupt|damaged|password|encrypt|invalid|not a valid|malformed|could not be opened|verif/.test(
      text,
    )
  ) {
    return 'unreadable';
  }
  return 'unknown';
}

export interface PreparationFailureCopy {
  kind: PreparationFailureKind;
  isWord: boolean;
  title: string;
  /** Why it failed, in customer terms. */
  reason: string;
  /** What to do next on the kiosk screen. */
  kioskAction: string;
  /** What to do next on the phone. */
  phoneAction: string;
}

const WORD_PHONE_ACTION =
  'Save the file as PDF on your phone, then send the PDF. PDFs print right away.';

export function describePreparationFailure(
  filename: string | null | undefined,
  rawError?: string | null,
): PreparationFailureCopy {
  const kind = classifyPreparationFailure(rawError);
  const isWord = isWordFile(filename);

  if (isWord) {
    switch (kind) {
      case 'timeout':
        return {
          kind,
          isWord,
          title: 'Your Word file took too long to convert',
          reason:
            'Large Word files, or files with many pictures or special fonts, can take too long to turn into PDF.',
          kioskAction:
            'Tap Continue to try again, or send a PDF version from your phone instead.',
          phoneAction: WORD_PHONE_ACTION,
        };
      case 'unavailable':
        return {
          kind,
          isWord,
          title: 'Word files cannot be converted right now',
          reason: 'The kiosk document converter is not responding.',
          kioskAction:
            'Send a PDF version from your phone instead. PDFs do not need converting.',
          phoneAction: WORD_PHONE_ACTION,
        };
      case 'unreadable':
        return {
          kind,
          isWord,
          title: 'Your Word file could not be opened',
          reason:
            'It may be damaged, password-protected, or use features the kiosk cannot read.',
          kioskAction:
            'Remove this file, then send a PDF version from your phone.',
          phoneAction: WORD_PHONE_ACTION,
        };
      default:
        return {
          kind,
          isWord,
          title: 'Your Word file could not be converted',
          reason: 'Something went wrong while turning it into PDF.',
          kioskAction:
            'Tap Continue to try again, or send a PDF version from your phone instead.',
          phoneAction: WORD_PHONE_ACTION,
        };
    }
  }

  switch (kind) {
    case 'timeout':
      return {
        kind,
        isWord,
        title: 'Your file took too long to prepare',
        reason: 'The file may be very large, or the kiosk is busy.',
        kioskAction: 'Tap Continue to try again, or send a smaller file.',
        phoneAction: 'Send the file again, or try a smaller file.',
      };
    case 'unreadable':
      return {
        kind,
        isWord,
        title: 'Your file could not be opened',
        reason: 'It may be damaged or password-protected.',
        kioskAction:
          'Remove this file, then send another copy from your phone.',
        phoneAction:
          'Send another copy of the file, without a password.',
      };
    default:
      return {
        kind,
        isWord,
        title: 'Your file could not be prepared',
        reason: 'Something went wrong while checking its pages.',
        kioskAction:
          'Tap Continue to try again. If it fails again, send the file again from your phone.',
        phoneAction: 'Send the file again, or try a different copy.',
      };
  }
}

/**
 * Renders sentences as sibling spans so each one is a separate text node the
 * kiosk translator can match on its own. An optional heading sits on its own line.
 */
export function renderSentences(
  el: HTMLElement,
  sentences: string[],
  heading?: string,
): void {
  const nodes: Node[] = [];
  if (heading) {
    const strong = document.createElement('strong');
    strong.style.display = 'block';
    strong.textContent = heading;
    nodes.push(strong);
  }
  sentences.filter(Boolean).forEach((sentence, i) => {
    if (i > 0) nodes.push(document.createTextNode(' '));
    const span = document.createElement('span');
    span.textContent = sentence;
    nodes.push(span);
  });
  el.replaceChildren(...nodes);
}
