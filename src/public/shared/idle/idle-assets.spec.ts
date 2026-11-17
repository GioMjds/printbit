import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDLE_SLIDES } from './idle-slides';

const PUBLIC_DIR = join(__dirname, '..', '..');
const fileFor = (url: string): string => join(PUBLIC_DIR, ...url.split('/'));

describe('idle slide assets', () => {
  it('ships an animation and a poster for every slide', () => {
    for (const slide of IDLE_SLIDES) {
      expect(existsSync(fileFor(slide.src))).toBe(true);
      expect(existsSync(fileFor(slide.poster))).toBe(true);
    }
  });

  it('gives every slide its own animation', () => {
    const owners = new Map<string, string>();
    for (const slide of IDLE_SLIDES) {
      const hash = createHash('sha256')
        .update(readFileSync(fileFor(slide.src)))
        .digest('hex');
      expect(owners.get(hash) ?? slide.id).toBe(slide.id);
      owners.set(hash, slide.id);
    }
  });
});
