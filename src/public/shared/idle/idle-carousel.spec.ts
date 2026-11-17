import {
  createDefaultIdleScreenSettings,
  type IdleInfo,
} from '@/shared/idle-screen-contract';
import { IdleCarousel } from './idle-carousel';

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

describe('IdleCarousel', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('shows slides in order, then starts the next cycle in Filipino', () => {
    const showSlide = jest.fn();
    const carousel = new IdleCarousel({ getInfo: () => info(), showSlide });
    carousel.start();
    expect(showSlide).toHaveBeenLastCalledWith('welcome', 'en', 8000);
    jest.advanceTimersByTime(8000);
    expect(showSlide).toHaveBeenLastCalledWith('status', 'en', 8000);
    jest.advanceTimersByTime(8000 * 8);
    expect(showSlide).toHaveBeenLastCalledWith('privacyReceipt', 'en', 8000);
    jest.advanceTimersByTime(8000);
    expect(showSlide).toHaveBeenLastCalledWith('welcome', 'fil', 8000);
    carousel.stop();
  });

  it('uses the configured slide duration', () => {
    const settings = createDefaultIdleScreenSettings();
    settings.slideDurationSeconds = 12;
    const showSlide = jest.fn();
    const carousel = new IdleCarousel({
      getInfo: () => info({ settings }),
      showSlide,
    });
    carousel.start();
    expect(showSlide).toHaveBeenLastCalledWith('welcome', 'en', 12000);
    carousel.stop();
  });

  it('runs with no info yet using the default duration', () => {
    const showSlide = jest.fn();
    const carousel = new IdleCarousel({ getInfo: () => null, showSlide });
    carousel.start();
    expect(showSlide).toHaveBeenLastCalledWith('welcome', 'en', 8000);
    carousel.stop();
  });

  it('leaves no timers after stop and ignores a second start', () => {
    const carousel = new IdleCarousel({
      getInfo: () => info(),
      showSlide: jest.fn(),
    });
    carousel.start();
    carousel.start();
    expect(jest.getTimerCount()).toBe(1);
    carousel.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rebuilds after invalidate and leads with status once degraded', () => {
    let current: IdleInfo | null = null;
    const showSlide = jest.fn();
    const carousel = new IdleCarousel({ getInfo: () => current, showSlide });
    carousel.start();
    expect(showSlide).toHaveBeenLastCalledWith('welcome', 'en', 8000);

    const degraded = info();
    degraded.services.scan = { state: 'unavailable', reason: 'scanner_unavailable' };
    current = degraded;
    carousel.invalidate();
    jest.advanceTimersByTime(8000);
    expect(showSlide).toHaveBeenLastCalledWith('status', 'en', 8000);
    carousel.stop();
  });

  it('does not repeat the slide on screen when a rebuild starts with it', () => {
    let current: IdleInfo | null = null;
    const showSlide = jest.fn();
    const carousel = new IdleCarousel({ getInfo: () => current, showSlide });
    carousel.start();
    current = info();
    carousel.invalidate();
    jest.advanceTimersByTime(8000);
    expect(showSlide).toHaveBeenLastCalledWith('status', 'en', 8000);
    carousel.stop();
  });
});
