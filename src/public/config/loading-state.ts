import { DotLottie } from '@lottiefiles/dotlottie-web';

export type ConfigPreparationState = 'preparing' | 'ready' | 'error';

export interface ConfigPreparationLoadingController {
  start(message?: string): void;
  setMessage(message: string, detail?: string): void;
  finish(): void;
  fail(message?: string): void;
  destroy(): void;
}

interface ControllerOptions {
  setContinueEnabled: (enabled: boolean) => void;
}

const DEFAULT_TITLE = 'Preparing document';
const DEFAULT_DETAIL = 'Building your print preview…';
const DOTLOTTIE_WASM_URL = '/vendor/dotlottie/dotlottie-player.wasm';
const DOTLOTTIE_ASSET_URL = '/config/assets/document-preparing.lottie';

export function createConfigPreparationLoadingController(
  options: ControllerOptions,
): ConfigPreparationLoadingController {
  const layout = document.getElementById('configLayout');
  const preparing = document.getElementById('configPreparing');
  const canvas = document.getElementById(
    'configPreparingAnimation',
  ) as HTMLCanvasElement | null;
  const status = document.getElementById('configPreparingStatus');
  const detail = document.getElementById('configPreparingDetail');
  const paperLoading = document.getElementById('paperLoading');
  const stageBadge = document.getElementById('assuranceStageBadge');
  const pipeStep1 = document.getElementById('pipeStep1');
  const pipeStep2 = document.getElementById('pipeStep2');
  const pipeStep3 = document.getElementById('pipeStep3');
  const pipeText1 = document.getElementById('pipeText1');
  const pipeText2 = document.getElementById('pipeText2');
  const pipeText3 = document.getElementById('pipeText3');

  const interactionLocks = [
    document.getElementById('configSettings'),
    document.getElementById('previewControls'),
    document.querySelector<HTMLElement>('.zoom-controls'),
  ].filter((element): element is HTMLElement => element !== null);
  const reducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  ).matches;

  let state: ConfigPreparationState = 'ready';
  let animation: DotLottie | null = null;
  let interactionsLocked = false;
  const priorInertStates = new Map<HTMLElement, boolean>();

  const showFallback = (): void => {
    preparing?.setAttribute('data-lottie-unavailable', '');
  };

  const ensureAnimation = (): void => {
    if (reducedMotion || !canvas) {
      showFallback();
      return;
    }
    if (animation) return;

    try {
      DotLottie.setWasmUrl(DOTLOTTIE_WASM_URL);
      animation = new DotLottie({
        canvas,
        src: DOTLOTTIE_ASSET_URL,
        autoplay: true,
        loop: true,
      });
      animation.addEventListener('loadError', showFallback);
      animation.addEventListener('renderError', showFallback);
    } catch (error) {
      console.warn(
        '[CONFIG PREPARING] DotLottie unavailable, using CSS fallback',
        error,
      );
      showFallback();
    }
  };

  const updatePipeline = (msg: string, dtl?: string): void => {
    const combined = `${msg} ${dtl ?? ''}`.toLowerCase();
    if (stageBadge) {
      if (combined.includes('copy')) {
        stageBadge.textContent = 'Copy Mode • Scanner Preload';
        if (pipeText1) pipeText1.textContent = 'Scanner Ready';
        if (pipeText2) pipeText2.textContent = 'Calibrating Exposure';
        if (pipeText3) pipeText3.textContent = 'Building Copy Preview';
      } else if (combined.includes('scan')) {
        stageBadge.textContent = 'Scan Mode • Document Capture';
        if (pipeText1) pipeText1.textContent = 'Feeder Initialized';
        if (pipeText2) pipeText2.textContent = 'Capturing Stream';
        if (pipeText3) pipeText3.textContent = 'Building Mobile Preview';
      } else if (combined.includes('convert')) {
        stageBadge.textContent = 'Document Conversion • Preloading';
        if (pipeText1) pipeText1.textContent = 'Source Document Read';
        if (pipeText2) pipeText2.textContent = 'Vector PDF Conversion';
        if (pipeText3) pipeText3.textContent = 'Calibrating Print Preview';
      } else {
        stageBadge.textContent = 'Job Processing • Preloading Print';
        if (pipeText1) pipeText1.textContent = 'Document Verified';
        if (pipeText2) pipeText2.textContent = 'Analyzing Color & Ink';
        if (pipeText3) pipeText3.textContent = 'Calibrating Preview';
      }
    }
    if (pipeStep1 && pipeStep2 && pipeStep3) {
      pipeStep1.className = 'pipeline-step pipeline-step--done';
      pipeStep2.className = 'pipeline-step pipeline-step--active';
      pipeStep3.className = 'pipeline-step';
    }
  };

  const setState = (nextState: ConfigPreparationState): void => {
    state = nextState;
    layout?.setAttribute('data-preparation-state', nextState);
    layout?.setAttribute(
      'aria-busy',
      nextState === 'preparing' ? 'true' : 'false',
    );
  };

  const lockInteractions = (): void => {
    if (interactionsLocked) return;
    interactionsLocked = true;
    interactionLocks.forEach((element) => {
      priorInertStates.set(element, element.inert);
      element.inert = true;
    });
  };

  const unlockInteractions = (): void => {
    if (!interactionsLocked) return;
    interactionsLocked = false;
    interactionLocks.forEach((element) => {
      element.inert = priorInertStates.get(element) ?? false;
    });
    priorInertStates.clear();
  };

  return {
    start(message = DEFAULT_TITLE): void {
      setState('preparing');
      lockInteractions();
      if (status) status.textContent = message;
      if (detail) detail.textContent = DEFAULT_DETAIL;
      updatePipeline(message, DEFAULT_DETAIL);
      paperLoading?.classList.remove('hidden');
      options.setContinueEnabled(false);
      ensureAnimation();
    },

    setMessage(message: string, nextDetail = DEFAULT_DETAIL): void {
      if (status) status.textContent = message;
      if (detail) detail.textContent = nextDetail;
      updatePipeline(message, nextDetail);
    },

    finish(): void {
      if (state !== 'error') setState('ready');
      unlockInteractions();
      if (pipeStep2 && pipeStep3) {
        pipeStep2.className = 'pipeline-step pipeline-step--done';
        pipeStep3.className = 'pipeline-step pipeline-step--done';
      }
      paperLoading?.classList.add('hidden');
      animation?.pause();
    },

    fail(message = 'Preview unavailable'): void {
      setState('error');
      unlockInteractions();
      if (status) status.textContent = message;
      if (pipeStep2 && pipeStep3) {
        pipeStep2.className = 'pipeline-step pipeline-step--error';
        pipeStep3.className = 'pipeline-step';
      }
      paperLoading?.classList.add('hidden');
      animation?.pause();
    },

    destroy(): void {
      animation?.destroy();
      animation = null;
    },
  };
}
