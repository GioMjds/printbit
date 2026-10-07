import { DatabaseSync } from 'node:sqlite';
import * as sqliteStorage from '@/core/database/sqlite-storage';
import {
  reportIssueStore,
  createReportIssue,
  updateReportIssueStatus,
  mapReportIssueEntry,
  REPORT_RESOLUTION_REASONS,
  type ReportResolutionReason,
  type ReportIssueEntry,
} from '@/core/database/models/report-issue.model';

describe('ReportIssue Domain Model', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    sqliteStorage.ensureSchema(db);
    jest.spyOn(sqliteStorage, 'getSqliteDb').mockReturnValue(db);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createReportIssue and persistence', () => {
    it('creates report issue and persists transactionRef', () => {
      const issueId = 'rep-101';
      createReportIssue({
        id: issueId,
        sessionId: 'sess-1',
        timestamp: '2026-10-06T10:00:00.000Z',
        title: 'Paper Jam Issue',
        description: 'Tray 2 jammed during printing',
        category: 'print',
        transactionRef: 'TXN-7788',
      });

      const fetched = reportIssueStore.getReportIssueById(issueId);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(issueId);
      expect(fetched?.title).toBe('Paper Jam Issue');
      expect(fetched?.status).toBe('open');
      expect(fetched?.transactionRef).toBe('TXN-7788');
      expect(fetched?.resolutionReason).toBeNull();
      expect(fetched?.resolutionNote).toBeNull();
      expect(fetched?.acknowledgedAt).toBeNull();
      expect(fetched?.resolvedAt).toBeNull();
    });

    it('creates report issue without transactionRef defaulting to null', () => {
      const issueId = 'rep-102';
      createReportIssue({
        id: issueId,
        sessionId: 'sess-1',
        timestamp: '2026-10-06T10:05:00.000Z',
        title: 'Scanner Error',
        description: 'Unable to connect to scanner',
        category: 'scan',
      });

      const fetched = reportIssueStore.getReportIssueById(issueId);
      expect(fetched?.transactionRef).toBeNull();
    });
  });

  describe('updateReportIssueStatus', () => {
    const issueId = 'rep-200';

    beforeEach(() => {
      createReportIssue({
        id: issueId,
        sessionId: 'sess-2',
        timestamp: '2026-10-06T09:00:00.000Z',
        title: 'Payment deducted but no print',
        description: 'Charged 20 PHP',
        category: 'payment',
        transactionRef: 'TXN-PAY-01',
      });
    });

    it('acknowledges report issue setting acknowledgedAt via COALESCE', () => {
      const updated = updateReportIssueStatus(issueId, 'acknowledged');
      expect(updated).not.toBeNull();
      expect(updated?.status).toBe('acknowledged');
      expect(updated?.acknowledgedAt).toBeTruthy();
      expect(updated?.resolvedAt).toBeNull();
      expect(updated?.resolutionReason).toBeNull();

      const originalAcknowledgedAt = updated?.acknowledgedAt;

      // Updating to acknowledged again preserves original acknowledgedAt timestamp
      const secondUpdate = updateReportIssueStatus(issueId, 'acknowledged');
      expect(secondUpdate?.acknowledgedAt).toBe(originalAcknowledgedAt);
    });

    it('throws error when resolving without resolutionReason', () => {
      expect(() => {
        updateReportIssueStatus(issueId, 'resolved');
      }).toThrow('Resolution reason is required to resolve a report.');

      expect(() => {
        updateReportIssueStatus(issueId, 'resolved', {});
      }).toThrow('Resolution reason is required to resolve a report.');
    });

    it('throws error when resolving with invalid resolutionReason', () => {
      expect(() => {
        updateReportIssueStatus(issueId, 'resolved', {
          resolutionReason: 'not_a_valid_reason' as unknown as ReportResolutionReason,
        });
      }).toThrow('Invalid resolution reason.');
    });

    it.each(REPORT_RESOLUTION_REASONS)(
      'resolves report issue with valid resolution reason: %s',
      (reason) => {
        const updated = updateReportIssueStatus(issueId, 'resolved', {
          resolutionReason: reason,
          resolutionNote: `Resolved with ${reason}`,
        });

        expect(updated).not.toBeNull();
        expect(updated?.status).toBe('resolved');
        expect(updated?.resolutionReason).toBe(reason);
        expect(updated?.resolutionNote).toBe(`Resolved with ${reason}`);
        expect(updated?.resolvedAt).toBeTruthy();
        expect(updated?.acknowledgedAt).toBeTruthy();
      },
    );

    it('preserves existing acknowledgedAt when resolving previously acknowledged report', () => {
      const acked = updateReportIssueStatus(issueId, 'acknowledged');
      const ackTimestamp = acked?.acknowledgedAt;
      expect(ackTimestamp).toBeTruthy();

      const resolved = updateReportIssueStatus(issueId, 'resolved', {
        resolutionReason: 'hardware_fix',
        resolutionNote: 'Replaced roller',
      });

      expect(resolved?.status).toBe('resolved');
      expect(resolved?.acknowledgedAt).toBe(ackTimestamp);
      expect(resolved?.resolvedAt).toBeTruthy();
      expect(resolved?.resolutionReason).toBe('hardware_fix');
      expect(resolved?.resolutionNote).toBe('Replaced roller');
    });

    it('resets acknowledged and resolved timestamps and notes when reopening', () => {
      updateReportIssueStatus(issueId, 'resolved', {
        resolutionReason: 'refunded',
        resolutionNote: 'Refund issued',
      });

      const reopened = updateReportIssueStatus(issueId, 'open');
      expect(reopened).not.toBeNull();
      expect(reopened?.status).toBe('open');
      expect(reopened?.acknowledgedAt).toBeNull();
      expect(reopened?.resolvedAt).toBeNull();
      expect(reopened?.resolutionReason).toBeNull();
      expect(reopened?.resolutionNote).toBeNull();
    });

    it('returns null when updating non-existent report issue', () => {
      const result = updateReportIssueStatus('non-existent-id', 'acknowledged');
      expect(result).toBeNull();
    });
  });

  describe('listReportIssues and getReportIssueById', () => {
    beforeEach(() => {
      createReportIssue({
        id: 'rep-active-1',
        sessionId: 's1',
        timestamp: '2026-10-06T10:00:00.000Z',
        title: 'Active issue',
        description: 'Desc',
        category: 'hardware',
        transactionRef: 'TXN-A1',
      });

      createReportIssue({
        id: 'rep-active-2',
        sessionId: 's2',
        timestamp: '2026-10-06T11:00:00.000Z',
        title: 'Acknowledged issue',
        description: 'Desc',
        category: 'software',
        transactionRef: 'TXN-A2',
      });
      updateReportIssueStatus('rep-active-2', 'acknowledged');

      createReportIssue({
        id: 'rep-resolved-1',
        sessionId: 's3',
        timestamp: '2026-10-06T12:00:00.000Z',
        title: 'Resolved issue',
        description: 'Desc',
        category: 'hardware',
        transactionRef: 'TXN-R1',
      });
      updateReportIssueStatus('rep-resolved-1', 'resolved', {
        resolutionReason: 'no_fault_found',
        resolutionNote: 'Tested OK',
      });
    });

    it('returns items with resolution reasons and transactionRef in listReportIssues', () => {
      const allResult = reportIssueStore.listReportIssues({
        view: 'all',
        limit: 10,
        offset: 0,
      });
      expect(allResult.total).toBe(3);
      expect(allResult.items).toHaveLength(3);

      const resolvedItem = allResult.items.find((i) => i.id === 'rep-resolved-1');
      expect(resolvedItem?.transactionRef).toBe('TXN-R1');
      expect(resolvedItem?.resolutionReason).toBe('no_fault_found');
      expect(resolvedItem?.resolutionNote).toBe('Tested OK');
    });

    it('filters active queue excluding resolved reports', () => {
      const activeResult = reportIssueStore.listReportIssues({
        view: 'active',
        limit: 10,
        offset: 0,
      });
      expect(activeResult.total).toBe(2);
      expect(activeResult.items.map((i) => i.id)).toEqual(
        expect.arrayContaining(['rep-active-1', 'rep-active-2']),
      );
    });

    it('filters archived queue returning only resolved reports', () => {
      const archivedResult = reportIssueStore.listReportIssues({
        view: 'archived',
        limit: 10,
        offset: 0,
      });
      expect(archivedResult.total).toBe(1);
      expect(archivedResult.items[0].id).toBe('rep-resolved-1');
    });

    it('fetches by ID with all resolution and transaction details', () => {
      const item = reportIssueStore.getReportIssueById('rep-resolved-1');
      expect(item).not.toBeNull();
      expect(item?.id).toBe('rep-resolved-1');
      expect(item?.transactionRef).toBe('TXN-R1');
      expect(item?.resolutionReason).toBe('no_fault_found');
      expect(item?.resolutionNote).toBe('Tested OK');
    });
  });

  describe('mapReportIssueEntry row mapper', () => {
    it('correctly maps SQLite row with all new fields', () => {
      const row = {
        id: 'rep-raw',
        session_id: 'sess-raw',
        timestamp: '2026-10-06T12:00:00.000Z',
        title: 'Title',
        description: 'Description',
        category: 'network',
        status: 'resolved',
        attachment_ids_json: JSON.stringify(['att-1', 'att-2']),
        acknowledged_at: '2026-10-06T12:10:00.000Z',
        resolved_at: '2026-10-06T12:20:00.000Z',
        meta_json: JSON.stringify({ ip: '192.168.1.1' }),
        transaction_ref: 'TXN-999',
        resolution_reason: 'hardware_fix',
        resolution_note: 'Cable replaced',
      };

      const mapped = mapReportIssueEntry(row);
      expect(mapped.id).toBe('rep-raw');
      expect(mapped.sessionId).toBe('sess-raw');
      expect(mapped.category).toBe('network');
      expect(mapped.status).toBe('resolved');
      expect(mapped.attachmentIds).toEqual(['att-1', 'att-2']);
      expect(mapped.acknowledgedAt).toBe('2026-10-06T12:10:00.000Z');
      expect(mapped.resolvedAt).toBe('2026-10-06T12:20:00.000Z');
      expect(mapped.transactionRef).toBe('TXN-999');
      expect(mapped.resolutionReason).toBe('hardware_fix');
      expect(mapped.resolutionNote).toBe('Cable replaced');
      expect(mapped.meta).toEqual({ ip: '192.168.1.1' });
    });

    it('handles null and missing fields gracefully', () => {
      const row = {
        id: 'rep-raw-empty',
        session_id: 'sess-raw',
        timestamp: '2026-10-06T12:00:00.000Z',
        title: 'Title',
        description: 'Description',
        category: 'invalid-cat',
        status: 'unknown-status',
        attachment_ids_json: null,
        acknowledged_at: null,
        resolved_at: null,
        meta_json: null,
        transaction_ref: null,
        resolution_reason: 'invalid_reason',
        resolution_note: null,
      };

      const mapped = mapReportIssueEntry(row);
      expect(mapped.category).toBe('other');
      expect(mapped.status).toBe('open');
      expect(mapped.attachmentIds).toEqual([]);
      expect(mapped.transactionRef).toBeNull();
      expect(mapped.resolutionReason).toBeNull();
      expect(mapped.resolutionNote).toBeNull();
    });
  });
});
