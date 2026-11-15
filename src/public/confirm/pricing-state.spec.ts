import {
  createPricingState,
  getPricingMessage,
  getQuote,
  getTotalPrice,
  isPricingReady,
  reducePricing,
} from './pricing-state';

type Quote = { requiredAmount: number };

describe('pricing-state', () => {
  it('starts loading with no price and no quote', () => {
    const state = createPricingState<Quote>();
    expect(state).toEqual({ status: 'loading', quote: null });
    expect(isPricingReady(state)).toBe(false);
    expect(getTotalPrice(state)).toBe(0);
    expect(getQuote(state)).toBeNull();
    expect(getPricingMessage(state)).toBeNull();
  });

  it('keeps a seeded quote readable while loading', () => {
    const state = createPricingState<Quote>({ quote: { requiredAmount: 7 } });
    expect(getQuote(state)).toEqual({ requiredAmount: 7 });
    expect(getTotalPrice(state)).toBe(0);
    expect(isPricingReady(state)).toBe(false);
  });

  it('becomes ready when a quote loads', () => {
    const state = reducePricing(createPricingState<Quote>(), {
      type: 'quote-loaded',
      totalPrice: 12,
      quote: { requiredAmount: 12 },
    });
    expect(isPricingReady(state)).toBe(true);
    expect(getTotalPrice(state)).toBe(12);
    expect(getQuote(state)).toEqual({ requiredAmount: 12 });
    expect(getPricingMessage(state)).toBeNull();
  });

  it('supports a ready state without a quote (scan flat fee)', () => {
    const state = reducePricing(createPricingState<Quote>(), {
      type: 'quote-loaded',
      totalPrice: 5,
      quote: null,
    });
    expect(isPricingReady(state)).toBe(true);
    expect(getTotalPrice(state)).toBe(5);
    expect(getQuote(state)).toBeNull();
  });

  it('drops price and quote when the quote fails', () => {
    const ready = reducePricing(createPricingState<Quote>(), {
      type: 'quote-loaded',
      totalPrice: 12,
      quote: { requiredAmount: 12 },
    });
    const failed = reducePricing(ready, {
      type: 'quote-failed',
      message: 'Print session is required.',
    });
    expect(isPricingReady(failed)).toBe(false);
    expect(getTotalPrice(failed)).toBe(0);
    expect(getQuote(failed)).toBeNull();
    expect(getPricingMessage(failed)).toBe('Print session is required.');
  });

  it('recovers from error when a later quote loads', () => {
    const failed = reducePricing(createPricingState<Quote>(), {
      type: 'quote-failed',
      message: 'x',
    });
    const ready = reducePricing(failed, {
      type: 'quote-loaded',
      totalPrice: 3,
      quote: null,
    });
    expect(isPricingReady(ready)).toBe(true);
    expect(getPricingMessage(ready)).toBeNull();
  });
});
