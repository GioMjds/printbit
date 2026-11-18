import { existsSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('@lottiefiles/dotlottie-web', () => ({
  DotLottie: { setWasmUrl: jest.fn() },
}));

import {
  resolveLoadingAnimationAsset,
  type LoadingAnimationMode,
} from './loading-animation';

const PUBLIC_DIR = join(__dirname, '..');
const fileFor = (url: string): string => join(PUBLIC_DIR, ...url.split('/'));

const MODES: LoadingAnimationMode[] = [
  'print',
  'copy',
  'copy-glass',
  'copy-adf',
  'scan',
  'upload',
  'receive-files',
  'place-glass',
  'place-id',
  'place-adf',
];

describe('loading animation assets', () => {
  it('ships a distinct animation file for every mode', () => {
    const urls = MODES.map(resolveLoadingAnimationAsset);
    for (const url of urls) expect(existsSync(fileFor(url))).toBe(true);
    expect(new Set(urls).size).toBe(MODES.length);
  });

  it('falls back to the print animation for unknown or inherited keys', () => {
    const print = resolveLoadingAnimationAsset('print');
    expect(resolveLoadingAnimationAsset('nope')).toBe(print);
    expect(resolveLoadingAnimationAsset('toString')).toBe(print);
    expect(resolveLoadingAnimationAsset(undefined)).toBe(print);
  });
});
