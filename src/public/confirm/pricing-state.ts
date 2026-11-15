export type PricingState<Q> =
  | { status: 'loading'; quote: Q | null }
  | { status: 'ready'; totalPrice: number; quote: Q | null }
  | { status: 'error'; message: string };

export type PricingEvent<Q> =
  | { type: 'quote-loaded'; totalPrice: number; quote: Q | null }
  | { type: 'quote-failed'; message: string };

export function createPricingState<Q>(input?: {
  quote?: Q | null;
}): PricingState<Q> {
  return { status: 'loading', quote: input?.quote ?? null };
}

export function reducePricing<Q>(
  _state: PricingState<Q>,
  event: PricingEvent<Q>,
): PricingState<Q> {
  if (event.type === 'quote-loaded') {
    return {
      status: 'ready',
      totalPrice: event.totalPrice,
      quote: event.quote,
    };
  }
  return { status: 'error', message: event.message };
}

export function isPricingReady<Q>(state: PricingState<Q>): boolean {
  return state.status === 'ready';
}

export function getTotalPrice<Q>(state: PricingState<Q>): number {
  return state.status === 'ready' ? state.totalPrice : 0;
}

export function getQuote<Q>(state: PricingState<Q>): Q | null {
  return state.status === 'error' ? null : state.quote;
}

export function getPricingMessage<Q>(state: PricingState<Q>): string | null {
  return state.status === 'error' ? state.message : null;
}
