/**
 * Idle screen text in English and Filipino. The idle overlay follows the
 * kiosk's current language but opts out of the kiosk-wide phrase translator
 * (data-i18n-skip) because its text changes every slide, so its strings live
 * here instead of locales/.
 */
import type {
  IdleInfo,
  IdlePricingSummary,
  IdleSlideId,
} from '@/shared/idle-screen-contract';
import { formatPeso } from '../pricing-guide';

export type IdleLang = 'en' | 'fil';

export const IDLE_FALLBACK_COINS: readonly number[] = [1, 5, 10, 20];
export const IDLE_FALLBACK_MAX_UPLOAD_MB = 25;

export interface IdleSlideText {
  eyebrow: string;
  title: string;
  body: string;
  lines: string[];
  stepped: boolean;
  /** Coin values to picture under the text (paying slide only). */
  coins?: readonly number[];
}

type FixedSlideId =
  | 'welcome'
  | 'howToPrint'
  | 'howToCopy'
  | 'idCardCopy'
  | 'scanToPhone'
  | 'privacyReceipt';

interface IdleLangTable {
  ui: { cta: string; overlayLabel: string };
  fixed: Record<FixedSlideId, IdleSlideText>;
  prices: {
    eyebrow: string;
    title: string;
    body: string;
    lines: (p: IdlePricingSummary) => string[];
  };
  paying: {
    eyebrow: string;
    title: string;
    body: (coins: string) => string;
    exactCoins: string;
  };
  supportedFiles: {
    eyebrow: string;
    title: string;
    body: (mb: number, word: boolean) => string;
  };
}

const TEXT = {
  en: {
    ui: {
      cta: 'Tap anywhere to start',
      overlayLabel: 'PrintBit kiosk is idle. Tap anywhere to start.',
    },
    fixed: {
      welcome: {
        eyebrow: 'Your self-service printing kiosk!',
        title: 'Print, copy, and scan.',
        body: 'All you need is coins and your phone.',
        lines: [],
        stepped: false,
      },
      howToPrint: {
        eyebrow: 'How to send my file(s) to print?',
        title: 'From your phone to paper.',
        body: '',
        lines: [
          'Tap Print and scan the QR code.',
          'Upload your file from your phone.',
          'Choose pages, color, and copies.',
          'Insert coins, then collect your printout.',
        ],
        stepped: true,
      },
      howToCopy: {
        eyebrow: 'How to photocopy?',
        title: 'Photocopy in a few taps.',
        body: '',
        lines: [
          'Tap Copy.',
          'Place your document on the glass or in the feeder.',
          'Set copies and color.',
          'Insert coins, then collect your copies.',
        ],
        stepped: true,
      },
      idCardCopy: {
        eyebrow: 'Want your ID to be copied?',
        title: 'Both sides on one sheet.',
        body: 'Scan the front, flip the card, scan the back. See the sheet before you pay.',
        lines: [],
        stepped: false,
      },
      scanToPhone: {
        eyebrow: 'Want to convert your document to your phone?',
        title: 'Paper to your pocket.',
        body: '',
        lines: [
          'Tap Scan and place your document.',
          'Scan the QR code on the screen.',
          'Download the PDF on your phone.',
        ],
        stepped: true,
      },
      privacyReceipt: {
        eyebrow: 'Privacy matters',
        title: 'Your files stay yours.',
        body: 'Files are deleted after your job. Your e-receipt goes to your phone.',
        lines: [],
        stepped: false,
      },
    },
    prices: {
      eyebrow: 'Prices',
      title: 'Pay only for what you use.',
      body: 'Print prices depend on paper size and how much ink a page uses.',
      lines: (p) => [
        `B/W print from ${formatPeso(p.printBwFrom)} per page`,
        `Color print from ${formatPeso(p.printColorFrom)} per page`,
        `B/W copy ${formatPeso(p.copyBw)} per page`,
        `Color copy ${formatPeso(p.copyColor)} per page`,
        `Scan ${formatPeso(p.scan)} per document`,
      ],
    },
    paying: {
      eyebrow: 'What coins are supported?',
      title: 'Coins only, whole pesos.',
      body: (coins) =>
        `Accepted coins: ${coins}. The kiosk gives back your change.`,
      exactCoins:
        "Change can't be given right now. Please pay the exact amount.",
    },
    supportedFiles: {
      eyebrow: 'What files are supported?',
      title: 'Bring your document.',
      body: (mb, word) =>
        word
          ? `PDF, Word, and images (JPG, PNG, GIF, WebP, BMP), up to ${mb} MB per file.`
          : `PDF and images (JPG, PNG, GIF, WebP, BMP), up to ${mb} MB per file.`,
    },
  },
  fil: {
    ui: {
      cta: 'Pindutin kahit saan para magsimula',
      overlayLabel:
        'Nakatigil ang PrintBit kiosk. Pindutin kahit saan para magsimula.',
    },
    fixed: {
      welcome: {
        eyebrow: 'Ang iyong self-service printing kiosk!',
        title: 'Mag-print, mag-copy, at mag-scan.',
        body: 'Barya at cellphone lang ang kailangan mo.',
        lines: [],
        stepped: false,
      },
      howToPrint: {
        eyebrow: 'Paano ko ipapadala ang file ko para i-print?',
        title: 'Mula cellphone hanggang papel.',
        body: '',
        lines: [
          'I-tap ang Print at i-scan ang QR code.',
          'I-upload ang file mula sa cellphone mo.',
          'Piliin ang pages, kulay, at dami ng kopya.',
          'Maghulog ng barya, saka kunin ang print mo.',
        ],
        stepped: true,
      },
      howToCopy: {
        eyebrow: 'Paano magpa-photocopy?',
        title: 'Photocopy sa ilang tap lang.',
        body: '',
        lines: [
          'I-tap ang Copy.',
          'Ilagay ang dokumento sa salamin o sa feeder.',
          'Itakda ang dami ng kopya at kulay.',
          'Maghulog ng barya, saka kunin ang kopya mo.',
        ],
        stepped: true,
      },
      idCardCopy: {
        eyebrow: 'Gusto mo bang i-photocopy ang iyong ID?',
        title: 'Harap at likod sa iisang papel.',
        body: 'I-scan ang harap, baligtarin ang card, at i-scan ang likod. Makikita mo muna ang papel bago magbayad.',
        lines: [],
        stepped: false,
      },
      scanToPhone: {
        eyebrow:
          'Paano ko maiko-convert ang aking dokumento para maging soft copy?',
        title: 'Papel papunta sa bulsa mo.',
        body: '',
        lines: [
          'I-tap ang Scan at ilagay ang dokumento.',
          'I-scan ang QR code sa screen.',
          'I-download ang PDF sa cellphone mo.',
        ],
        stepped: true,
      },
      privacyReceipt: {
        eyebrow: 'Ang iyong privacy ay mahalaga',
        title: 'Sa iyo lang ang mga file mo.',
        body: 'Binubura ang mga file pagkatapos ng job. Sa cellphone mo ipapadala ang e-receipt.',
        lines: [],
        stepped: false,
      },
    },
    prices: {
      eyebrow: 'Presyo',
      title: 'Bayaran lang ang ginamit mo.',
      body: 'Nakadepende ang presyo ng print sa laki ng papel at dami ng tinta sa pahina.',
      lines: (p) => [
        `B/W print mula ${formatPeso(p.printBwFrom)} bawat pahina`,
        `Color print mula ${formatPeso(p.printColorFrom)} bawat pahina`,
        `B/W copy ${formatPeso(p.copyBw)} bawat pahina`,
        `Color copy ${formatPeso(p.copyColor)} bawat pahina`,
        `Scan ${formatPeso(p.scan)} bawat dokumento`,
      ],
    },
    paying: {
      eyebrow: 'Anong mga barya lamang ang tinatanggap?',
      title: 'Barya lang, buong piso.',
      body: (coins) => `Tinatanggap: ${coins}. Isusukli ng kiosk ang sobra.`,
      exactCoins:
        'Hindi makakapagsukli sa ngayon. Pakibayaran ang eksaktong halaga.',
    },
    supportedFiles: {
      eyebrow: 'Anong mga file ang tinatanggap?',
      title: 'Dalhin ang dokumento mo.',
      body: (mb, word) =>
        word
          ? `PDF, Word, at mga larawan (JPG, PNG, GIF, WebP, BMP), hanggang ${mb} MB bawat file.`
          : `PDF at mga larawan (JPG, PNG, GIF, WebP, BMP), hanggang ${mb} MB bawat file.`,
    },
  },
} satisfies Record<IdleLang, IdleLangTable>;

export const IDLE_UI_TEXT = {
  en: TEXT.en.ui,
  fil: TEXT.fil.ui,
} satisfies Record<IdleLang, IdleLangTable['ui']>;

export function renderSlideText(
  id: IdleSlideId,
  lang: IdleLang,
  info: IdleInfo | null,
): IdleSlideText {
  const t = TEXT[lang];
  switch (id) {
    case 'prices':
      return {
        eyebrow: t.prices.eyebrow,
        title: t.prices.title,
        body: t.prices.body,
        lines: info?.pricing ? t.prices.lines(info.pricing) : [],
        stepped: false,
      };
    case 'paying': {
      const values = info?.coins ?? IDLE_FALLBACK_COINS;
      const coins = values
        .map(formatPeso)
        .join(', ');
      const body = info?.change.exactCoinsOnly
        ? `${t.paying.body(coins)} ${t.paying.exactCoins}`
        : t.paying.body(coins);
      return {
        eyebrow: t.paying.eyebrow,
        title: t.paying.title,
        body,
        lines: [],
        stepped: false,
        coins: values,
      };
    }
    case 'supportedFiles':
      return {
        eyebrow: t.supportedFiles.eyebrow,
        title: t.supportedFiles.title,
        body: t.supportedFiles.body(
          info?.maxUploadMb ?? IDLE_FALLBACK_MAX_UPLOAD_MB,
          info?.wordUploads ?? false,
        ),
        lines: [],
        stepped: false,
      };
    default: {
      const fixed = t.fixed[id];
      return { ...fixed, lines: [...fixed.lines] };
    }
  }
}
