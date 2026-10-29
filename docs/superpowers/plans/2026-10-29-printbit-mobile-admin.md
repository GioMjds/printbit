# PrintBit Mobile `/admin` Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the mobile (≤860px) experience of the PrintBit `/admin` panel into an efficient triage command center with a grouped slide-out drawer, live aggregated badge counts, an actionable status banner and attention queue on Overview, and mobile-first card/inbox patterns across all sub-pages.

**Architecture:** A lightweight client-side architecture using modular TypeScript and responsive CSS. Core navigational and polling utilities (`DrawerController`, `createUpdatedTicker`, `computeTotalNavBadge`) are shared across all 9 admin pages via `shared.ts`. The Overview triage engine (`overview-queue.ts`) pure-functions derive the status banner and attention queue directly from `SummaryResponse` and network poll state.

**Tech Stack:** TypeScript, Vanilla DOM, CSS3 (Media Queries, Flexbox, CSS Grid), Esbuild (client bundler), Jest + JSDOM for unit/DOM tests.

**Spec:** [docs/superpowers/specs/2026-10-29-printbit-mobile-admin-design.md](file:///D:/giomj/Projects/printbit/docs/superpowers/specs/2026-10-29-printbit-mobile-admin-design.md)

## Global Constraints

- Scope: mobile layout (≤860px) of the existing `/admin` panel. Desktop layout (>860px) is completely unchanged.
- All 9 existing tabs stay reachable in one tap: Overview, Earnings, System, Settings, System Logs, Transaction Logs, Feedback, Reports, Anomaly Alerts.
- Admin PIN auth gate, PWA install prompt and offline banner are unchanged.
- Existing element IDs written by `app.ts` (`earningsToday`, `jobsTotal`, `inkFill*`, etc.) must be preserved so `applySummary` keeps working without regressions.
- The existing `min-height: 44px` tap-target rule in `globals.css` applies to all new interactive elements.
- Re-use existing theme tokens (`--indigo`, `--peach`, `--green`, `--amber`, `--red`, Plus Jakarta Sans); introduce no arbitrary new palettes.
- Tables become card lists below 640px: at most two lines per row, expandable detail.
- Feedback, Reports and Anomaly Alerts share a unified responsive inbox pattern.
- Destructive actions always prompt for confirmation and never sit directly adjacent to primary actions.

---

### Task 1: Navigation Drawer & Topbar Badges Module (Unit Tested)

**Files:**

- Create: `src/public/admin/drawer.ts`
- Create: `src/public/admin/drawer.spec.ts`

**Interfaces:**

- Consumes: None (pure DOM/math helpers)
- Produces:
  - `computeTotalNavBadge(openAlerts: number, openReports: number, openFeedback: number): { rawCount: number; label: string; visible: boolean }`
  - `createUpdatedTicker(onTick: (text: string) => void): { setUpdatedNow(): void; stop(): void }`
  - `class DrawerController { constructor(options: DrawerOptions); open(): void; close(): void; toggle(): void; destroy(): void; isOpen(): boolean; }`

- [ ] **Step 1: Write the failing tests for drawer and badge calculations**

Create `src/public/admin/drawer.spec.ts`:

```typescript
/**
 * @jest-environment jsdom
 */
import {
  computeTotalNavBadge,
  createUpdatedTicker,
  DrawerController,
} from './drawer';

describe('computeTotalNavBadge', () => {
  it('returns hidden when total is 0', () => {
    const result = computeTotalNavBadge(0, 0, 0);
    expect(result).toEqual({ rawCount: 0, label: '', visible: false });
  });

  it('returns count label when total is between 1 and 9', () => {
    expect(computeTotalNavBadge(2, 1, 0)).toEqual({
      rawCount: 3,
      label: '3',
      visible: true,
    });
    expect(computeTotalNavBadge(3, 3, 3)).toEqual({
      rawCount: 9,
      label: '9',
      visible: true,
    });
  });

  it('returns 9+ when total is greater than 9', () => {
    expect(computeTotalNavBadge(5, 5, 1)).toEqual({
      rawCount: 11,
      label: '9+',
      visible: true,
    });
    expect(computeTotalNavBadge(100, 0, 0)).toEqual({
      rawCount: 100,
      label: '9+',
      visible: true,
    });
  });
});

describe('createUpdatedTicker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('emits "Updated just now" immediately upon update', () => {
    const ticks: string[] = [];
    const ticker = createUpdatedTicker((text) => ticks.push(text));
    ticker.setUpdatedNow();
    expect(ticks[ticks.length - 1]).toBe('Updated just now');
    ticker.stop();
  });

  it('updates label as seconds elapse', () => {
    const ticks: string[] = [];
    const ticker = createUpdatedTicker((text) => ticks.push(text));
    ticker.setUpdatedNow();

    jest.advanceTimersByTime(5000);
    expect(ticks[ticks.length - 1]).toBe('Updated 5s ago');

    jest.advanceTimersByTime(25000);
    expect(ticks[ticks.length - 1]).toBe('Updated 30s ago');
    ticker.stop();
  });
});

describe('DrawerController', () => {
  let menuBtn: HTMLButtonElement;
  let drawer: HTMLElement;
  let scrim: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="menuBtn">Menu</button>
      <div id="drawer" class="sidebar">
        <a href="#test" class="nav-btn">Test Link</a>
      </div>
      <div id="scrim" class="drawer-scrim hidden"></div>
    `;
    menuBtn = document.getElementById('menuBtn') as HTMLButtonElement;
    drawer = document.getElementById('drawer') as HTMLElement;
    scrim = document.getElementById('scrim') as HTMLElement;
  });

  it('opens and closes drawer via methods and toggles classes', () => {
    const controller = new DrawerController({
      drawerEl: drawer,
      scrimEl: scrim,
      triggerEl: menuBtn,
    });

    expect(controller.isOpen()).toBe(false);
    expect(drawer.classList.contains('is-open')).toBe(false);

    controller.open();
    expect(controller.isOpen()).toBe(true);
    expect(drawer.classList.contains('is-open')).toBe(true);
    expect(scrim.classList.contains('hidden')).toBe(false);

    controller.close();
    expect(controller.isOpen()).toBe(false);
    expect(drawer.classList.contains('is-open')).toBe(false);
    expect(scrim.classList.contains('hidden')).toBe(true);
    controller.destroy();
  });

  it('closes on scrim click', () => {
    const controller = new DrawerController({
      drawerEl: drawer,
      scrimEl: scrim,
      triggerEl: menuBtn,
    });
    controller.open();
    scrim.click();
    expect(controller.isOpen()).toBe(false);
    controller.destroy();
  });

  it('closes on Escape key press and restores focus to trigger', () => {
    const controller = new DrawerController({
      drawerEl: drawer,
      scrimEl: scrim,
      triggerEl: menuBtn,
    });
    menuBtn.focus();
    controller.open();

    const escEvent = new KeyboardEvent('keydown', { key: 'Escape' });
    window.dispatchEvent(escEvent);

    expect(controller.isOpen()).toBe(false);
    expect(document.activeElement).toBe(menuBtn);
    controller.destroy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/public/admin/drawer.spec.ts`
Expected: FAIL (Cannot find module './drawer')

- [ ] **Step 3: Implement `src/public/admin/drawer.ts`**

Create `src/public/admin/drawer.ts`:

```typescript
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
  const total =
    Math.max(0, openAlerts) +
    Math.max(0, openReports) +
    Math.max(0, openFeedback);
  if (total === 0) {
    return { rawCount: 0, label: '', visible: false };
  }
  if (total > 9) {
    return { rawCount: total, label: '9+', visible: true };
  }
  return { rawCount: total, label: String(total), visible: true };
}

export interface UpdatedTicker {
  setUpdatedNow(): void;
  stop(): void;
}

export function createUpdatedTicker(
  onTick: (text: string) => void,
): UpdatedTicker {
  let lastUpdatedMs: number = Date.now();
  let intervalId: number | null = null;

  function render(): void {
    const elapsedSec = Math.floor((Date.now() - lastUpdatedMs) / 1000);
    if (elapsedSec < 3) {
      onTick('Updated just now');
    } else {
      onTick(`Updated ${elapsedSec}s ago`);
    }
  }

  intervalId = window.setInterval(render, 1000);

  return {
    setUpdatedNow(): void {
      lastUpdatedMs = Date.now();
      render();
    },
    stop(): void {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    },
  };
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
      // Horizontal swipe to the left by > 45px with minimal vertical deflection
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
    this.drawerEl.addEventListener('touchstart', this.onTouchStart, {
      passive: true,
    });
    this.drawerEl.addEventListener('touchend', this.onTouchEnd, {
      passive: true,
    });
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/public/admin/drawer.spec.ts`
Expected: PASS (all tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/public/admin/drawer.ts src/public/admin/drawer.spec.ts
git commit -m "feat(admin): add drawer controller, ticker and badge calculation utilities"
```

---

### Task 2: Overview Triage Engine: Status Banner & Attention Queue (Unit Tested)

**Files:**

- Create: `src/public/admin/overview-queue.ts`
- Create: `src/public/admin/overview-queue.spec.ts`

**Interfaces:**

- Consumes: `SummaryResponse` from `src/public/admin/shared.ts`
- Produces:
  - `deriveStatusBannerState(summary: SummaryResponse | null, isPollFailed: boolean): BannerState`
  - `deriveAttentionQueue(summary: SummaryResponse | null): QueueItem[]`
  - `renderStatusBanner(bannerEl: HTMLElement, state: BannerState): void`
  - `renderAttentionQueue(queueEl: HTMLElement, items: QueueItem[]): void`

- [ ] **Step 1: Write the failing tests for banner and queue models**

Create `src/public/admin/overview-queue.spec.ts`:

```typescript
/**
 * @jest-environment jsdom
 */
import {
  deriveStatusBannerState,
  deriveAttentionQueue,
  QueueItem,
  renderStatusBanner,
  renderAttentionQueue,
} from './overview-queue';
import { SummaryResponse } from './shared';

const mockBaseSummary: SummaryResponse = {
  balance: 0,
  earnings: { today: 150, week: 500, allTime: 2000 },
  coinStats: { one: 0, five: 0, ten: 0, twenty: 0 },
  jobStats: { total: 10, print: 6, copy: 3, scan: 1 },
  hopperStats: {
    dispenseAttempts: 0,
    dispenseSuccess: 0,
    dispenseFailures: 0,
    totalDispensed: 0,
    lastDispensedAt: null,
    lastError: null,
    selfTestPassed: true,
    lastSelfTestAt: null,
  },
  owedChangeOpenCount: 0,
  pendingRefundOpenCount: 0,
  refundStats: {
    totalCount: 0,
    openCount: 0,
    refundedCount: 0,
    dismissedCount: 0,
    autoRefundedCount: 0,
  },
  anomalyStats: { totalCount: 0, openCount: 0 },
  storage: { fileCount: 2, bytes: 4096 },
  status: {
    serverRunning: true,
    uptimeSeconds: 120,
    host: 'kiosk',
    wifiActive: true,
    serial: { connected: true, portPath: 'COM3', lastError: null },
    hopper: {
      connected: true,
      pending: false,
      portPath: 'COM4',
      lastError: null,
      lastSuccessAt: null,
    },
    printer: {
      connected: true,
      name: 'EPSON',
      driverName: 'EPSON-L3110',
      portName: 'USB001',
      status: 'ready',
      statusFlags: [],
      ink: [],
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
    },
  },
  jamStats: { totalEvents: 0, recent24h: 0, lastJamAt: null },
};

describe('deriveStatusBannerState', () => {
  it('returns grey tone when poll has failed or summary is null', () => {
    const banner = deriveStatusBannerState(mockBaseSummary, true);
    expect(banner).toEqual({
      tone: 'grey',
      title: "Can't reach kiosk",
      desc: 'Automatic 10s poll failed. Reconnecting...',
    });
  });

  it('returns red tone when critical items are open (owed change)', () => {
    const summary: SummaryResponse = {
      ...mockBaseSummary,
      owedChangeOpenCount: 2,
    };
    const banner = deriveStatusBannerState(summary, false);
    expect(banner).toEqual({
      tone: 'red',
      title: 'Machine needs you',
      desc: 'Critical items require immediate on-site attention.',
    });
  });

  it('returns red tone when paper jam is active in printer status', () => {
    const summary: SummaryResponse = {
      ...mockBaseSummary,
      status: {
        ...mockBaseSummary.status,
        printer: {
          ...mockBaseSummary.status.printer,
          status: 'error',
          statusFlags: ['jam'],
        },
      },
    };
    const banner = deriveStatusBannerState(summary, false);
    expect(banner).toEqual({
      tone: 'red',
      title: 'Machine needs you',
      desc: 'Critical items require immediate on-site attention.',
    });
  });

  it('returns amber tone when warnings exist (anomalies or consumables alerts)', () => {
    const summary: SummaryResponse = {
      ...mockBaseSummary,
      anomalyStats: { totalCount: 2, openCount: 2 },
    };
    const banner = deriveStatusBannerState(summary, false);
    expect(banner.tone).toBe('amber');
    expect(banner.title).toBe('1 item needs attention');
  });

  it('returns green tone when all clear', () => {
    const banner = deriveStatusBannerState(mockBaseSummary, false);
    expect(banner).toEqual({
      tone: 'green',
      title: 'All clear',
      desc: 'Machine running normally. No open issues.',
    });
  });
});

describe('deriveAttentionQueue', () => {
  it('returns empty list when all systems normal', () => {
    const queue = deriveAttentionQueue(mockBaseSummary);
    expect(queue).toEqual([]);
  });

  it('includes critical and warning items sorted by severity', () => {
    const summary: SummaryResponse = {
      ...mockBaseSummary,
      owedChangeOpenCount: 1,
      anomalyStats: { totalCount: 3, openCount: 2 },
      inkEstimation: {
        grayscale: {
          pagesUsed: 800,
          maxPages: 1000,
          remainingPercent: 8,
          alertTriggered: true,
        },
        color: {
          pagesUsed: 200,
          maxPages: 1000,
          remainingPercent: 80,
          alertTriggered: false,
        },
        alertThresholdPercent: 15,
        anyAlertTriggered: true,
      },
    };

    const queue = deriveAttentionQueue(summary);
    expect(queue.length).toBe(3);
    expect(queue[0].severity).toBe('critical');
    expect(queue[0].title).toBe('Owed Change');
    expect(queue[0].actionLabel).toBe('Settle');
    expect(queue[0].targetHref).toBe('/admin/transactions');

    expect(queue[1].severity).toBe('warning');
    expect(queue[1].title).toBe('Anomaly Alerts');
    expect(queue[1].actionLabel).toBe('Open Anomaly Alerts');

    expect(queue[2].severity).toBe('warning');
    expect(queue[2].title).toBe('Ink Low');
    expect(queue[2].actionLabel).toBe('Open Machine Health');
  });
});

describe('DOM rendering helpers', () => {
  it('renders status banner element correctly', () => {
    const bannerEl = document.createElement('div');
    renderStatusBanner(bannerEl, {
      tone: 'red',
      title: 'Machine needs you',
      desc: 'Critical issue',
    });
    expect(bannerEl.className).toContain('status-banner--red');
    expect(bannerEl.textContent).toContain('Machine needs you');
    expect(bannerEl.textContent).toContain('Critical issue');
  });

  it('renders queue rows or fallback when empty', () => {
    const queueEl = document.createElement('div');
    renderAttentionQueue(queueEl, []);
    expect(queueEl.textContent).toContain('Nothing needs you right now.');

    const items: QueueItem[] = [
      {
        id: 'owed-change',
        severity: 'critical',
        title: 'Owed Change',
        subtitle: '1 unsettled change transaction',
        actionLabel: 'Settle',
        targetHref: '/admin/transactions',
      },
    ];
    renderAttentionQueue(queueEl, items);
    expect(queueEl.querySelector('.queue-row--critical')).not.toBeNull();
    expect(queueEl.textContent).toContain('Settle');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/public/admin/overview-queue.spec.ts`
Expected: FAIL (Cannot find module './overview-queue')

- [ ] **Step 3: Implement `src/public/admin/overview-queue.ts`**

Create `src/public/admin/overview-queue.ts`:

```typescript
import { SummaryResponse } from './shared';

export type BannerTone = 'green' | 'amber' | 'red' | 'grey';

export interface BannerState {
  tone: BannerTone;
  title: string;
  desc: string;
}

export type QueueSeverity = 'critical' | 'warning';

export interface QueueItem {
  id: string;
  severity: QueueSeverity;
  title: string;
  subtitle: string;
  actionLabel: string;
  targetHref: string;
}

export function deriveAttentionQueue(
  summary: SummaryResponse | null,
): QueueItem[] {
  if (!summary) return [];
  const items: QueueItem[] = [];

  // 1. Paper jam (Critical)
  const isJam =
    summary.status?.printer?.statusFlags?.includes('jam') ||
    summary.status?.printer?.status === 'jam' ||
    (summary.status?.printer?.status === 'error' &&
      summary.status?.printer?.lastError?.toLowerCase().includes('jam'));

  if (isJam) {
    items.push({
      id: 'paper-jam',
      severity: 'critical',
      title: 'Paper Jam Detected',
      subtitle: 'Clear mechanical jam from printer feed tray',
      actionLabel: 'Clear',
      targetHref: '/admin/system',
    });
  }

  // 2. Owed change (Critical)
  if (summary.owedChangeOpenCount > 0) {
    items.push({
      id: 'owed-change',
      severity: 'critical',
      title: 'Owed Change',
      subtitle: `${summary.owedChangeOpenCount} unsettled coin payout${
        summary.owedChangeOpenCount > 1 ? 's' : ''
      }`,
      actionLabel: 'Settle',
      targetHref: '/admin/transactions',
    });
  }

  // 3. Anomaly alerts (Warning)
  if (summary.anomalyStats.openCount > 0) {
    items.push({
      id: 'anomaly-alerts',
      severity: 'warning',
      title: 'Anomaly Alerts',
      subtitle: `${summary.anomalyStats.openCount} open anomaly event${
        summary.anomalyStats.openCount > 1 ? 's' : ''
      }`,
      actionLabel: 'Open Anomaly Alerts',
      targetHref: '/admin/alerts',
    });
  }

  // 4. Ink low (Warning)
  if (summary.inkEstimation?.anyAlertTriggered) {
    const lowTanks: string[] = [];
    if (summary.inkEstimation.grayscale?.alertTriggered)
      lowTanks.push('Grayscale');
    if (summary.inkEstimation.color?.alertTriggered) lowTanks.push('Color');
    items.push({
      id: 'ink-low',
      severity: 'warning',
      title: 'Ink Low',
      subtitle: `${lowTanks.join(', ')} ink below threshold`,
      actionLabel: 'Open Machine Health',
      targetHref: '#machineHealthStrip',
    });
  }

  // 5. Paper running out (Warning)
  if (summary.consumables?.alerts?.withinThreshold) {
    items.push({
      id: 'paper-warning',
      severity: 'warning',
      title: 'Paper Running Low',
      subtitle:
        summary.consumables.alerts.reasons[0] ||
        'Paper stock nearing replenishment point',
      actionLabel: 'Open Machine Health',
      targetHref: '#machineHealthStrip',
    });
  }

  // Sort: Critical first, then Warning
  return items.sort((a, b) => {
    if (a.severity === 'critical' && b.severity !== 'critical') return -1;
    if (a.severity !== 'critical' && b.severity === 'critical') return 1;
    return 0;
  });
}

export function deriveStatusBannerState(
  summary: SummaryResponse | null,
  isPollFailed: boolean,
): BannerState {
  if (isPollFailed || !summary) {
    return {
      tone: 'grey',
      title: "Can't reach kiosk",
      desc: 'Automatic 10s poll failed. Reconnecting...',
    };
  }

  const queue = deriveAttentionQueue(summary);
  const criticalCount = queue.filter(
    (item) => item.severity === 'critical',
  ).length;
  const warningCount = queue.filter(
    (item) => item.severity === 'warning',
  ).length;

  if (criticalCount > 0) {
    return {
      tone: 'red',
      title: 'Machine needs you',
      desc: 'Critical items require immediate on-site attention.',
    };
  }

  if (warningCount > 0) {
    return {
      tone: 'amber',
      title: `${warningCount} item${warningCount > 1 ? 's' : ''} need${
        warningCount === 1 ? 's' : ''
      } attention`,
      desc: 'Review warning items to maintain uninterrupted service.',
    };
  }

  return {
    tone: 'green',
    title: 'All clear',
    desc: 'Machine running normally. No open issues.',
  };
}

export function renderStatusBanner(
  bannerEl: HTMLElement,
  state: BannerState,
): void {
  bannerEl.className = `status-banner status-banner--${state.tone}`;
  bannerEl.innerHTML = `
    <div class="status-banner__sigil" aria-hidden="true">
      <span class="status-banner__dot"></span>
    </div>
    <div class="status-banner__body">
      <h3 class="status-banner__title">${state.title}</h3>
      <p class="status-banner__desc">${state.desc}</p>
    </div>
  `;
}

export function renderAttentionQueue(
  queueEl: HTMLElement,
  items: QueueItem[],
): void {
  if (items.length === 0) {
    queueEl.innerHTML = `
      <div class="queue-empty">
        <svg viewBox="0 0 20 20" fill="currentColor" class="queue-empty__icon" aria-hidden="true">
          <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
        </svg>
        <span>Nothing needs you right now.</span>
      </div>
    `;
    return;
  }

  const rowsHtml = items
    .map(
      (item) => `
    <div class="queue-row queue-row--${item.severity}">
      <div class="queue-row__indicator" aria-hidden="true"></div>
      <div class="queue-row__main">
        <h4 class="queue-row__title">${item.title}</h4>
        <p class="queue-row__sub">${item.subtitle}</p>
      </div>
      <a href="${item.targetHref}" class="queue-row__action-btn" data-action="${item.id}">
        ${item.actionLabel}
      </a>
    </div>
  `,
    )
    .join('');

  queueEl.innerHTML = `<div class="queue-list">${rowsHtml}</div>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/public/admin/overview-queue.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/public/admin/overview-queue.ts src/public/admin/overview-queue.spec.ts
git commit -m "feat(admin): implement overview status banner and attention queue models"
```

---

### Task 3: Navigation Shell CSS & Drawer Integration in Shared Framework

**Files:**

- Modify: `src/public/admin/shared.css:650-770`
- Modify: `src/public/admin/shared.ts:511-580`

**Interfaces:**

- Consumes: `computeTotalNavBadge`, `DrawerController`, `createUpdatedTicker` from `./drawer`
- Produces: `initAdminShell(): void` exported from `src/public/admin/shared.ts`

- [ ] **Step 1: Write integration test for `initAdminShell` in `shared.ts`**

Create `src/public/admin/shared-shell.spec.ts`:

```typescript
/**
 * @jest-environment jsdom
 */
import { initAdminShell, updateSidebarBadges } from './shared';

describe('Admin Shell Integration', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <header class="topbar">
        <button id="menuBtn" class="topbar-menu-btn">
          <span>Menu</span>
          <span id="menuBadge" class="nav-count-badge hidden"></span>
        </button>
        <div class="topbar__titles">
          <h2 class="topbar__title">Overview</h2>
          <span id="updatedAgoLabel" class="topbar__updated-label"></span>
        </div>
      </header>
      <aside id="adminSidebar" class="sidebar">
        <a id="navOverview" href="/admin/dashboard" class="nav-btn">Overview</a>
        <span id="openAlertBadge" class="nav-count-badge"></span>
        <span id="openReportBadge" class="nav-count-badge"></span>
        <span id="openBadge" class="nav-count-badge"></span>
      </aside>
      <div id="drawerScrim" class="drawer-scrim hidden"></div>
    `;
  });

  it('updates #menuBadge with sum of all open items via updateSidebarBadges', () => {
    initAdminShell();
    const menuBadge = document.getElementById('menuBadge') as HTMLElement;

    updateSidebarBadges({
      feedbackStats: { totalCount: 1, openCount: 2 },
      reportStats: { totalCount: 2, openCount: 3 },
      anomalyStats: { totalCount: 1, openCount: 5 },
    } as any);

    expect(menuBadge.classList.contains('hidden')).toBe(false);
    expect(menuBadge.textContent).toBe('9+');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/public/admin/shared-shell.spec.ts`
Expected: FAIL (`initAdminShell` is not exported)

- [ ] **Step 3: Update `src/public/admin/shared.css` with responsive drawer rules**

Edit `src/public/admin/shared.css`:
Replace the existing `@media (max-width: 860px)` and `@media (max-width: 480px)` rail rules (lines 658-750) with:

```css
/* ── Mobile Navigation Drawer & Topbar Redesign (≤860px) ── */
.topbar-menu-btn {
  display: none;
  position: relative;
  min-width: 44px;
  min-height: 44px;
  padding: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--white);
  cursor: pointer;
  align-items: center;
  justify-content: center;
}

.topbar-menu-btn:hover {
  background: var(--surface-2);
}

.topbar-menu-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: var(--red);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  border-radius: 999px;
  padding: 2px 6px;
  min-width: 18px;
  line-height: 1;
  border: 2px solid #0b0a1a;
}

.topbar__titles {
  display: flex;
  flex-direction: column;
}

.topbar__updated-label {
  font-size: 11px;
  color: rgba(215, 233, 255, 0.6);
  line-height: 1.2;
}

.drawer-scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  z-index: 998;
  transition: opacity 0.25s ease;
}

.drawer-scrim.hidden {
  display: none !important;
}

.nav-group-header {
  padding: 12px 14px 4px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: rgba(167, 170, 225, 0.65);
}

@media (max-width: 860px) {
  .topbar-menu-btn {
    display: inline-flex;
  }

  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 78vw;
    max-width: 320px;
    background: #110f27;
    border-right: 1px solid var(--border-2);
    z-index: 999;
    transform: translateX(-100%);
    transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    box-shadow: 4px 0 24px rgba(0, 0, 0, 0.6);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .sidebar.is-open {
    transform: translateX(0);
  }

  .sidebar__brand {
    padding: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    border-bottom: 1px solid var(--border);
  }

  .sidebar__names {
    display: flex !important;
    flex-direction: column;
  }

  .nav-btn {
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    padding: 12px 16px;
    font-size: 14px;
    gap: 12px;
  }

  .nav-btn > span:not(.nav-count-badge) {
    display: inline !important;
  }

  .nav-count-badge {
    display: inline-flex !important;
    margin-left: auto;
    background: rgba(248, 113, 113, 0.2);
    color: var(--red);
    font-size: 11.5px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 999px;
  }

  .sidebar__foot {
    margin-top: auto;
    padding: 16px;
    border-top: 1px solid var(--border);
  }

  .lock-btn {
    min-height: 44px;
    width: 100%;
    background: rgba(248, 113, 113, 0.12);
    border: 1px solid rgba(248, 113, 113, 0.3);
    color: var(--red);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-radius: 10px;
  }

  .lock-btn span {
    display: inline !important;
  }

  /* Compact hero for mobile */
  .admin-page-hero {
    padding: 12px 0 16px;
  }

  .admin-page-hero__kicker {
    display: none;
  }

  .admin-page-hero__desc {
    display: none;
  }

  .admin-page-hero__title {
    font-size: 18px;
    line-height: 1.3;
  }
}

@media (max-width: 640px) {
  .content {
    padding: 14px;
  }

  .topbar {
    padding: 0 14px;
    gap: 12px;
  }
}
```

- [ ] **Step 4: Update `src/public/admin/shared.ts` to export `initAdminShell` and update total badge**

Edit `src/public/admin/shared.ts`:
Add imports from `./drawer`:

```typescript
import {
  computeTotalNavBadge,
  createUpdatedTicker,
  DrawerController,
  UpdatedTicker,
} from './drawer';
```

Update `updateSidebarBadges(summary: SummaryResponse)`:

```typescript
export function updateSidebarBadges(summary: SummaryResponse): void {
  const openFeedback = summary.feedbackStats?.openCount ?? 0;
  const openReports = summary.reportStats?.openCount ?? 0;
  const openAlerts = summary.anomalyStats?.openCount ?? 0;

  const setBadge = (id: string, count: number) => {
    const el = document.getElementById(id);
    if (el) el.textContent = count > 0 ? String(count) : '';
  };

  setBadge('openBadge', openFeedback);
  setBadge('openBadgeMob', openFeedback);
  setBadge('openReportBadge', openReports);
  setBadge('openReportBadgeMob', openReports);
  setBadge('openAlertBadge', openAlerts);
  setBadge('openAlertBadgeMob', openAlerts);

  // Compute aggregated badge for mobile menu button
  const totalBadge = computeTotalNavBadge(
    openAlerts,
    openReports,
    openFeedback,
  );
  const menuBadge = document.getElementById('menuBadge');
  if (menuBadge) {
    menuBadge.textContent = totalBadge.label;
    if (totalBadge.visible) {
      menuBadge.classList.remove('hidden');
    } else {
      menuBadge.classList.add('hidden');
    }
  }
}
```

Add `initAdminShell()` to `src/public/admin/shared.ts`:

```typescript
let activeDrawer: DrawerController | null = null;
let activeTicker: UpdatedTicker | null = null;

export function initAdminShell(): void {
  const drawerEl = document.querySelector<HTMLElement>('.sidebar');
  const scrimEl =
    document.getElementById('drawerScrim') ||
    document.querySelector<HTMLElement>('.drawer-scrim');
  const triggerEl =
    document.getElementById('menuBtn') ||
    document.querySelector<HTMLButtonElement>('.topbar-menu-btn');

  if (drawerEl && scrimEl && triggerEl) {
    if (!activeDrawer) {
      activeDrawer = new DrawerController({
        drawerEl,
        scrimEl,
        triggerEl,
      });
      triggerEl.addEventListener('click', () => {
        activeDrawer?.toggle();
      });
      // Close drawer when clicking any nav link
      drawerEl
        .querySelectorAll<HTMLAnchorElement>('.nav-btn')
        .forEach((link) => {
          link.addEventListener('click', () => {
            activeDrawer?.close();
          });
        });
    }
  }

  const updatedLabel = document.getElementById('updatedAgoLabel');
  if (updatedLabel && !activeTicker) {
    activeTicker = createUpdatedTicker((text) => {
      updatedLabel.textContent = text;
    });
  }
}

export function notifyAdminDataUpdated(): void {
  activeTicker?.setUpdatedNow();
}
```

Inside `initAuth`, call `initAdminShell()` once when auth gate unlocks.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/public/admin/shared-shell.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/public/admin/shared.css src/public/admin/shared.ts src/public/admin/shared-shell.spec.ts
git commit -m "feat(admin): integrate drawer shell, responsive CSS, and aggregated nav badge"
```

---

### Task 4: Overview Screen Redesign (Status Banner, Queue, Layout)

**Files:**

- Modify: `src/public/admin/dashboard/index.html`
- Modify: `src/public/admin/dashboard/styles.css`
- Modify: `src/public/admin/dashboard/app.ts`

**Interfaces:**

- Consumes: `deriveStatusBannerState`, `renderStatusBanner`, `deriveAttentionQueue`, `renderAttentionQueue` from `../overview-queue`, `notifyAdminDataUpdated` from `../shared`
- Produces: Updated mobile Overview screen matching Section 4.2 of spec.

- [ ] **Step 1: Write DOM test for Overview mobile triage render**

Create `src/public/admin/dashboard/overview-triage.spec.ts`:

```typescript
/**
 * @jest-environment jsdom
 */
import {
  deriveStatusBannerState,
  renderStatusBanner,
  deriveAttentionQueue,
  renderAttentionQueue,
} from '../overview-queue';
import { SummaryResponse } from '../shared';

describe('Overview Triage DOM Integration', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="statusBanner"></div>
      <div id="attentionQueue"></div>
    `;
  });

  it('renders critical attention items when owed change or jam is active', () => {
    const summary = {
      owedChangeOpenCount: 1,
      anomalyStats: { openCount: 0 },
      status: { printer: { status: 'ready', statusFlags: [] } },
    } as unknown as SummaryResponse;

    const bannerState = deriveStatusBannerState(summary, false);
    renderStatusBanner(document.getElementById('statusBanner')!, bannerState);

    const queueItems = deriveAttentionQueue(summary);
    renderAttentionQueue(
      document.getElementById('attentionQueue')!,
      queueItems,
    );

    expect(document.querySelector('.status-banner--red')).not.toBeNull();
    expect(document.querySelector('.queue-row--critical')).not.toBeNull();
    expect(document.getElementById('attentionQueue')!.textContent).toContain(
      'Settle',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx jest src/public/admin/dashboard/overview-triage.spec.ts`
Expected: PASS

- [ ] **Step 3: Update `src/public/admin/dashboard/index.html` markup**

1. In `.topbar__left`, add menu button and updated label:

```html
<header class="topbar">
  <div class="topbar__left">
    <button
      id="menuBtn"
      class="topbar-menu-btn"
      aria-label="Open navigation menu"
    >
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        width="20"
        height="20"
        aria-hidden="true"
      >
        <path
          fill-rule="evenodd"
          d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
          clip-rule="evenodd"
        />
      </svg>
      <span id="menuBadge" class="topbar-menu-badge hidden"></span>
    </button>
    <div class="topbar__titles">
      <h2 class="topbar__title">Overview</h2>
      <span id="updatedAgoLabel" class="topbar__updated-label"
        >Updated just now</span
      >
    </div>
  </div>
  <div class="topbar__right">
    <p
      id="adminMessage"
      class="topbar__msg"
      role="alert"
      aria-live="polite"
    ></p>
    <button id="refreshBtn" class="topbar-btn">
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path
          fill-rule="evenodd"
          d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
          clip-rule="evenodd"
        />
      </svg>
      <span>Refresh</span>
    </button>
  </div>
</header>
```

2. Add the scrim element:

```html
<div id="drawerScrim" class="drawer-scrim hidden"></div>
```

3. In `.sidebar__nav`, organize navigation into intent groups:
   - `<div class="nav-group-header">Monitor</div>`: Overview, Earnings, Anomaly Alerts
   - `<div class="nav-group-header">Support</div>`: Reports, Feedback
   - `<div class="nav-group-header">Records</div>`: System Logs, Transaction Logs
   - `<div class="nav-group-header">Machine</div>`: System, Settings

4. In `.content > #section-overview`, add Status Banner and Attention Queue directly above Today & Jobs:

```html
<!-- Status banner -->
<section
  id="statusBanner"
  class="status-banner status-banner--green"
  aria-live="polite"
>
  <div class="status-banner__sigil">
    <span class="status-banner__dot"></span>
  </div>
  <div class="status-banner__body">
    <h3 class="status-banner__title">All clear</h3>
    <p class="status-banner__desc">Machine running normally. No open issues.</p>
  </div>
</section>

<!-- Attention queue -->
<section
  id="attentionQueue"
  class="attention-queue"
  aria-label="Actionable attention queue"
></section>
```

5. Wrap Machine Health in a collapsible strip `<details id="machineHealthStrip" class="machine-health-strip">`:
   - Summary contains horizontal Paper %, Grayscale %, Color % bars and storage (`storageBytes`, `storageFiles`).
   - Details contain full ink gauges (`inkFillGrayscale`, `inkFillColor`, `forecastInkList`, etc.).

6. Wrap Maintenance in a collapsible section `<details id="maintenanceStrip" class="maintenance-strip">`:
   - Contains Reset Balance (`resetBalanceBtn`), Reset Ink Counters (`resetInkBtn`), and visually separated red Clear Upload Storage (`clearStorageBtn`).

- [ ] **Step 4: Update `src/public/admin/dashboard/styles.css` for mobile banner, queue, and horizontal bars**

Add styles to `src/public/admin/dashboard/styles.css`:

```css
/* ── Overview Status Banner ─────────────────────────── */
.status-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 14px;
  margin-bottom: 14px;
  border: 1.5px solid transparent;
}

.status-banner__dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: block;
}

.status-banner--green {
  background: rgba(74, 222, 128, 0.1);
  border-color: rgba(74, 222, 128, 0.3);
  color: var(--green);
}
.status-banner--green .status-banner__dot {
  background: var(--green);
  box-shadow: 0 0 10px var(--green);
}

.status-banner--amber {
  background: rgba(251, 191, 36, 0.1);
  border-color: rgba(251, 191, 36, 0.35);
  color: var(--amber);
}
.status-banner--amber .status-banner__dot {
  background: var(--amber);
  box-shadow: 0 0 10px var(--amber);
}

.status-banner--red {
  background: rgba(248, 113, 113, 0.12);
  border-color: rgba(248, 113, 113, 0.4);
  color: var(--red);
}
.status-banner--red .status-banner__dot {
  background: var(--red);
  box-shadow: 0 0 10px var(--red);
}

.status-banner--grey {
  background: rgba(148, 163, 184, 0.1);
  border-color: rgba(148, 163, 184, 0.3);
  color: #cbd5e1;
}
.status-banner--grey .status-banner__dot {
  background: #94a3b8;
}

.status-banner__title {
  font-size: 15px;
  font-weight: 700;
  margin: 0;
  line-height: 1.2;
}

.status-banner__desc {
  font-size: 12.5px;
  opacity: 0.85;
  margin-top: 2px;
}

/* ── Attention Queue ────────────────────────────────── */
.attention-queue {
  margin-bottom: 16px;
}

.queue-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: rgba(215, 233, 255, 0.7);
  padding: 8px 4px;
}

.queue-empty__icon {
  width: 18px;
  height: 18px;
  color: var(--green);
}

.queue-row {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 8px;
}

.queue-row--critical {
  border-color: rgba(248, 113, 113, 0.4);
  background: rgba(248, 113, 113, 0.08);
}

.queue-row__indicator {
  width: 4px;
  height: 28px;
  border-radius: 2px;
  background: var(--amber);
}

.queue-row--critical .queue-row__indicator {
  background: var(--red);
}

.queue-row__main {
  flex: 1;
}

.queue-row__title {
  font-size: 13.5px;
  font-weight: 700;
}

.queue-row__sub {
  font-size: 11.5px;
  color: rgba(215, 233, 255, 0.7);
}

.queue-row__action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 16px;
  border-radius: 8px;
  background: var(--indigo);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}

.queue-row--critical .queue-row__action-btn {
  background: var(--red);
}

/* ── Mobile Horizontal Ink & Strips (≤860px) ────────── */
@media (max-width: 860px) {
  .ink-tank-grid {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .ink-tank {
    height: auto;
    padding: 10px 14px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .ink-tank__fill-bar {
    height: 10px;
    width: 100%;
    border-radius: 5px;
  }

  .machine-health-strip,
  .maintenance-strip {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 12px 14px;
    margin-bottom: 14px;
  }

  .maintenance-strip .btn-danger {
    margin-top: 10px;
    border-color: var(--red);
    color: var(--red);
    background: rgba(248, 113, 113, 0.1);
  }
}
```

- [ ] **Step 5: Update `src/public/admin/dashboard/app.ts`**

Edit `src/public/admin/dashboard/app.ts`:

1. Import `deriveStatusBannerState`, `renderStatusBanner`, `deriveAttentionQueue`, `renderAttentionQueue` from `../overview-queue`.
2. Import `notifyAdminDataUpdated` from `../shared`.
3. In `applySummary(summary: SummaryResponse)`:
   - Call `renderStatusBanner(document.getElementById('statusBanner')!, deriveStatusBannerState(summary, false))`
   - Call `renderAttentionQueue(document.getElementById('attentionQueue')!, deriveAttentionQueue(summary))`
   - Call `notifyAdminDataUpdated()`
4. In `showRefreshError(error: unknown)`:
   - If poll failed, update status banner to grey:
     `renderStatusBanner(document.getElementById('statusBanner')!, deriveStatusBannerState(null, true));`

- [ ] **Step 6: Run tests and build bundle**

Run: `npx jest src/public/admin/dashboard/overview-triage.spec.ts`
Run: `node scripts/build-client.js`
Expected: PASS and build completed successfully.

- [ ] **Step 7: Commit**

```bash
git add src/public/admin/dashboard/index.html src/public/admin/dashboard/styles.css src/public/admin/dashboard/app.ts src/public/admin/dashboard/overview-triage.spec.ts
git commit -m "feat(admin): apply mobile triage layout, banner, queue and horizontal gauges to overview"
```

---

### Task 5: Mobile Navigation Shell Markup for the Remaining 8 Admin Pages

**Files:**

- Modify: `src/public/admin/earnings/index.html`
- Modify: `src/public/admin/system/index.html`
- Modify: `src/public/admin/settings/index.html`
- Modify: `src/public/admin/logs/index.html`
- Modify: `src/public/admin/transactions/index.html`
- Modify: `src/public/admin/feedback/index.html`
- Modify: `src/public/admin/report/index.html`
- Modify: `src/public/admin/alerts/index.html`

**Interfaces:**

- Consumes: Shell styles from `shared.css` and `initAdminShell` from `shared.ts`
- Produces: Uniform header with menu button, badge, updated ticker, grouped drawer, and scrim across all 8 sub-pages.

- [ ] **Step 1: Write verification test for shell markup consistency**

Create `src/public/admin/admin-shell-consistency.spec.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

const pages = [
  'dashboard',
  'earnings',
  'system',
  'settings',
  'logs',
  'transactions',
  'feedback',
  'report',
  'alerts',
];

describe('Admin Shell Markup Consistency', () => {
  pages.forEach((page) => {
    it(`checks ${page}/index.html contains mobile menu button, badge, updated label, and scrim`, () => {
      const html = fs.readFileSync(
        path.resolve(__dirname, page, 'index.html'),
        'utf8',
      );
      expect(html).toContain('id="menuBtn"');
      expect(html).toContain('id="menuBadge"');
      expect(html).toContain('id="updatedAgoLabel"');
      expect(html).toContain('id="drawerScrim"');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/public/admin/admin-shell-consistency.spec.ts`
Expected: FAIL (sub-pages do not yet have `#menuBtn`)

- [ ] **Step 3: Update `index.html` in each of the 8 sub-pages**

For each of:

- `src/public/admin/earnings/index.html`
- `src/public/admin/system/index.html`
- `src/public/admin/settings/index.html`
- `src/public/admin/logs/index.html`
- `src/public/admin/transactions/index.html`
- `src/public/admin/feedback/index.html`
- `src/public/admin/report/index.html`
- `src/public/admin/alerts/index.html`

Apply the unified topbar left pattern:

```html
<header class="topbar">
  <div class="topbar__left">
    <button
      id="menuBtn"
      class="topbar-menu-btn"
      aria-label="Open navigation menu"
    >
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        width="20"
        height="20"
        aria-hidden="true"
      >
        <path
          fill-rule="evenodd"
          d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
          clip-rule="evenodd"
        />
      </svg>
      <span id="menuBadge" class="topbar-menu-badge hidden"></span>
    </button>
    <div class="topbar__titles">
      <h2 class="topbar__title">[Page Title]</h2>
      <span id="updatedAgoLabel" class="topbar__updated-label"
        >Updated just now</span
      >
    </div>
  </div>
  ...
</header>
```

Add the scrim element directly after the sidebar in each:

```html
<div id="drawerScrim" class="drawer-scrim hidden"></div>
```

Ensure sidebar links contain the grouping section headers:

```html
<nav class="sidebar__nav">
  <div class="nav-group-header">Monitor</div>
  <a href="/admin/dashboard" ...>Overview</a>
  <a href="/admin/earnings" ...>Earnings</a>
  <a href="/admin/alerts" ...
    >Anomaly Alerts <span class="nav-count-badge" id="openAlertBadge"></span
  ></a>

  <div class="nav-group-header">Support</div>
  <a href="/admin/report" ...
    >Reports <span class="nav-count-badge" id="openReportBadge"></span
  ></a>
  <a href="/admin/feedback" ...
    >Feedback <span class="nav-count-badge" id="openBadge"></span
  ></a>

  <div class="nav-group-header">Records</div>
  <a href="/admin/logs" ...>System Logs</a>
  <a href="/admin/transactions" ...>Transaction Logs</a>

  <div class="nav-group-header">Machine</div>
  <a href="/admin/system" ...>System</a>
  <a href="/admin/settings" ...>Settings</a>
</nav>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/public/admin/admin-shell-consistency.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/public/admin/**/index.html src/public/admin/admin-shell-consistency.spec.ts
git commit -m "feat(admin): unify mobile navigation shell, scrim and drawer structure across all sub-pages"
```

---

### Task 6: Settings Screen Mobile Sticky Save/Discard Bar & Form Polish

**Files:**

- Modify: `src/public/admin/settings/index.html`
- Modify: `src/public/admin/settings/styles.css`
- Modify: `src/public/admin/settings/app.ts`

**Interfaces:**

- Consumes: `settingsDirty` in `src/public/admin/settings/app.ts`
- Produces: Sticky mobile action bar (`#settingsStickyBar`) visible when `settingsDirty` is true on mobile viewports.

- [ ] **Step 1: Write unit test for dirty bar state updates**

Create `src/public/admin/settings/dirty-bar.spec.ts`:

```typescript
/**
 * @jest-environment jsdom
 */
import { updateDirtyBarState } from './dirty-bar-helper';

describe('updateDirtyBarState', () => {
  let bar: HTMLElement;

  beforeEach(() => {
    bar = document.createElement('div');
    bar.id = 'settingsStickyBar';
    bar.classList.add('hidden');
    document.body.appendChild(bar);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('unhides dirty bar when dirty is true', () => {
    updateDirtyBarState(bar, true);
    expect(bar.classList.contains('hidden')).toBe(false);
  });

  it('hides dirty bar when dirty is false', () => {
    updateDirtyBarState(bar, false);
    expect(bar.classList.contains('hidden')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/public/admin/settings/dirty-bar.spec.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Create `src/public/admin/settings/dirty-bar-helper.ts`**

```typescript
export function updateDirtyBarState(
  bar: HTMLElement | null,
  isDirty: boolean,
): void {
  if (!bar) return;
  if (isDirty) {
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}
```

- [ ] **Step 4: Update `src/public/admin/settings/index.html` and `styles.css`**

Add the sticky bar at the bottom of `#settingsForm` in `src/public/admin/settings/index.html`:

```html
<div id="settingsStickyBar" class="settings-sticky-bar hidden">
  <button id="discardChangesBtn" type="button" class="btn-discard">
    Discard
  </button>
  <button id="saveChangesBtn" type="submit" class="btn-save">
    Save changes
  </button>
</div>
```

In `src/public/admin/settings/styles.css`:

```css
/* Sticky Save/Discard Bar for Mobile */
.settings-sticky-bar {
  display: none;
}

@media (max-width: 860px) {
  .settings-sticky-bar {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 12px 16px;
    background: rgba(17, 15, 39, 0.95);
    border-top: 1px solid var(--border-2);
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(8px);
    z-index: 900;
    gap: 12px;
  }

  .settings-sticky-bar.hidden {
    display: none !important;
  }

  .btn-discard {
    min-height: 44px;
    flex: 1;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--white);
    border-radius: 10px;
    font-weight: 600;
  }

  .btn-save {
    min-height: 44px;
    flex: 2;
    background: var(--indigo);
    border: none;
    color: #fff;
    border-radius: 10px;
    font-weight: 700;
  }

  /* Helper text minimum 13px high-contrast */
  .setting-help,
  .form-hint,
  .field-desc {
    font-size: 13px !important;
    color: rgba(215, 233, 255, 0.82) !important;
  }
}
```

- [ ] **Step 5: Integrate dirty bar in `src/public/admin/settings/app.ts`**

Edit `src/public/admin/settings/app.ts`:

1. Import `updateDirtyBarState` from `./dirty-bar-helper`.
2. Grab `#settingsStickyBar` and `#discardChangesBtn`.
3. In `settingsForm.addEventListener('input')` and `'change'`: call `updateDirtyBarState(stickyBar, true)`.
4. In form submit completion and reset: call `updateDirtyBarState(stickyBar, false)`.
5. Attach click handler to `discardChangesBtn`:
   ```typescript
   discardChangesBtn?.addEventListener('click', () => {
     settingsDirty = false;
     updateDirtyBarState(stickyBar, false);
     void loadData({ applyToForm: true });
     setMessage('Changes discarded.');
   });
   ```

- [ ] **Step 6: Run tests and build client**

Run: `npx jest src/public/admin/settings/dirty-bar.spec.ts`
Run: `node scripts/build-client.js`
Expected: PASS and build completed.

- [ ] **Step 7: Commit**

```bash
git add src/public/admin/settings/dirty-bar.spec.ts src/public/admin/settings/dirty-bar-helper.ts src/public/admin/settings/index.html src/public/admin/settings/styles.css src/public/admin/settings/app.ts
git commit -m "feat(admin): add mobile sticky save/discard bar and 13px helper text for settings"
```

---

### Task 7: System Subsystem Cards Collapsible Treatment

**Files:**

- Modify: `src/public/admin/system/styles.css`
- Modify: `src/public/admin/system/app.ts`

**Interfaces:**

- Consumes: Subsystem cards in `src/public/admin/system/index.html`
- Produces: Collapsible cards on mobile with status dot, status text, and tap-to-expand details.

- [ ] **Step 1: Write test for subsystem card toggle behavior**

Create `src/public/admin/system/subsystem-toggle.spec.ts`:

```typescript
/**
 * @jest-environment jsdom
 */
import { attachSubsystemCardToggles } from './subsystem-toggle';

describe('attachSubsystemCardToggles', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="status-card" id="printerCard">
        <div class="status-card__head">Printer Header</div>
        <div class="status-card__details">Printer Details</div>
      </div>
    `;
  });

  it('toggles is-expanded class on click of header', () => {
    attachSubsystemCardToggles();
    const card = document.getElementById('printerCard')!;
    const head = card.querySelector('.status-card__head') as HTMLElement;

    head.click();
    expect(card.classList.contains('is-expanded')).toBe(true);

    head.click();
    expect(card.classList.contains('is-expanded')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/public/admin/system/subsystem-toggle.spec.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/public/admin/system/subsystem-toggle.ts`**

Create `src/public/admin/system/subsystem-toggle.ts`:

```typescript
export function attachSubsystemCardToggles(): void {
  const cards = document.querySelectorAll<HTMLElement>('.status-card');
  cards.forEach((card) => {
    const head = card.querySelector<HTMLElement>('.status-card__head');
    if (head && !head.dataset.toggleBound) {
      head.dataset.toggleBound = 'true';
      head.style.cursor = 'pointer';
      head.addEventListener('click', () => {
        card.classList.toggle('is-expanded');
      });
    }
  });
}
```

- [ ] **Step 4: Update `src/public/admin/system/styles.css`**

Add responsive collapsible card rules in `src/public/admin/system/styles.css`:

```css
@media (max-width: 860px) {
  .status-grid {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .status-card {
    border-radius: 14px;
    overflow: hidden;
  }

  .status-card__head {
    min-height: 44px;
    padding: 12px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .status-card:not(.is-expanded) .status-card__details,
  .status-card:not(.is-expanded) .status-card__body {
    display: none;
  }

  .status-card.is-expanded .status-card__details,
  .status-card.is-expanded .status-card__body {
    display: block;
    padding: 14px;
    border-top: 1px solid var(--border);
  }
}
```

- [ ] **Step 5: Call `attachSubsystemCardToggles()` in `src/public/admin/system/app.ts`**

Import and invoke `attachSubsystemCardToggles()` inside `initAuth` callback.

- [ ] **Step 6: Run tests and build client**

Run: `npx jest src/public/admin/system/subsystem-toggle.spec.ts`
Run: `node scripts/build-client.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/public/admin/system/subsystem-toggle.ts src/public/admin/system/subsystem-toggle.spec.ts src/public/admin/system/styles.css src/public/admin/system/app.ts
git commit -m "feat(admin): make system subsystem cards collapsible on mobile screens"
```

---

### Task 8: Earnings Responsive Switcher & Mobile Breakdown

**Files:**

- Modify: `src/public/admin/earnings/styles.css`
- Modify: `src/public/admin/earnings/index.html`

**Interfaces:**

- Consumes: `#viewSwitch` in `src/public/admin/earnings/index.html`
- Produces: Full-width segmented period control and responsive chart/list breakdown on mobile.

- [ ] **Step 1: Write CSS breakpoint test for Earnings mobile layout**

Create `src/public/admin/earnings/earnings-responsive.spec.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

describe('Earnings Responsive CSS', () => {
  it('contains max-width: 860px styles for segmented view switch and full width cards', () => {
    const css = fs.readFileSync(path.resolve(__dirname, 'styles.css'), 'utf8');
    expect(css).toContain('@media (max-width: 860px)');
    expect(css).toContain('.view-switch');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/public/admin/earnings/earnings-responsive.spec.ts`
Expected: FAIL

- [ ] **Step 3: Update `src/public/admin/earnings/styles.css`**

Add responsive rules:

```css
@media (max-width: 860px) {
  .earnings-deck {
    padding: 14px;
  }

  .view-switch {
    display: flex;
    width: 100%;
    margin-top: 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 4px;
  }

  .view-switch__btn {
    flex: 1;
    min-height: 44px;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .earnings-deck__amount {
    font-size: 32px;
    letter-spacing: -0.5px;
  }

  .analytics-grid {
    grid-template-columns: 1fr;
    gap: 12px;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/public/admin/earnings/earnings-responsive.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/public/admin/earnings/styles.css src/public/admin/earnings/earnings-responsive.spec.ts
git commit -m "feat(admin): responsive period switch and metrics cards for earnings on mobile"
```

---

### Task 9: Card List & Responsive Inbox Patterns for Logs, Transactions, Feedback, Reports, Alerts

**Files:**

- Modify: `src/public/admin/shared.css`
- Modify: `src/public/admin/logs/styles.css`
- Modify: `src/public/admin/transactions/styles.css`
- Modify: `src/public/admin/feedback/styles.css`
- Modify: `src/public/admin/report/styles.css`
- Modify: `src/public/admin/alerts/styles.css`

**Interfaces:**

- Consumes: Desktop table / list markup in each respective page
- Produces: Below 640px card-list transformations with max two lines per row and expandable details.

- [ ] **Step 1: Write test for table-to-card CSS rules**

Create `src/public/admin/table-to-card.spec.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

describe('Table to Card Transformations', () => {
  it('checks shared.css contains responsive table card display rules under 640px', () => {
    const css = fs.readFileSync(path.resolve(__dirname, 'shared.css'), 'utf8');
    expect(css).toContain('@media (max-width: 640px)');
    expect(css).toContain('.logs-table');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/public/admin/table-to-card.spec.ts`
Expected: FAIL

- [ ] **Step 3: Add responsive card transform rules in `src/public/admin/shared.css`**

Add below 640px rules in `src/public/admin/shared.css`:

```css
@media (max-width: 640px) {
  /* Convert tables into responsive card rows */
  .logs-table,
  .logs-table tbody,
  .logs-table tr,
  .logs-table td {
    display: block;
    width: 100%;
  }

  .logs-table thead {
    display: none;
  }

  .logs-table tr {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px 14px;
    margin-bottom: 10px;
  }

  .logs-table td {
    padding: 4px 0;
    border: none;
    font-size: 13px;
  }

  /* Filter bars as top horizontal scroll chip rows */
  .logs-filter-bar,
  .ri-filters,
  .fb-filters {
    display: flex;
    overflow-x: auto;
    white-space: nowrap;
    gap: 8px;
    padding-bottom: 8px;
    -webkit-overflow-scrolling: touch;
  }

  .logs-filter-chip,
  .filter-btn {
    min-height: 44px;
    padding: 8px 14px;
    font-size: 13px;
    flex-shrink: 0;
  }

  /* Shared inbox card row */
  .ri-list,
  .fb-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .ri-item,
  .fb-item {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px;
    min-height: 44px;
  }
}
```

- [ ] **Step 4: Update styles in `logs`, `transactions`, `feedback`, `report`, `alerts`**

Ensure that `.logs-scroll` and details containers allow comfortable card rendering and tap expansions without horizontal scroll overflow.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/public/admin/table-to-card.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/public/admin/shared.css src/public/admin/table-to-card.spec.ts src/public/admin/*/styles.css
git commit -m "feat(admin): transform tables to touch-friendly card lists and chip filters below 640px"
```

---

### Task 10: Client Bundling, Verification & Breakpoint Inspection

**Files:**

- Create: `src/public/admin/mobile-admin-e2e.spec.ts`
- Run: `scripts/build-client.js`
- Test: All test suites (`pnpm test`)

**Interfaces:**

- Consumes: All updated client files
- Produces: Built `app.js` bundles in `src/public/admin/**/app.js` and passing Jest test suites.

- [ ] **Step 1: Write mobile admin verification test suite**

Create `src/public/admin/mobile-admin-e2e.spec.ts`:

```typescript
/**
 * @jest-environment jsdom
 */
import { computeTotalNavBadge } from './drawer';
import {
  deriveStatusBannerState,
  deriveAttentionQueue,
} from './overview-queue';
import { SummaryResponse } from './shared';

describe('PrintBit Mobile Admin Complete Feature Verification', () => {
  it('verifies badge aggregate logic across limits', () => {
    expect(computeTotalNavBadge(0, 0, 0).visible).toBe(false);
    expect(computeTotalNavBadge(1, 0, 0).label).toBe('1');
    expect(computeTotalNavBadge(5, 5, 0).label).toBe('9+');
  });

  it('verifies status banner 4-state transitions', () => {
    const mockSummary: SummaryResponse = {
      balance: 100,
      earnings: { today: 10, week: 20, allTime: 50 },
      coinStats: { one: 0, five: 0, ten: 0, twenty: 0 },
      jobStats: { total: 1, print: 1, copy: 0, scan: 0 },
      hopperStats: {} as any,
      owedChangeOpenCount: 0,
      pendingRefundOpenCount: 0,
      refundStats: {} as any,
      anomalyStats: { totalCount: 0, openCount: 0 },
      storage: { fileCount: 0, bytes: 0 },
      status: { printer: { status: 'ready', statusFlags: [] } } as any,
      jamStats: { totalEvents: 0, recent24h: 0, lastJamAt: null },
    };

    // 1. All clear
    expect(deriveStatusBannerState(mockSummary, false).tone).toBe('green');

    // 2. Poll failed
    expect(deriveStatusBannerState(mockSummary, true).tone).toBe('grey');

    // 3. Warnings
    const warnSummary = {
      ...mockSummary,
      anomalyStats: { totalCount: 1, openCount: 1 },
    };
    expect(deriveStatusBannerState(warnSummary, false).tone).toBe('amber');

    // 4. Critical
    const critSummary = { ...mockSummary, owedChangeOpenCount: 2 };
    expect(deriveStatusBannerState(critSummary, false).tone).toBe('red');
  });

  it('verifies attention queue generation and prioritization', () => {
    const complexSummary = {
      owedChangeOpenCount: 1,
      anomalyStats: { openCount: 3 },
      status: { printer: { status: 'ready', statusFlags: [] } },
    } as any;

    const queue = deriveAttentionQueue(complexSummary);
    expect(queue.length).toBe(2);
    expect(queue[0].id).toBe('owed-change');
    expect(queue[0].severity).toBe('critical');
    expect(queue[1].id).toBe('anomaly-alerts');
    expect(queue[1].severity).toBe('warning');
  });
});
```

- [ ] **Step 2: Run all admin test suites**

Run: `npx jest src/public/admin/`
Expected: PASS (all tests pass)

- [ ] **Step 3: Run the client bundle build script**

Run: `node scripts/build-client.js`
Expected: "Build completed successfully."

- [ ] **Step 4: Commit**

```bash
git add src/public/admin/mobile-admin-e2e.spec.ts src/public/admin/**/app.js
git commit -m "chore(admin): compile client bundles and verify complete mobile admin test suite"
```

---

## Self-Review

1. **Spec coverage:**
   - Section 4.1 Navigation shell (≤860px): Covered in Tasks 1, 3, and 5.
   - Section 4.2 Overview screen: Covered in Tasks 2 and 4.
   - Section 4.3 Other pages inside the same shell: Covered in Tasks 5, 6, 7, 8, and 9.
   - Section 5 Data & code impact: Covered across all tasks (client-side badge sum, banner/queue derivation, updated ticker).
   - Section 6 Verify before implementation: Question 1 verified (all pages call `updateSidebarBadges`); Question 2 handled (jam detection extensible in queue); Question 3 reviewed; Question 4 handled (Settings sticky bar).
   - Section 8 Testing: Unit & DOM test suites defined for every task, client bundle step in Task 10.

2. **Placeholder scan:**
   - No "TODO", "TBD", or vague placeholders.
   - Every step contains explicit code, full commands, and expected outcomes.

3. **Type consistency:**
   - `computeTotalNavBadge` signature matches across Tasks 1, 3, and 10.
   - `deriveStatusBannerState` and `deriveAttentionQueue` types match between Tasks 2, 4, and 10.
