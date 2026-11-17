import {
  IDLE_SLIDE_IDS,
  createDefaultIdleScreenSettings,
  type IdleInfo,
} from '@/shared/idle-screen-contract';
import {
  IDLE_UI_TEXT,
  chipStateLabel,
  renderSlideText,
  serviceLabel,
  statusLines,
  statusSummary,
} from './idle-copy';

const info = (overrides: Partial<IdleInfo> = {}): IdleInfo => ({
  settings: createDefaultIdleScreenSettings(),
  pricing: { printBwFrom: 3, printColorFrom: 18, copyBw: 3, copyColor: 5, scan: 5 },
  services: {
    print: { state: 'ready', reason: null },
    copy: { state: 'ready', reason: null },
    scan: { state: 'ready', reason: null },
  },
  paper: { level: 'ok' },
  change: { exactCoinsOnly: false },
  coins: [1, 5, 10, 20],
  maxUploadMb: 25,
  wordUploads: true,
  ...overrides,
});

describe('renderSlideText', () => {
  it.each(['en', 'fil'] as const)(
    'renders every slide in %s with and without info',
    (lang) => {
      for (const id of IDLE_SLIDE_IDS) {
        expect(renderSlideText(id, lang, info()).title.length).toBeGreaterThan(0);
        expect(renderSlideText(id, lang, null).title.length).toBeGreaterThan(0);
      }
    },
  );

  it('shows "from" prices', () => {
    const text = renderSlideText('prices', 'en', info());
    expect(text.lines).toEqual([
      'B/W print from ₱3 per page',
      'Color print from ₱18 per page',
      'B/W copy ₱3 per page',
      'Color copy ₱5 per page',
      'Scan ₱5 per document',
    ]);
  });

  it('lists accepted coins and adds the exact-amount note when change is out', () => {
    expect(renderSlideText('paying', 'en', info()).body).toContain('₱1, ₱5, ₱10, ₱20');
    expect(renderSlideText('paying', 'en', info()).body).not.toContain('exact amount');
    expect(
      renderSlideText('paying', 'en', info({ change: { exactCoinsOnly: true } })).body,
    ).toContain('exact amount');
  });

  it('mentions Word only when Word uploads are on', () => {
    expect(renderSlideText('supportedFiles', 'en', info()).body).toContain('Word');
    expect(
      renderSlideText('supportedFiles', 'en', info({ wordUploads: false })).body,
    ).not.toContain('Word');
    expect(renderSlideText('supportedFiles', 'en', info()).body).toContain('25 MB');
  });

  it('marks only the how-to slides as stepped', () => {
    expect(renderSlideText('howToPrint', 'en', info()).stepped).toBe(true);
    expect(renderSlideText('howToPrint', 'en', info()).lines).toHaveLength(4);
    expect(renderSlideText('prices', 'en', info()).stepped).toBe(false);
    expect(renderSlideText('status', 'en', info()).stepped).toBe(false);
  });

  it('titles the status slide by kiosk health', () => {
    expect(renderSlideText('status', 'en', info()).title).toBe('Everything is ready.');
    const down = info();
    down.services.copy = { state: 'unavailable', reason: 'paper_out' };
    expect(renderSlideText('status', 'en', down).title).toBe(
      'Some services are limited.',
    );
    expect(renderSlideText('status', 'en', null).title).toBe('Checking the kiosk…');
  });
});

describe('status text', () => {
  it('describes each service with its reason, paper, and change', () => {
    const down = info({ paper: { level: 'out' }, change: { exactCoinsOnly: true } });
    down.services.copy = { state: 'unavailable', reason: 'paper_out' };
    expect(statusLines(down, 'en')).toEqual([
      'Print — Ready',
      'Copy — Unavailable: out of paper',
      'Scan — Ready',
      'Paper: out',
      "Exact coins only: change can't be given right now.",
    ]);
  });

  it('says Checking… for every service before info arrives', () => {
    expect(statusLines(null, 'en')).toEqual([
      'Print — Checking…',
      'Copy — Checking…',
      'Scan — Checking…',
    ]);
    expect(statusLines(null, 'fil')[0]).toBe('Print — Sinusuri…');
  });

  it('joins lines for screen readers', () => {
    expect(statusSummary(null, 'en')).toBe(
      'Print — Checking…. Copy — Checking…. Scan — Checking…',
    );
  });

  it('labels chips and UI in both languages', () => {
    expect(serviceLabel('scan', 'en')).toBe('Scan');
    expect(chipStateLabel('limited', 'fil')).toBe('Limitado');
    expect(IDLE_UI_TEXT.fil.cta).toBe('Pindutin kahit saan para magsimula');
  });
});
