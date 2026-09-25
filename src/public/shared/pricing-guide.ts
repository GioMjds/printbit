export type PaperProfileKey = 'a4' | 'shortBond' | 'longBond';

export interface PublicPricingConfig {
  paperProfiles: Record<
    PaperProfileKey,
    {
      baseBwPrice: number;
      baseColorPrice: number;
      baseImagePrice: number;
      baseImageBwPrice: number;
    }
  >;
  highQualitySurcharge: number;
}

const DEFAULT_PRICING = {
  paperProfiles: {
    shortBond: {
      baseBwPrice: 3,
      baseColorPrice: 18,
      baseImagePrice: 25,
      baseImageBwPrice: 10,
    },
    a4: {
      baseBwPrice: 3,
      baseColorPrice: 18,
      baseImagePrice: 25,
      baseImageBwPrice: 10,
    },
    longBond: {
      baseBwPrice: 4,
      baseColorPrice: 20,
      baseImagePrice: 30,
      baseImageBwPrice: 12,
    },
  },
  highQualitySurcharge: 2,
} satisfies PublicPricingConfig;

const PAPER_LABELS = {
  shortBond: 'Short Bond Paper',
  a4: 'A4 Bond Paper',
  longBond: 'Long Bond Paper',
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
    baseImagePrice: safeAmount(
      profiles?.[key]?.baseImagePrice,
      DEFAULT_PRICING.paperProfiles[key].baseImagePrice,
    ),
    baseImageBwPrice: safeAmount(
      profiles?.[key]?.baseImageBwPrice,
      DEFAULT_PRICING.paperProfiles[key].baseImageBwPrice,
    ),
  });

  return {
    paperProfiles: {
      shortBond: profileFor('shortBond'),
      a4: profileFor('a4'),
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
      return `<tr><th scope="row">${PAPER_LABELS[key]}</th><td>${formatPeso(profile.baseBwPrice)}</td><td>${formatPeso(profile.baseColorPrice)}</td><td>${formatPeso(profile.baseImagePrice)}</td><td>${formatPeso(profile.baseImageBwPrice)}</td></tr>`;
    })
    .join('');

  return `<table class="pricing-table"><caption>Base price per page</caption><thead><tr><th scope="col">Paper size</th><th scope="col">B&amp;W</th><th scope="col">Color</th><th scope="col">Photo (Color)</th><th scope="col">Photo (B&amp;W)</th></tr></thead><tbody>${rows}</tbody></table><p class="pricing-quality-note"><span class="pricing-quality-note__label">High quality</span>: +${formatPeso(pricing.highQualitySurcharge)} <span class="pricing-quality-note__unit">per page</span>.</p>`;
}

export const buildPricingTableHtml = formatPricingGuide;

export async function fetchPublicPricing(): Promise<PublicPricingConfig> {
  const response = await fetch('/api/pricing-config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to load printing prices.');
  return normalizePricingConfig(await response.json());
}
