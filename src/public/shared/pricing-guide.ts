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
  duplexEnabled?: boolean;
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
  duplexEnabled: false,
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
    duplexEnabled:
      typeof candidate?.duplexEnabled === 'boolean'
        ? candidate.duplexEnabled
        : DEFAULT_PRICING.duplexEnabled ?? false,
  };
}

export function formatPeso(amount: number): string {
  return `₱${amount}`;
}

export function formatPricingGuide(pricing: PublicPricingConfig): string {
  const rows = (Object.keys(PAPER_LABELS) as PaperProfileKey[])
    .map((key) => {
      const profile = pricing.paperProfiles[key];
      return `<tr class="pricing-row--first"><th scope="row" rowspan="2" class="pricing-cell--paper">${PAPER_LABELS[key]}</th><td rowspan="2" class="pricing-cell--sheet"><span class="pricing-sheet-badge">${formatPeso(profile.paperCost)}</span></td><td class="pricing-cell--mode"><span class="pricing-mode-pill pricing-mode-pill--bw">B&amp;W</span></td><td>${formatPeso(profile.bwPrint.low)}</td><td>${formatPeso(profile.bwPrint.medium)}</td><td>${formatPeso(profile.bwPrint.high)}</td><td>${formatPeso(profile.bwPrint.very_high)}</td></tr><tr class="pricing-row--second"><td class="pricing-cell--mode"><span class="pricing-mode-pill pricing-mode-pill--color">Color</span></td><td class="pricing-cell--color-val">${formatPeso(profile.colorPrint.low)}</td><td class="pricing-cell--color-val">${formatPeso(profile.colorPrint.medium)}</td><td class="pricing-cell--color-val">${formatPeso(profile.colorPrint.high)}</td><td class="pricing-cell--color-val">${formatPeso(profile.colorPrint.very_high)}</td></tr>`;
    })
    .join('');

  const duplexNote = pricing.duplexEnabled
    ? `<span class="pricing-note-pill pricing-duplex-note"><strong>Duplex Savings:</strong> 2-sided printing saves 1 sheet per 2 pages!</span>`
    : '';

  return `<div class="pricing-table-wrap"><table class="pricing-table"><caption>Paper &amp; Print Pricing per Page</caption><thead><tr><th scope="col">Paper size</th><th scope="col">Bond Paper (sheet)</th><th scope="col">Print Mode</th><th scope="col">Low (0% - 10%)</th><th scope="col">Medium (11% - 40%)</th><th scope="col">High (41% - 70%)</th><th scope="col">Max (71% - 100%)</th></tr></thead><tbody>${rows}</tbody></table></div><div class="pricing-guide-footer"><div class="pricing-tier-strip"><span class="pricing-tier-tag"><span class="pricing-tier-tag__dot pricing-tier-tag__dot--low"></span><strong>Low (0% - 10%)</strong>: Text, forms</span><span class="pricing-tier-tag"><span class="pricing-tier-tag__dot pricing-tier-tag__dot--med"></span><strong>Medium (11% - 40%)</strong>: Diagrams</span><span class="pricing-tier-tag"><span class="pricing-tier-tag__dot pricing-tier-tag__dot--high"></span><strong>High (41% - 70%)</strong>: Charts</span><span class="pricing-tier-tag"><span class="pricing-tier-tag__dot pricing-tier-tag__dot--max"></span><strong>Max (71% - 100%)</strong>: Photos</span></div><div class="pricing-notes-bar"><span class="pricing-note-pill pricing-paper-note"><strong>Bond Paper Costing:</strong> ${formatPeso(pricing.paperProfiles.a4.paperCost)}/sheet for all sizes</span>${duplexNote}<span class="pricing-note-pill pricing-quality-note"><span class="pricing-quality-note__label">High quality</span>: +${formatPeso(pricing.highQualitySurcharge)} <span class="pricing-quality-note__unit">per page</span></span></div></div>`;
}

export const buildPricingTableHtml = formatPricingGuide;

export async function fetchPublicPricing(): Promise<PublicPricingConfig> {
  const response = await fetch('/api/pricing-config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to load printing prices.');
  return normalizePricingConfig(await response.json());
}
