import { SummaryResponse } from './shared';

export type BannerTone = 'green' | 'amber' | 'red' | 'grey';

export interface BannerState {
  tone: BannerTone;
  title: string;
  desc: string;
  actionLabel?: string;
  actionHref?: string;
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

export function deriveAttentionQueue(summary: SummaryResponse | null): QueueItem[] {
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
    if (summary.inkEstimation.grayscale?.alertTriggered) lowTanks.push('Grayscale');
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
      tone: 'red',
      title: 'Kiosk Machine Offline',
      desc: 'Node.js server unreachable. Live hardware controls paused.',
      actionLabel: 'View On-Cloud Edge',
      actionHref: '/edge',
    };
  }

  const queue = deriveAttentionQueue(summary);
  const criticalCount = queue.filter((item) => item.severity === 'critical').length;
  const warningCount = queue.filter((item) => item.severity === 'warning').length;

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

export function renderStatusBanner(bannerEl: HTMLElement, state: BannerState): void {
  bannerEl.className = `status-banner status-banner--${state.tone}`;
  bannerEl.innerHTML = `
    <div class="status-banner__sigil" aria-hidden="true">
      <span class="status-banner__dot"></span>
    </div>
    <div class="status-banner__body">
      <h3 class="status-banner__title">${state.title}</h3>
      <p class="status-banner__desc">${state.desc}</p>
      ${state.actionLabel && state.actionHref ? `<a href="${state.actionHref}" class="status-banner__action">${state.actionLabel} &rarr;</a>` : ''}
    </div>
  `;
}

export function renderAttentionQueue(queueEl: HTMLElement, items: QueueItem[]): void {
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
