import { renderCoinList } from '../coin-strip';
import { IDLE_UI_TEXT, type IdleLang, type IdleSlideText } from './idle-copy';

export interface IdleViewElements {
  overlay: HTMLElement;
  clockTime: HTMLElement;
  clockDate: HTMLElement;
  slide: HTMLElement;
  canvas: HTMLCanvasElement;
  poster: HTMLImageElement;
  eyebrow: HTMLElement;
  title: HTMLElement;
  body: HTMLElement;
  steps: HTMLElement;
  coins: HTMLElement;
  progressBar: HTMLElement;
  cta: HTMLElement;
}

export function queryIdleViewElements(
  root: HTMLElement,
): IdleViewElements | null {
  const hook = <T extends Element>(name: string): T | null =>
    root.querySelector<T>(`[data-idle="${name}"]`);
  const els = {
    overlay: root,
    clockTime: hook<HTMLElement>('clock-time'),
    clockDate: hook<HTMLElement>('clock-date'),
    slide: hook<HTMLElement>('slide'),
    canvas: hook<HTMLCanvasElement>('canvas'),
    poster: hook<HTMLImageElement>('poster'),
    eyebrow: hook<HTMLElement>('eyebrow'),
    title: hook<HTMLElement>('title'),
    body: hook<HTMLElement>('body'),
    steps: hook<HTMLElement>('steps'),
    coins: hook<HTMLElement>('coins'),
    progressBar: hook<HTMLElement>('progress'),
    cta: hook<HTMLElement>('cta'),
  };
  return Object.values(els).every(Boolean) ? (els as IdleViewElements) : null;
}

export interface IdleViewOptions {
  reducedMotion: boolean;
  fadeMs?: number;
}

/** Owns every DOM write and the short-lived fade and step timers. */
export class IdleView {
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private stepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly els: IdleViewElements,
    private readonly opts: IdleViewOptions,
  ) {}

  showSlide(text: IdleSlideText, durationMs: number, onSwap: () => void): void {
    this.clearTimers();
    const swap = (): void => {
      this.fadeTimer = null;
      this.writeText(text);
      onSwap();
      this.els.slide.classList.remove('is-fading');
      this.restartProgress(durationMs);
      this.startSteps(text, durationMs);
    };
    if (this.opts.reducedMotion) {
      swap();
      return;
    }
    this.els.slide.classList.add('is-fading');
    this.fadeTimer = setTimeout(swap, this.opts.fadeMs ?? 220);
  }

  renderLanguage(lang: IdleLang): void {
    const ui = IDLE_UI_TEXT[lang];
    this.els.cta.textContent = ui.cta;
    this.els.overlay.setAttribute('aria-label', ui.overlayLabel);
  }

  renderClock(now: Date, lang: IdleLang): void {
    const locale = lang === 'fil' ? 'fil-PH' : 'en-PH';
    this.els.clockTime.textContent = now.toLocaleTimeString(locale, {
      hour: 'numeric',
      minute: '2-digit',
    });
    this.els.clockDate.textContent = now.toLocaleDateString(locale, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
  }

  stop(): void {
    this.clearTimers();
    this.els.slide.classList.remove('is-fading');
  }

  private writeText(text: IdleSlideText): void {
    this.els.eyebrow.textContent = text.eyebrow;
    this.els.title.textContent = text.title;
    this.els.body.textContent = text.body;
    this.els.steps.dataset.stepped = String(text.stepped);
    this.els.steps.replaceChildren(
      ...text.lines.map((line) => {
        const item = document.createElement('li');
        item.className = 'idle-step';
        item.textContent = line;
        return item;
      }),
    );
    renderCoinList(this.els.coins, text.coins ?? []);
  }

  private restartProgress(durationMs: number): void {
    const bar = this.els.progressBar;
    // Inline !important beats the kiosk-static `transition: none !important`.
    bar.style.setProperty('transition', 'none', 'important');
    bar.style.transform = 'scaleX(0)';
    void bar.offsetWidth;
    if (this.opts.reducedMotion) return;
    bar.style.setProperty(
      'transition',
      `transform ${durationMs}ms linear`,
      'important',
    );
    bar.style.transform = 'scaleX(1)';
  }

  private startSteps(text: IdleSlideText, durationMs: number): void {
    if (!text.stepped) return;
    const items = Array.from(this.els.steps.children);
    if (items.length === 0) return;
    let index = 0;
    items[0].classList.add('is-current');
    this.stepTimer = setInterval(
      () => {
        items[index].classList.remove('is-current');
        index = (index + 1) % items.length;
        items[index].classList.add('is-current');
      },
      Math.max(1000, Math.floor(durationMs / items.length)),
    );
  }

  private clearTimers(): void {
    if (this.fadeTimer !== null) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
    if (this.stepTimer !== null) {
      clearInterval(this.stepTimer);
      this.stepTimer = null;
    }
  }
}
