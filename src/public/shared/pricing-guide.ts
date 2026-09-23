export type PaperProfileKey = 'a4' | 'shortBond' | 'longBond';

export interface PublicPricingConfig {
  paperProfiles: Record<
    PaperProfileKey,
    { baseBwPrice: number; baseColorPrice: number }
  >;
  highQualitySurcharge: number;
}

const DEFAULT_PRICING = {
  paperProfiles: {
    a4: { baseBwPrice: 3, baseColorPrice: 18 },
    shortBond: { baseBwPrice: 3, baseColorPrice: 18 },
    longBond: { baseBwPrice: 4, baseColorPrice: 20 },
  },
  highQualitySurcharge: 2,
} satisfies PublicPricingConfig;

const PAPER_LABELS = {
  a4: 'A4',
  shortBond: 'Short bond',
  longBond: 'Long bond',
} satisfies Record<PaperProfileKey, string>;

function safeAmount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

export function normalizePricingConfig(raw: unknown): PublicPricingConfig {
  const candidate = raw as Partial<PublicPricingConfig> | null;
  const profiles = candidate?.paperProfiles;
  const profileFor = (key: PaperProfileKey) => ({
    baseBwPrice: safeAmount(
      profiles?.[key]?.baseBwPrice,
      DEFAULT_PRICING.paperProfiles[key].baseBwPrice,
    ),
    baseColorPrice: safeAmount(
      profiles?.[key]?.baseColorPrice,
      DEFAULT_PRICING.paperProfiles[key].baseColorPrice,
    ),
  });

  return {
    paperProfiles: {
      a4: profileFor('a4'),
      shortBond: profileFor('shortBond'),
      longBond: profileFor('longBond'),
    },
    highQualitySurcharge: safeAmount(
      candidate?.highQualitySurcharge,
      DEFAULT_PRICING.highQualitySurcharge,
    ),
  };
}

export function formatPeso(amount: number): string {
  return `₱${amount}`;
}

export function formatPricingGuide(pricing: PublicPricingConfig): string {
  const rows = (Object.keys(PAPER_LABELS) as PaperProfileKey[])
    .map((key) => {
      const profile = pricing.paperProfiles[key];
      return `<tr><th scope="row">${PAPER_LABELS[key]}</th><td>${formatPeso(profile.baseBwPrice)}</td><td>${formatPeso(profile.baseColorPrice)}</td></tr>`;
    })
    .join('');

  return `<table class="pricing-table"><caption>Base price per page</caption><thead><tr><th scope="col">Paper size</th><th scope="col">B&amp;W</th><th scope="col">Color</th></tr></thead><tbody>${rows}</tbody></table><p class="pricing-quality-note">High quality: +${formatPeso(pricing.highQualitySurcharge)} per page.</p>`;
}

export async function fetchPublicPricing(): Promise<PublicPricingConfig> {
  const response = await fetch('/api/pricing-config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to load printing prices.');
  return normalizePricingConfig(await response.json());
}
