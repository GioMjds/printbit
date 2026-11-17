import {
  DISABLEABLE_IDLE_SLIDE_IDS,
  applyIdleScreenSettingsPatch,
  createDefaultIdleScreenSettings,
  isDisableableIdleSlideId,
  IDLE_SLIDE_IDS,
  normalizeIdleScreenSettings,
  validateIdleScreenSettingsPatch,
} from './idle-screen-contract';


describe('idle screen contract', () => {
  it('defaults to 8 seconds with every slide on', () => {
    const settings = createDefaultIdleScreenSettings();
    expect(settings.slideDurationSeconds).toBe(8);
    for (const id of DISABLEABLE_IDLE_SLIDE_IDS) {
      expect(settings.slides[id]).toBe(true);
    }
  });

  it('returns a fresh defaults object each call', () => {
    const first = createDefaultIdleScreenSettings();
    first.slides.prices = false;
    expect(createDefaultIdleScreenSettings().slides.prices).toBe(true);
  });

  it('has no status slide', () => {
    expect(IDLE_SLIDE_IDS).not.toContain('status');
    expect(IDLE_SLIDE_IDS).toHaveLength(9);
  });

  it('knows which slides can be turned off', () => {
    expect(isDisableableIdleSlideId('prices')).toBe(true);
    expect(isDisableableIdleSlideId('welcome')).toBe(false);
    expect(isDisableableIdleSlideId('bogus')).toBe(false);
  });

  describe('normalizeIdleScreenSettings', () => {
    it('uses defaults when nothing is stored', () => {
      expect(normalizeIdleScreenSettings(undefined)).toEqual(
        createDefaultIdleScreenSettings(),
      );
    });

    it('keeps valid stored values and fills the rest', () => {
      const result = normalizeIdleScreenSettings({
        slideDurationSeconds: 12,
        slides: { prices: false },
      });
      expect(result.slideDurationSeconds).toBe(12);
      expect(result.slides.prices).toBe(false);
      expect(result.slides.howToPrint).toBe(true);
    });

    it('drops an out-of-range duration and invalid slide entries', () => {
      const result = normalizeIdleScreenSettings({
        slideDurationSeconds: 99,
        slides: { welcome: false, prices: 'no' },
      });
      expect(result).toEqual(createDefaultIdleScreenSettings());
    });
  });

  describe('validateIdleScreenSettingsPatch', () => {
    it.each([4, 21, 7.5, '8'])('rejects duration %p', (value) => {
      expect(
        validateIdleScreenSettingsPatch({ slideDurationSeconds: value }).ok,
      ).toBe(false);
    });

    it.each([5, 20])('accepts duration %p', (value) => {
      expect(
        validateIdleScreenSettingsPatch({ slideDurationSeconds: value }),
      ).toEqual({ ok: true, patch: { slideDurationSeconds: value } });
    });

    it('rejects a slide that cannot be turned off', () => {
      const result = validateIdleScreenSettingsPatch({
        slides: { status: false },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('idleScreen.slides.status');
    });

    it('rejects an unknown slide id', () => {
      expect(
        validateIdleScreenSettingsPatch({ slides: { bogus: true } }).ok,
      ).toBe(false);
    });

    it('rejects a non-boolean slide value', () => {
      expect(
        validateIdleScreenSettingsPatch({ slides: { prices: 1 } }).ok,
      ).toBe(false);
    });

    it('rejects an unknown top-level field', () => {
      expect(validateIdleScreenSettingsPatch({ theme: 'dark' }).ok).toBe(false);
    });

    it.each([null, [], 'x', 3])('rejects non-object input %p', (value) => {
      expect(validateIdleScreenSettingsPatch(value).ok).toBe(false);
    });

    it('accepts a partial slides patch', () => {
      expect(
        validateIdleScreenSettingsPatch({ slides: { prices: false } }),
      ).toEqual({ ok: true, patch: { slides: { prices: false } } });
    });
  });

  it('applies a patch without dropping other slides', () => {
    const next = applyIdleScreenSettingsPatch(
      createDefaultIdleScreenSettings(),
      { slides: { prices: false } },
    );
    expect(next.slides.prices).toBe(false);
    expect(next.slides.paying).toBe(true);
    expect(next.slideDurationSeconds).toBe(8);
  });

});
