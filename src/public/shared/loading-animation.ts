import { DotLottie } from '@lottiefiles/dotlottie-web';

export type LoadingAnimationMode = 'print' | 'copy' | 'scan' | 'upload';

const DOTLOTTIE_WASM_URL = '/vendor/dotlottie/dotlottie-player.wasm';
const REDUCED_MOTION_FRAME = 28;

const LOADING_ANIMATION_ASSETS: Record<LoadingAnimationMode, string> = {
  print: '/assets/lottie/printing.lottie',
  copy: '/assets/lottie/copying.lottie',
  scan: '/assets/lottie/scanning.lottie',
  upload: '/assets/lottie/upload.lottie',
};

DotLottie.setWasmUrl(DOTLOTTIE_WASM_URL);

interface LoadingAnimationRoot {
  classList: Pick<DOMTokenList, 'add' | 'remove' | 'toggle'>;
}

interface LoadingAnimationPlayer {
  addEventListener(
    type: 'load' | 'loadError' | 'renderError',
    listener: () => void,
  ): void;
  removeEventListener(
    type: 'load' | 'loadError' | 'renderError',
    listener: () => void,
  ): void;
  play(): void;
  pause(): void;
  setFrame(frame: number): void;
  destroy(): void;
}

interface MotionQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

interface PageDocument {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

interface PlayerConfig {
  canvas: HTMLCanvasElement;
  src: string;
  autoplay: boolean;
  loop: boolean;
  layout: {
    fit: 'contain';
    align: [number, number];
  };
}

interface LoadingAnimationDependencies {
  createPlayer?: (config: PlayerConfig) => LoadingAnimationPlayer;
  motionQuery?: MotionQuery;
  pageDocument?: PageDocument;
}

export interface LoadingAnimationController {
  setActive(active: boolean): void;
  destroy(): void;
}

export function resolveLoadingAnimationAsset(mode: unknown): string {
  if (mode === 'copy' || mode === 'scan' || mode === 'upload') {
    return LOADING_ANIMATION_ASSETS[mode];
  }

  return LOADING_ANIMATION_ASSETS.print;
}

export function mountLoadingAnimation(
  options: {
    root: LoadingAnimationRoot;
    canvas: HTMLCanvasElement;
    mode: unknown;
    active?: boolean;
  },
  dependencies: LoadingAnimationDependencies = {},
): LoadingAnimationController {
  const motionQuery =
    dependencies.motionQuery ??
    window.matchMedia('(prefers-reduced-motion: reduce)');
  const pageDocument = dependencies.pageDocument ?? document;
  const createPlayer =
    dependencies.createPlayer ??
    ((config: PlayerConfig) =>
      new DotLottie(config) as unknown as LoadingAnimationPlayer);

  let active = options.active ?? false;
  let loaded = false;
  let destroyed = false;

  options.root.classList.remove('is-lottie-ready');
  options.root.classList.add('is-lottie-fallback');

  let player: LoadingAnimationPlayer;
  try {
    player = createPlayer({
      canvas: options.canvas,
      src: resolveLoadingAnimationAsset(options.mode),
      autoplay: false,
      loop: true,
      layout: { fit: 'contain', align: [0.5, 0.5] },
    });
  } catch {
    return {
      setActive(): void {},
      destroy(): void {},
    };
  }

  const syncPlayback = (): void => {
    if (!loaded || destroyed) return;

    const reduceMotion = motionQuery.matches;
    options.root.classList.toggle('is-reduced-motion', reduceMotion);

    if (reduceMotion) {
      player.pause();
      player.setFrame(REDUCED_MOTION_FRAME);
      return;
    }

    if (active && !pageDocument.hidden) {
      player.play();
    } else {
      player.pause();
    }
  };

  const showLottie = (): void => {
    loaded = true;
    options.root.classList.remove('is-lottie-fallback');
    options.root.classList.add('is-lottie-ready');
    syncPlayback();
  };

  const showFallback = (): void => {
    loaded = false;
    options.root.classList.remove('is-lottie-ready');
    options.root.classList.add('is-lottie-fallback');
    player.pause();
  };

  player.addEventListener('load', showLottie);
  player.addEventListener('loadError', showFallback);
  player.addEventListener('renderError', showFallback);
  motionQuery.addEventListener('change', syncPlayback);
  pageDocument.addEventListener('visibilitychange', syncPlayback);

  return {
    setActive(nextActive: boolean): void {
      active = nextActive;
      syncPlayback();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      motionQuery.removeEventListener('change', syncPlayback);
      pageDocument.removeEventListener('visibilitychange', syncPlayback);
      player.removeEventListener('load', showLottie);
      player.removeEventListener('loadError', showFallback);
      player.removeEventListener('renderError', showFallback);
      player.destroy();
    },
  };
}
