export const COLOR_SATURATION_THRESHOLD = 0.05;
export const COLOR_PAGE_COVERAGE_THRESHOLD = 0.05;
export const FULL_COLOR_PAGE_COVERAGE_THRESHOLD = 0.95;
/**
 * A page is blank when less than this share of its sampled pixels has ink.
 *
 * Measured on an A4 page rendered at PDF_RENDER_SCALE (about 125,000 pixels):
 * an empty page is 0, a single stray pixel is 0.0008%, a 9 pt page number "1"
 * is 0.0024%, and a 12 pt "Hello world" is 0.065%. The old value of 0.1%
 * called all of these blank, which blocked short documents as "entirely
 * blank". This value only treats a page with no ink (or one stray pixel) as
 * blank.
 */
export const MIN_CONTENT_COVERAGE_THRESHOLD = 0.00001;
/** Scale PDF pages are rendered at for coverage and color metering. */
export const PDF_RENDER_SCALE = 0.5;
export const MAX_PIXELS_TO_SAMPLE = 200_000;
