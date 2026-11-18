import { formatPeso } from './pricing-guide';

// Old series first so the new coin paints on top; both series still circulate.
const COIN_IMAGES: Record<number, readonly string[]> = {
  1: ['1-peso-coin-old', '1-peso-coin-new'],
  5: ['5-peso-coin-old', '5-peso-coin-new'],
  10: ['10-peso-coin-old', '10-peso-coin-new'],
  20: ['20-peso-coin'],
};

/** Fills a list with one coin photo stack + peso label per value. */
export function renderCoinList(
  list: HTMLElement,
  values: readonly number[],
): void {
  list.replaceChildren(
    ...values.map((value) => {
      const item = document.createElement('li');
      item.className = 'coin-strip__coin';
      const stack = document.createElement('span');
      stack.className = 'coin-strip__stack';
      for (const name of COIN_IMAGES[value] ?? []) {
        const img = document.createElement('img');
        img.className = 'coin-strip__img';
        img.src = `/assets/coins/sm/${name}.webp`;
        img.width = 56;
        img.height = 56;
        img.alt = '';
        stack.append(img);
      }
      const label = document.createElement('span');
      label.className = 'coin-strip__value';
      label.textContent = formatPeso(value);
      item.append(stack, label);
      return item;
    }),
  );
}
