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
  'status',
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
    expect(new Set(IDLE_SLIDES.map((slide) => slide.src)).size).toBe(10);
  });

  it('finds a slide by id', () => {
    expect(getSlideDef('howToCopy').service).toBe('copy');
  });
});

describe('buildPlaylist', () => {
  it('shows the whole catalog on a healthy kiosk', () => {
    expect(buildPlaylist(info(), 0).slides).toEqual(CATALOG);
  });

  it('removes slides the admin turned off', () => {
    const settings = createDefaultIdleScreenSettings();
    settings.slides.prices = false;
    settings.slides.howToCopy = false;
    const slides = buildPlaylist(info({ settings }), 0).slides;
    expect(slides).not.toContain('prices');
    expect(slides).not.toContain('howToCopy');
  });

  it('always keeps welcome and status', () => {
    const settings = createDefaultIdleScreenSettings();
    for (const key of Object.keys(settings.slides) as Array<
      keyof typeof settings.slides
    >) {
      settings.slides[key] = false;
    }
    expect(buildPlaylist(info({ settings }), 0).slides).toEqual(['welcome', 'status']);
  });

  it('skips slides for an unavailable service and leads with repeated status', () => {
    const degraded = info();
    degraded.services.copy = { state: 'unavailable', reason: 'paper_out' };
    expect(buildPlaylist(degraded, 0).slides).toEqual([
      'status',
      'welcome',
      'howToPrint',
      'status',
      'scanToPhone',
      'prices',
      'status',
      'paying',
      'supportedFiles',
      'status',
      'privacyReceipt',
    ]);
  });

  it('skips print slides when print is unavailable', () => {
    const degraded = info();
    degraded.services.print = { state: 'unavailable', reason: 'printer_offline' };
    const slides = buildPlaylist(degraded, 0).slides;
    expect(slides).not.toContain('howToPrint');
    expect(slides).not.toContain('supportedFiles');
  });

  it('keeps how-to slides for a limited service but leads with status', () => {
    const limited = info();
    limited.services.print = { state: 'limited', reason: 'paper_low' };
    const slides = buildPlaylist(limited, 0).slides;
    expect(slides[0]).toBe('status');
    expect(slides).toContain('howToPrint');
  });

  it('treats exact-coins-only as degraded', () => {
    expect(
      buildPlaylist(info({ change: { exactCoinsOnly: true } }), 0).slides[0],
    ).toBe('status');
  });

  it('drops prices when pricing is missing', () => {
    expect(buildPlaylist(info({ pricing: null }), 0).slides).not.toContain('prices');
  });

  it('works before any info has arrived', () => {
    const playlist = buildPlaylist(null, 0);
    expect(playlist.slides).toEqual(CATALOG.filter((id) => id !== 'prices'));
    expect(playlist.lang).toBe('en');
  });

  it('alternates English and Filipino by cycle', () => {
    expect(buildPlaylist(info(), 0).lang).toBe('en');
    expect(buildPlaylist(info(), 1).lang).toBe('fil');
    expect(buildPlaylist(info(), 2).lang).toBe('en');
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
