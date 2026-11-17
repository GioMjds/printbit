import { DotLottie } from '@lottiefiles/dotlottie-web';
import { adaptDotLottie, type DotLottieLike } from './idle-dotlottie-adapter';
import { IDLE_LOTTIE_RENDER_CONFIG, type IdleLottiePlayer } from './idle-lottie';

const DOTLOTTIE_WASM_URL = '/vendor/dotlottie/dotlottie-player.wasm';

/** Creates the real DotLottie player behind the idle stage's interface. */
export function createDotLottiePlayer(
  canvas: HTMLCanvasElement,
): IdleLottiePlayer {
  DotLottie.setWasmUrl(DOTLOTTIE_WASM_URL);
  const player = new DotLottie({
    canvas,
    autoplay: false,
    loop: false,
    renderConfig: IDLE_LOTTIE_RENDER_CONFIG,
  });
  const like: DotLottieLike = {
    load: (config) => player.load(config),
    setFrame: (frame) => player.setFrame(frame),
    addEventListener: (type, listener) =>
      player.addEventListener(type, () => listener()),
    get totalFrames() {
      return player.totalFrames;
    },
    get duration() {
      return player.duration;
    },
    destroy: () => player.destroy(),
  };
  return adaptDotLottie(like);
}

export async function fetchLottieAsset(src: string): Promise<ArrayBuffer> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Lottie slot ${src}: ${response.status}`);
  return response.arrayBuffer();
}
