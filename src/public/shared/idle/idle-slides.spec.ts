import {
  createDefaultIdleScreenSettings,
  type IdleInfo,
} from '@/shared/idle-screen-contract';
import {
  IDLE_SLIDES,
  buildPlaylist,
  getSlideDef,
  playlistSignature,
} from './idle-slides';

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

const CATALOG = [
  'welcome',
  'howToPrint',
  'howToCopy',
  'idCardCopy',
  'scanToPhone',
  'prices',
  'paying',
  'supportedFiles',
  'privacyReceipt',
];

describe('IDLE_SLIDES', () => {
  it('lists every slide once, in catalog order, with slot paths', () => {
    expect(IDLE_SLIDES.map((slide) => slide.id)).toEqual(CATALOG);
    for (const slide of IDLE_SLIDES) {
      expect(slide.src).toMatch(/^\/assets\/lottie\/idle\/[a-z-]+\.lottie$/);
      expect(slide.poster).toMatch(/^\/assets\/lottie\/idle\/posters\/[a-z-]+\.svg$/);
    }
    expect(new Set(IDLE_SLIDES.map((slide) => slide.src)).size).toBe(9);
  });

  it('finds a slide by id', () => {
    expect(getSlideDef('howToCopy').service).toBe('copy');
  });
});

describe('buildPlaylist', () => {
  it('shows the whole catalog on a healthy kiosk', () => {
    expect(buildPlaylist(info())).toEqual(CATALOG);
  });

  it('removes slides the admin turned off', () => {
    const settings = createDefaultIdleScreenSettings();
    settings.slides.prices = false;
    settings.slides.howToCopy = false;
    const slides = buildPlaylist(info({ settings }));
    expect(slides).not.toContain('prices');
    expect(slides).not.toContain('howToCopy');
  });

  it('always keeps welcome', () => {
    const settings = createDefaultIdleScreenSettings();
    for (const key of Object.keys(settings.slides) as Array<
      keyof typeof settings.slides
    >) {
      settings.slides[key] = false;
    }
    expect(buildPlaylist(info({ settings }))).toEqual(['welcome']);
  });

  it('skips slides for an unavailable service', () => {
    const degraded = info();
    degraded.services.copy = { state: 'unavailable', reason: 'paper_out' };
    expect(buildPlaylist(degraded)).toEqual(
      CATALOG.filter((id) => id !== 'howToCopy' && id !== 'idCardCopy'),
    );
  });

  it('skips print slides when print is unavailable', () => {
    const degraded = info();
    degraded.services.print = { state: 'unavailable', reason: 'printer_offline' };
    const slides = buildPlaylist(degraded);
    expect(slides).not.toContain('howToPrint');
    expect(slides).not.toContain('supportedFiles');
  });

  it('keeps how-to slides for a limited service', () => {
    const limited = info();
    limited.services.print = { state: 'limited', reason: 'paper_low' };
    expect(buildPlaylist(limited)).toEqual(CATALOG);
  });

  it('drops prices when pricing is missing', () => {
    expect(buildPlaylist(info({ pricing: null }))).not.toContain('prices');
  });

  it('skips prices before any info has arrived', () => {
    expect(buildPlaylist(null)).toEqual(CATALOG.filter((id) => id !== 'prices'));
  });
});

describe('playlistSignature', () => {
  it('changes when a service state changes', () => {
    const changed = info();
    changed.services.scan = { state: 'unavailable', reason: 'scanner_unavailable' };
    expect(playlistSignature(changed)).not.toBe(playlistSignature(info()));
  });

  it('ignores price values but notices missing pricing', () => {
    const cheaper = info({
      pricing: { printBwFrom: 2, printColorFrom: 10, copyBw: 2, copyColor: 4, scan: 3 },
    });
    expect(playlistSignature(cheaper)).toBe(playlistSignature(info()));
    expect(playlistSignature(info({ pricing: null }))).not.toBe(
      playlistSignature(info()),
    );
  });

  it('changes when settings change', () => {
    const settings = createDefaultIdleScreenSettings();
    settings.slides.paying = false;
    expect(playlistSignature(info({ settings }))).not.toBe(playlistSignature(info()));
  });
});
