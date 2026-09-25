export type PaperProfileKey = 'a4' | 'shortBond' | 'longBond';
export type CoverageTier = 'low' | 'medium' | 'high' | 'very_high';
export type CoverageTierRates = Record<CoverageTier, number>;

export interface PublicPaperPricingProfile {
  paperCost: number;
  bwPrint: CoverageTierRates;
  colorPrint: CoverageTierRates;
}

export interface PublicPricingConfig {
  paperProfiles: Record<PaperProfileKey, PublicPaperPricingProfile>;
  highQualitySurcharge: number;
}

const DEFAULT_PRICING: PublicPricingConfig = {
  paperProfiles: {
    shortBond: {
      paperCost: 1,
      bwPrint: { low: 2, medium: 3, high: 6, very_high: 9 },
      colorPrint: { low: 17, medium: 19, high: 24, very_high: 29 },
    },
    a4: {
      paperCost: 1,
      bwPrint: { low: 2, medium: 3, high: 6, very_high: 9 },
      colorPrint: { low: 17, medium: 19, high: 24, very_high: 29 },
    },
    longBond: {
      paperCost: 1,
      bwPrint: { low: 3, medium: 4, high: 8, very_high: 11 },
      colorPrint: { low: 19, medium: 22, high: 29, very_high: 34 },
    },
  },
  highQualitySurcharge: 2,
};

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
  const candidate = raw as any;
  const profiles = candidate?.paperProfiles;

  const profileFor = (key: PaperProfileKey): PublicPaperPricingProfile => {
    const rawProfile = profiles?.[key];
    const fallback = DEFAULT_PRICING.paperProfiles[key];

    if (!rawProfile || typeof rawProfile !== 'object') {
      return fallback;
    }

    // Check if new tiered format
    if (
      'paperCost' in rawProfile ||
      'bwPrint' in rawProfile ||
      'colorPrint' in rawProfile
    ) {
      return {
        paperCost: safeAmount(rawProfile.paperCost, fallback.paperCost),
        bwPrint: {
          low: safeAmount(rawProfile.bwPrint?.low, fallback.bwPrint.low),
          medium: safeAmount(
            rawProfile.bwPrint?.medium,
            fallback.bwPrint.medium,
          ),
          high: safeAmount(rawProfile.bwPrint?.high, fallback.bwPrint.high),
          very_high: safeAmount(
            rawProfile.bwPrint?.very_high,
            fallback.bwPrint.very_high,
          ),
        },
        colorPrint: {
          low: safeAmount(rawProfile.colorPrint?.low, fallback.colorPrint.low),
          medium: safeAmount(
            rawProfile.colorPrint?.medium,
            fallback.colorPrint.medium,
          ),
          high: safeAmount(
            rawProfile.colorPrint?.high,
            fallback.colorPrint.high,
          ),
          very_high: safeAmount(
            rawProfile.colorPrint?.very_high,
            fallback.colorPrint.very_high,
          ),
        },
      };
    }

    // Legacy fallback format
    const baseBwPrice = safeAmount(rawProfile.baseBwPrice, 3);
    const baseColorPrice = safeAmount(rawProfile.baseColorPrice, 18);
    const baseImagePrice = safeAmount(rawProfile.baseImagePrice, 25);
    const baseImageBwPrice = safeAmount(rawProfile.baseImageBwPrice, 10);

    return {
      paperCost: 1,
      bwPrint: {
        low: Math.max(0, baseBwPrice - 1),
        medium: baseBwPrice,
        high: Math.max(0, baseImageBwPrice - 1),
        very_high: baseImageBwPrice,
      },
      colorPrint: {
        low: Math.max(0, baseColorPrice - 1),
        medium: baseColorPrice + 1,
        high: Math.max(0, baseImagePrice - 1),
        very_high: baseImagePrice + 4,
      },
    };
  };

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
      return `<tr><th scope="row">${PAPER_LABELS[key]}</th><td>${formatPeso(profile.paperCost)}</td><td>${formatPeso(profile.bwPrint.low)}</td><td>${formatPeso(profile.bwPrint.very_high)}</td><td>${formatPeso(profile.colorPrint.low)}</td><td>${formatPeso(profile.colorPrint.very_high)}</td></tr>`;
    })
    .join('');

  return `<table class="pricing-table"><caption>Paper &amp; Print Pricing per Page</caption><thead><tr><th scope="col">Paper size</th><th scope="col">Paper (sheet)</th><th scope="col">B&amp;W (Low)</th><th scope="col">B&amp;W (Photo)</th><th scope="col">Color (Low)</th><th scope="col">Color (Photo)</th></tr></thead><tbody>${rows}</tbody></table><p class="pricing-tier-note"><strong>Print Tiers:</strong> Metered by ink coverage (Low: text &bull; Medium: charts/logos &bull; High: graphics &bull; Max: full photos).</p><p class="pricing-duplex-note"><strong>Duplex Savings:</strong> 2-sided printing uses 1 physical sheet for 2 pages, saving paper cost!</p><p class="pricing-quality-note"><span class="pricing-quality-note__label">High quality</span>: +${formatPeso(pricing.highQualitySurcharge)} <span class="pricing-quality-note__unit">per page</span>.</p>`;
}

export const buildPricingTableHtml = formatPricingGuide;

export async function fetchPublicPricing(): Promise<PublicPricingConfig> {
  const response = await fetch('/api/pricing-config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to load printing prices.');
  return normalizePricingConfig(await response.json());
}
