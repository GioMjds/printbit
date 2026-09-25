import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { runPowerShell } from '@/utils';
import { adminService } from '@/modules/admin/admin.service';
import { getTrustedTimestamp } from '@/services/time-source';
import { db } from '@/services/db';
import { HopperErrorCode } from '@/services/hopper';
import type {
  LogMeta,
  AlertChannel,
  AlertSettings,
  AnomalyCategory,
  AnomalySeverity,
  AnomalyStatus,
  AnomalyIncidentEntry,
  AdminQueueView,
} from './anomaly.schema';

const SMTP_PASSWORD_ENV_VAR = 'PRINTBIT_ALERT_SMTP_PASSWORD';
const SMTP_PASSWORD_TEST_ENV_VAR = 'PRINTBIT_ALERT_SMTP_PASSWORD_TEST';

export interface ReportAnomalyInput {
  type: string;
  source: string;
  category: AnomalyCategory;
  severity: AnomalySeverity;
  message: string;
  fingerprint: string;
  context?: LogMeta;
}

export interface ListAnomalyOptions {
  status?: AnomalyStatus;
  severity?: AnomalySeverity;
  category?: AnomalyCategory;
  view?: AdminQueueView;
  limit?: number;
  offset?: number;
}

export interface ListAnomalyResult {
  total: number;
  openCount: number;
  acknowledgedCount: number;
  resolvedCount: number;
  items: AnomalyIncidentEntry[];
}

export interface ReportAnomalyResult {
  created: boolean;
  incident: AnomalyIncidentEntry;
  notified: boolean;
  channels: AlertChannel[];
  dedupeSuppressed: boolean;
}

type AlertEmailSettingsLike = {
  smtpHost: string;
  smtpPort: number;
  secure: boolean;
  username: string;
  from: string;
  to: string;
};

export class AnomalyService {
  private io: Server | null = null;

  setSocketIo(io: Server): void {
    this.io = io;
  }

  getAlertSettings(): AlertSettings {
    return db.data!.settings.alerts;
  }

  async updateAlertSettings(next: AlertSettings): Promise<AlertSettings> {
    db.data!.settings.alerts = next;
    await db.write();
    return db.data!.settings.alerts;
  }

  listIncidents(options: ListAnomalyOptions = {}): ListAnomalyResult {
    const limit = this.clampLimit(options.limit);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));

    const all = db.data!.anomalyIncidents;
    let openCount = 0;
    let acknowledgedCount = 0;
    let resolvedCount = 0;

    const filtered: AnomalyIncidentEntry[] = [];

    for (const entry of all) {
      if (entry.status === 'open') openCount++;
      else if (entry.status === 'acknowledged') acknowledgedCount++;
      else if (entry.status === 'resolved') resolvedCount++;

      if (options.view === 'active') {
        if (entry.status === 'resolved') continue;
      } else if (options.view === 'archived') {
        if (entry.status !== 'resolved') continue;
      } else if (options.status && entry.status !== options.status) {
        continue;
      }
      if (options.severity && entry.severity !== options.severity) continue;
      if (options.category && entry.category !== options.category) continue;

      filtered.push(entry);
    }

    filtered.sort((a, b) =>
      (b.lastDetectedAt ?? '').localeCompare(a.lastDetectedAt ?? ''),
    );

    return {
      total: filtered.length,
      openCount,
      acknowledgedCount,
      resolvedCount,
      items: filtered.slice(offset, offset + limit),
    };
  }

  getIncidentById(id: string): AnomalyIncidentEntry | null {
    return db.data!.anomalyIncidents.find((entry) => entry.id === id) ?? null;
  }

  async updateIncidentStatus(
    id: string,
    status: AnomalyStatus,
  ): Promise<AnomalyIncidentEntry | null> {
    const incident = this.getIncidentById(id);
    if (!incident) return null;

    const now = getTrustedTimestamp().timestamp;
    incident.status = status;
    incident.updatedAt = now;

    if (status === 'acknowledged') {
      if (!incident.acknowledgedAt) incident.acknowledgedAt = now;
      incident.resolvedAt = null;
    } else if (status === 'resolved') {
      if (!incident.acknowledgedAt) incident.acknowledgedAt = now;
      incident.resolvedAt = now;
    } else {
      incident.acknowledgedAt = null;
      incident.resolvedAt = null;
    }

    await db.write();
    this.emitOpenCount();

    await adminService.appendAdminLog(
      'anomaly_incident_status_changed',
      'Anomaly incident status updated.',
      {
        incidentId: incident.id,
        anomalyType: incident.type,
        status: incident.status,
      },
    );

    return incident;
  }

  async report(input: ReportAnomalyInput): Promise<ReportAnomalyResult> {
    const trustedNow = getTrustedTimestamp();
    const nowIso = trustedNow.timestamp;
    const nowMs = Date.parse(nowIso);
    const normalizedFingerprint = input.fingerprint.trim().toLowerCase();
    const message = input.message.trim();

    const activeIncident =
      db.data!.anomalyIncidents.find(
        (entry) =>
          entry.status !== 'resolved' &&
          entry.fingerprint === normalizedFingerprint,
      ) ?? null;

    let incident: AnomalyIncidentEntry;
    let created = false;
    if (activeIncident) {
      incident = activeIncident;
      incident.message = message || incident.message;
      incident.context = input.context ?? incident.context;
      incident.updatedAt = nowIso;
      incident.lastDetectedAt = nowIso;
      incident.occurrenceCount += 1;
    } else {
      created = true;
      incident = {
        id: randomUUID(),
        type: input.type,
        source: input.source,
        category: input.category,
        severity: input.severity,
        status: 'open',
        fingerprint: normalizedFingerprint,
        message,
        context: input.context,
        occurrenceCount: 1,
        firstDetectedAt: nowIso,
        lastDetectedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
        acknowledgedAt: null,
        resolvedAt: null,
        lastNotificationAt: null,
        lastNotifiedChannels: [],
      };
      db.data!.anomalyIncidents.unshift(incident);
    }

    const dedupeSuppressed = this.isSuppressedByDedupe(
      incident,
      Number.isFinite(nowMs) ? nowMs : Date.now(),
    );
    const canNotify =
      this.isSeverityEligible(incident.severity) && !dedupeSuppressed;

    let channels: AlertChannel[] = [];
    if (canNotify) {
      try {
        channels = await this.dispatchNotifications(incident, created);
      } catch (error) {
        this.logError('Failed to dispatch anomaly notifications.', error, {
          incidentId: incident.id,
          anomalyType: incident.type,
        });
        channels = [];
      }
      if (channels.length > 0) {
        incident.lastNotificationAt = nowIso;
        incident.lastNotifiedChannels = channels;
      }
    }

    try {
      await db.write();
    } catch (error) {
      this.logError('Failed to persist anomaly incident update.', error, {
        incidentId: incident.id,
        anomalyType: incident.type,
      });
    }
    this.emitOpenCount();

    return {
      created,
      incident,
      notified: channels.length > 0,
      channels,
      dedupeSuppressed,
    };
  }

  async sendEmailTestAlert(
    settings: AlertSettings = this.getAlertSettings(),
  ): Promise<{ ok: boolean; error?: string }> {
    if (!settings.email.enabled) {
      return { ok: false, error: 'Email alerts are disabled in settings.' };
    }
    const validationError = this.validateEmailConfig(
      settings.email,
      this.getRuntimeSmtpPassword(settings.email.username),
    );
    if (validationError) return { ok: false, error: validationError };

    const success = await this.sendEmail(
      '[PrintBit] Test anomaly alert',
      [
        'This is a test alert from PrintBit.',
        `Sent at: ${new Date().toISOString()}`,
      ].join('\n'),
      'anomaly_email_test',
      settings,
    );
    if (success) return { ok: true };
    return { ok: false, error: 'Failed to send test email alert.' };
  }

  private clampLimit(limit?: number): number {
    const n = Math.floor(limit ?? 100);
    return Math.max(1, Math.min(n, 1000));
  }

  private toIncidentTimestamp(value: string | null | undefined): number {
    if (typeof value !== 'string' || value.length === 0) {
      return Number.NEGATIVE_INFINITY;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  }

  private isSeverityEligible(severity: AnomalySeverity): boolean {
    const threshold = this.getAlertSettings().severityThreshold;
    if (threshold === 'critical') return severity === 'critical';
    return true;
  }

  private getDedupeWindowMs(category: AnomalyCategory): number {
    const dedupe = this.getAlertSettings().dedupe;
    switch (category) {
      case 'printer':
        return dedupe.printerMs;
      case 'spooler':
        return dedupe.spoolerMs;
      case 'serial':
        return dedupe.serialMs;
      case 'hopper':
        return dedupe.hopperMs;
      case 'network':
        return dedupe.networkMs;
      case 'security':
        return dedupe.securityMs;
    }
  }

  private isSuppressedByDedupe(
    incident: AnomalyIncidentEntry,
    nowMs: number,
  ): boolean {
    if (!incident.lastNotificationAt) return false;
    const lastNotificationMs = Date.parse(incident.lastNotificationAt);
    if (!Number.isFinite(lastNotificationMs)) return false;
    const dedupeWindowMs = this.getDedupeWindowMs(incident.category);
    return nowMs - lastNotificationMs < dedupeWindowMs;
  }

  private emitIncidentEvent(
    incident: AnomalyIncidentEntry,
    created: boolean,
  ): void {
    this.io?.emit('adminAnomalyIncident', {
      id: incident.id,
      type: incident.type,
      source: incident.source,
      category: incident.category,
      severity: incident.severity,
      status: incident.status,
      message: incident.message,
      occurrenceCount: incident.occurrenceCount,
      firstDetectedAt: incident.firstDetectedAt,
      lastDetectedAt: incident.lastDetectedAt,
      created,
    });
  }

  private emitOpenCount(): void {
    const openCount = db.data!.anomalyIncidents.filter(
      (entry) => entry.status === 'open',
    ).length;
    this.io?.emit('adminAnomalyCount', { openCount });
  }

  private async dispatchNotifications(
    incident: AnomalyIncidentEntry,
    created: boolean,
  ): Promise<AlertChannel[]> {
    const settings = this.getAlertSettings();
    const channels: AlertChannel[] = [];

    if (settings.dashboard.enabled && this.io) {
      this.emitIncidentEvent(incident, created);
      channels.push('dashboard');
    }

    if (settings.email.enabled) {
      const subject = `[PrintBit] ${incident.severity.toUpperCase()} anomaly: ${incident.type}`;
      const trustedNow = getTrustedTimestamp();
      const body = [
        `Message: ${incident.message}`,
        `Type: ${incident.type}`,
        `Severity: ${incident.severity}`,
        `Category: ${incident.category}`,
        `Source: ${incident.source}`,
        `Detected: ${incident.lastDetectedAt}`,
        `Trusted Timestamp Source: ${trustedNow.meta.source}`,
        `Occurrences: ${incident.occurrenceCount}`,
      ].join('\n');

      let emailSent = false;
      try {
        emailSent = await this.sendEmail(
          subject,
          body,
          'anomaly_email_dispatch',
          settings,
        );
      } catch (error) {
        this.logError('Failed to dispatch anomaly email notification.', error, {
          incidentId: incident.id,
          anomalyType: incident.type,
        });
      }
      if (emailSent) channels.push('email');
    }

    return channels;
  }

  private validateEmailConfig(
    settings: AlertEmailSettingsLike,
    smtpPassword: string | null,
  ): string | null {
    if (!settings.smtpHost.trim()) return 'SMTP host is required.';
    if (!settings.from.trim()) return 'From email is required.';
    if (!settings.to.trim()) return 'To email is required.';
    if (!Number.isFinite(settings.smtpPort) || settings.smtpPort <= 0) {
      return 'SMTP port must be a positive number.';
    }
    if (settings.username.trim() && !smtpPassword) {
      return `Missing SMTP password. Set ${SMTP_PASSWORD_ENV_VAR} in the environment.`;
    }
    return null;
  }

  private getRuntimeSmtpPassword(username: string): string | null {
    if (!username.trim()) return null;
    const password =
      process.env[SMTP_PASSWORD_ENV_VAR] ??
      process.env[SMTP_PASSWORD_TEST_ENV_VAR];
    if (typeof password !== 'string' || password.length === 0) return null;
    return password;
  }

  private async sendEmail(
    subject: string,
    body: string,
    logType: 'anomaly_email_dispatch' | 'anomaly_email_test',
    alertSettings: AlertSettings = this.getAlertSettings(),
  ): Promise<boolean> {
    const settings = alertSettings.email;
    const smtpPassword = this.getRuntimeSmtpPassword(settings.username);
    const validationError = this.validateEmailConfig(settings, smtpPassword);
    if (validationError) {
      try {
        await adminService.appendAdminLog(
          'anomaly_email_dispatch_failed',
          'Email alert dispatch skipped due to invalid configuration.',
          { error: validationError },
        );
      } catch (error) {
        this.logError(
          'Failed to record anomaly email configuration validation failure.',
          error,
        );
      }
      return false;
    }

    const recipients = settings.to
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (recipients.length === 0) {
      try {
        await adminService.appendAdminLog(
          'anomaly_email_dispatch_failed',
          'Email alert dispatch skipped because no recipients were configured.',
        );
      } catch (error) {
        this.logError(
          'Failed to record anomaly email recipient configuration failure.',
          error,
        );
      }
      return false;
    }

    const toArrayLiteral = recipients
      .map((value) => `'${this.escapePs(value)}'`)
      .join(', ');
    const smtpHost = this.escapePs(settings.smtpHost);
    const from = this.escapePs(settings.from);
    const safeSubject = this.escapePs(subject);
    const safeBody = this.escapePs(body);
    const username = this.escapePs(settings.username);
    const password = this.escapePs(smtpPassword ?? '');

    const script = `
$ErrorActionPreference = 'Stop'
$smtpHost = '${smtpHost}'
$smtpPort = ${Math.floor(settings.smtpPort)}
$from = '${from}'
$to = @(${toArrayLiteral})
$subject = '${safeSubject}'
$body = '${safeBody}'
$useSsl = ${settings.secure ? '$true' : '$false'}

if ('${username}' -and '${password}') {
  $securePass = ConvertTo-SecureString '${password}' -AsPlainText -Force
  $cred = New-Object System.Management.Automation.PSCredential('${username}', $securePass)
  Send-MailMessage -SmtpServer $smtpHost -Port $smtpPort -UseSsl:$useSsl -Credential $cred -From $from -To $to -Subject $subject -Body $body
} else {
  Send-MailMessage -SmtpServer $smtpHost -Port $smtpPort -UseSsl:$useSsl -From $from -To $to -Subject $subject -Body $body
}
`.trim();

    try {
      await runPowerShell(script, 20_000);
      const recipientSummary = this.summarizeRecipients(recipients);
      try {
        await adminService.appendAdminLog(
          logType,
          'Anomaly email alert sent.',
          {
            recipientCount: recipients.length,
            recipientSummary,
            smtpHost: settings.smtpHost,
          },
        );
      } catch (error) {
        this.logError('Failed to record anomaly email success log.', error, {
          logType,
        });
      }
      return true;
    } catch (error) {
      const recipientSummary = this.summarizeRecipients(recipients);
      const sanitizedError = this.sanitizeEmailError(error, recipients);
      try {
        await adminService.appendAdminLog(
          'anomaly_email_dispatch_failed',
          'Failed to send anomaly email alert.',
          {
            error: sanitizedError,
            recipientCount: recipients.length,
            recipientSummary,
            smtpHost: settings.smtpHost,
          },
        );
      } catch (logError) {
        this.logError('Failed to record anomaly email failure log.', logError, {
          dispatchError: sanitizedError,
          recipientCount: recipients.length,
          recipientSummary,
          smtpHost: settings.smtpHost,
        });
      }
      return false;
    }
  }

  private logError(message: string, error: unknown, context?: LogMeta): void {
    console.error('[ANOMALY]', message, {
      error: error instanceof Error ? error.message : String(error),
      ...(context ?? {}),
    });
  }

  private escapePs(value: string): string {
    return value
      .replace(/'/g, "''")
      .replace(/[\r\n]/g, ' ')
      .replace(/[\x00-\x1f]/g, '');
  }

  private sanitizeEmailError(error: unknown, recipients: string[]): string {
    let text = error instanceof Error ? error.message : String(error);
    for (const recipient of recipients) {
      const trimmed = recipient.trim();
      if (!trimmed) continue;
      text = text.split(trimmed).join(this.maskEmail(trimmed));
    }
    return text;
  }

  private summarizeRecipients(recipients: string[]): string {
    const masked = recipients.map((recipient) => this.maskEmail(recipient));
    if (masked.length <= 3) return masked.join(', ');
    return `${masked.slice(0, 3).join(', ')}, +${masked.length - 3} more`;
  }

  private maskEmail(email: string): string {
    const [localPartRaw, domainRaw] = email.trim().split('@');
    const localPart = localPartRaw ?? '';
    if (!domainRaw) {
      return localPart.length > 0 ? `${localPart.charAt(0)}***` : '***';
    }
    const safeLocal =
      localPart.length > 0 ? `${localPart.charAt(0)}***` : '***';
    return `${safeLocal}@${domainRaw.toLowerCase()}`;
  }
}

export function buildAnomalyFingerprint(parts: (string | null)[]): string {
  return parts
    .map((part) => (part ?? '').trim().toLowerCase())
    .filter((part) => part.length > 0)
    .join('|');
}

export function mapHopperErrorSeverity(
  errorCode?: string | null,
): AnomalySeverity {
  if (!errorCode) return 'warning';
  if (
    errorCode === HopperErrorCode.EMPTY ||
    errorCode === HopperErrorCode.SENSOR
  ) {
    return 'critical';
  }
  return 'warning';
}

export const anomalyService = new AnomalyService();
