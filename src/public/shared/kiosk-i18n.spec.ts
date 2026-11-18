/**
 * @jest-environment jsdom
 */
import { isI18nSkipped } from './kiosk-i18n';

describe('isI18nSkipped', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div data-i18n-skip><p id="inside">Tap anywhere to start</p></div>' +
      '<p id="outside">Tap anywhere to start</p>';
  });

  it('skips text inside a data-i18n-skip subtree', () => {
    const inside = document.getElementById('inside')!;
    expect(isI18nSkipped(inside.firstChild)).toBe(true);
    expect(isI18nSkipped(inside)).toBe(true);
  });

  it('does not skip text outside it', () => {
    const outside = document.getElementById('outside')!;
    expect(isI18nSkipped(outside.firstChild)).toBe(false);
    expect(isI18nSkipped(outside)).toBe(false);
  });

  it('handles null', () => {
    expect(isI18nSkipped(null)).toBe(false);
  });
});
