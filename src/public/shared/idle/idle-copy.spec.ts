import {
  IDLE_SLIDE_IDS,
  createDefaultIdleScreenSettings,
  type IdleInfo,
} from '@/shared/idle-screen-contract';
import { IDLE_UI_TEXT, renderSlideText } from './idle-copy';

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
  });

});

describe('IDLE_UI_TEXT', () => {
  it('labels the overlay in both languages', () => {
    expect(IDLE_UI_TEXT.en.cta).toBe('Tap anywhere to start');
    expect(IDLE_UI_TEXT.fil.cta).toBe('Pindutin kahit saan para magsimula');
  });
});
