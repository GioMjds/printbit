export interface NavBadgeResult {
  rawCount: number;
  label: string;
  visible: boolean;
}

export function computeTotalNavBadge(
  openAlerts: number,
  openReports: number,
  openFeedback: number,
): NavBadgeResult {
  const total = Math.max(0, openAlerts) + Math.max(0, openReports) + Math.max(0, openFeedback);
  if (total === 0) {
    return { rawCount: 0, label: '', visible: false };
  }
  if (total > 9) {
    return { rawCount: total, label: '9+', visible: true };
  }
  return { rawCount: total, label: String(total), visible: true };
}


export interface DrawerOptions {
  drawerEl: HTMLElement;
  scrimEl: HTMLElement;
  triggerEl?: HTMLElement | null;
}

export class DrawerController {
  private drawerEl: HTMLElement;
  private scrimEl: HTMLElement;
  private triggerEl?: HTMLElement | null;
  private openState: boolean = false;
  private touchStartX: number = 0;
  private touchStartY: number = 0;

  private onScrimClick = (): void => {
    this.close();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.openState) {
      this.close();
      this.triggerEl?.focus();
    }
  };

  private onTouchStart = (e: TouchEvent): void => {
    if (!this.openState) return;
    const touch = e.touches[0];
    if (touch) {
      this.touchStartX = touch.clientX;
      this.touchStartY = touch.clientY;
    }
  };

  private onTouchEnd = (e: TouchEvent): void => {
    if (!this.openState) return;
    const touch = e.changedTouches[0];
    if (touch) {
      const dx = touch.clientX - this.touchStartX;
      const dy = Math.abs(touch.clientY - this.touchStartY);
      if (dx < -45 && dy < 60) {
        this.close();
      }
    }
  };

  constructor(options: DrawerOptions) {
    this.drawerEl = options.drawerEl;
    this.scrimEl = options.scrimEl;
    this.triggerEl = options.triggerEl;

    this.scrimEl.addEventListener('click', this.onScrimClick);
    window.addEventListener('keydown', this.onKeyDown);
    this.drawerEl.addEventListener('touchstart', this.onTouchStart, { passive: true });
    this.drawerEl.addEventListener('touchend', this.onTouchEnd, { passive: true });
  }

  public isOpen(): boolean {
    return this.openState;
  }

  public open(): void {
    this.openState = true;
    this.drawerEl.classList.add('is-open');
    this.scrimEl.classList.remove('hidden');
    this.drawerEl.setAttribute('aria-hidden', 'false');
  }

  public close(): void {
    this.openState = false;
    this.drawerEl.classList.remove('is-open');
    this.scrimEl.classList.add('hidden');
    this.drawerEl.setAttribute('aria-hidden', 'true');
  }

  public toggle(): void {
    if (this.openState) {
      this.close();
    } else {
      this.open();
    }
  }

  public destroy(): void {
    this.scrimEl.removeEventListener('click', this.onScrimClick);
    window.removeEventListener('keydown', this.onKeyDown);
    this.drawerEl.removeEventListener('touchstart', this.onTouchStart);
    this.drawerEl.removeEventListener('touchend', this.onTouchEnd);
  }
}
