/**
 * Idle screen text in English and Filipino. The idle overlay opts out of the
 * kiosk-wide phrase translator (data-i18n-skip) because it alternates
 * languages per cycle, so its strings live here instead of locales/.
 */
import type {
  IdleInfo,
  IdlePaperLevel,
  IdlePricingSummary,
  IdleServiceName,
  IdleServiceReason,
  IdleServiceState,
  IdleServiceStatus,
  IdleSlideId,
} from '@/shared/idle-screen-contract';
import { isIdleDegraded } from '@/shared/idle-screen-contract';
import { formatPeso } from '../pricing-guide';

export type IdleLang = 'en' | 'fil';

export const IDLE_FALLBACK_COINS: readonly number[] = [1, 5, 10, 20];
export const IDLE_FALLBACK_MAX_UPLOAD_MB = 25;
export const IDLE_SERVICE_ORDER: readonly IdleServiceName[] = [
  'print',
  'copy',
  'scan',
];

export interface IdleSlideText {
  eyebrow: string;
  title: string;
  body: string;
  lines: string[];
  stepped: boolean;
}

type FixedSlideId =
  | 'welcome'
  | 'howToPrint'
  | 'howToCopy'
  | 'idCardCopy'
  | 'scanToPhone'
  | 'privacyReceipt';

interface IdleLangTable {
  ui: { cta: string; overlayLabel: string; chipsLabel: string };
  services: Record<IdleServiceName, string>;
  states: Record<IdleServiceState, string>;
  reasons: Record<IdleServiceReason, string>;
  paper: Record<Exclude<IdlePaperLevel, 'unknown'>, string>;
  exactCoins: string;
  status: {
    eyebrow: string;
    titleReady: string;
    titleLimited: string;
    titleChecking: string;
  };
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

const TEXT: Record<IdleLang, IdleLangTable> = {
  en: {
    ui: {
      cta: 'Tap anywhere to start',
      overlayLabel: 'PrintBit kiosk is idle. Tap anywhere to start.',
      chipsLabel: 'Service status',
    },
    services: { print: 'Print', copy: 'Copy', scan: 'Scan' },
    states: {
      ready: 'Ready',
      limited: 'Limited',
      unavailable: 'Unavailable',
      unknown: 'Checking…',
    },
    reasons: {
      printer_offline: 'printer is offline',
      printer_error: 'printer needs attention',
      paper_out: 'out of paper',
      paper_low: 'paper is running low',
      scanner_unavailable: 'scanner is not available',
    },
    paper: { ok: 'Paper: OK', low: 'Paper: running low', out: 'Paper: out' },
    exactCoins: "Exact coins only: change can't be given right now.",
    status: {
      eyebrow: 'Kiosk status',
      titleReady: 'Everything is ready.',
      titleLimited: 'Some services are limited.',
      titleChecking: 'Checking the kiosk…',
    },
    fixed: {
      welcome: {
        eyebrow: 'PrintBit self-service',
        title: 'Print, copy, and scan.',
        body: 'All you need is coins and your phone.',
        lines: [],
        stepped: false,
      },
      howToPrint: {
        eyebrow: 'How to print',
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
        eyebrow: 'How to copy',
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
        eyebrow: 'ID card copy',
        title: 'Both sides on one sheet.',
        body: 'Scan the front, flip the card, scan the back. See the sheet before you pay.',
        lines: [],
        stepped: false,
      },
      scanToPhone: {
        eyebrow: 'Scan to phone',
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
        eyebrow: 'Privacy',
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
      eyebrow: 'Paying',
      title: 'Coins only, whole pesos.',
      body: (coins) =>
        `Accepted coins: ${coins}. The kiosk gives back your change.`,
      exactCoins: "Change can't be given right now. Please pay the exact amount.",
    },
    supportedFiles: {
      eyebrow: 'Supported files',
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
      chipsLabel: 'Kalagayan ng serbisyo',
    },
    services: { print: 'Print', copy: 'Copy', scan: 'Scan' },
    states: {
      ready: 'Handa',
      limited: 'Limitado',
      unavailable: 'Hindi magagamit',
      unknown: 'Sinusuri…',
    },
    reasons: {
      printer_offline: 'naka-offline ang printer',
      printer_error: 'may problema ang printer',
      paper_out: 'ubos ang papel',
      paper_low: 'paubos na ang papel',
      scanner_unavailable: 'hindi magamit ang scanner',
    },
    paper: { ok: 'Papel: OK', low: 'Papel: paubos na', out: 'Papel: ubos na' },
    exactCoins: 'Eksaktong barya lang: hindi makakapagsukli sa ngayon.',
    status: {
      eyebrow: 'Kalagayan ng kiosk',
      titleReady: 'Handa na ang lahat.',
      titleLimited: 'May limitadong serbisyo ngayon.',
      titleChecking: 'Sinusuri ang kiosk…',
    },
    fixed: {
      welcome: {
        eyebrow: 'PrintBit self-service',
        title: 'Mag-print, mag-copy, at mag-scan.',
        body: 'Barya at cellphone lang ang kailangan mo.',
        lines: [],
        stepped: false,
      },
      howToPrint: {
        eyebrow: 'Paano mag-print',
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
        eyebrow: 'Paano mag-copy',
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
        eyebrow: 'Kopya ng ID',
        title: 'Harap at likod sa iisang papel.',
        body: 'I-scan ang harap, baligtarin ang card, at i-scan ang likod. Makikita mo muna ang papel bago magbayad.',
        lines: [],
        stepped: false,
      },
      scanToPhone: {
        eyebrow: 'I-scan papunta sa cellphone',
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
        eyebrow: 'Privacy',
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
      eyebrow: 'Pagbabayad',
      title: 'Barya lang, buong piso.',
      body: (coins) => `Tinatanggap: ${coins}. Isusukli ng kiosk ang sobra.`,
      exactCoins:
        'Hindi makakapagsukli sa ngayon. Pakibayaran ang eksaktong halaga.',
    },
    supportedFiles: {
      eyebrow: 'Mga file na puwede',
      title: 'Dalhin ang dokumento mo.',
      body: (mb, word) =>
        word
          ? `PDF, Word, at mga larawan (JPG, PNG, GIF, WebP, BMP), hanggang ${mb} MB bawat file.`
          : `PDF at mga larawan (JPG, PNG, GIF, WebP, BMP), hanggang ${mb} MB bawat file.`,
    },
  },
};

export const IDLE_UI_TEXT: Record<IdleLang, IdleLangTable['ui']> = {
  en: TEXT.en.ui,
  fil: TEXT.fil.ui,
};

export function serviceLabel(name: IdleServiceName, lang: IdleLang): string {
  return TEXT[lang].services[name];
}

export function chipStateLabel(state: IdleServiceState, lang: IdleLang): string {
  return TEXT[lang].states[state];
}

export function statusLines(info: IdleInfo | null, lang: IdleLang): string[] {
  const t = TEXT[lang];
  const lines = IDLE_SERVICE_ORDER.map((name) => {
    const status: IdleServiceStatus = info
      ? info.services[name]
      : { state: 'unknown', reason: null };
    const base = `${t.services[name]} — ${t.states[status.state]}`;
    return status.reason ? `${base}: ${t.reasons[status.reason]}` : base;
  });
  const level = info?.paper.level ?? 'unknown';
  if (level !== 'unknown') lines.push(t.paper[level]);
  if (info?.change.exactCoinsOnly) lines.push(t.exactCoins);
  return lines;
}

export function statusSummary(info: IdleInfo | null, lang: IdleLang): string {
  return statusLines(info, lang).join('. ');
}

export function renderSlideText(
  id: IdleSlideId,
  lang: IdleLang,
  info: IdleInfo | null,
): IdleSlideText {
  const t = TEXT[lang];
  switch (id) {
    case 'status': {
      const title = !info
        ? t.status.titleChecking
        : isIdleDegraded(info)
          ? t.status.titleLimited
          : t.status.titleReady;
      return {
        eyebrow: t.status.eyebrow,
        title,
        body: '',
        lines: statusLines(info, lang),
        stepped: false,
      };
    }
    case 'prices':
      return {
        eyebrow: t.prices.eyebrow,
        title: t.prices.title,
        body: t.prices.body,
        lines: info?.pricing ? t.prices.lines(info.pricing) : [],
        stepped: false,
      };
    case 'paying': {
      const coins = (info?.coins ?? IDLE_FALLBACK_COINS)
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
