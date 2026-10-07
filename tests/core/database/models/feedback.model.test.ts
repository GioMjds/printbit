import { DatabaseSync } from 'node:sqlite';
import * as sqliteStorage from '@/core/database/sqlite-storage';
import {
  feedbackStore,
  createFeedback,
  archiveFeedback,
  archiveAllReviewedFeedback,
  setNeedsAction,
  purgeFeedback,
  purgeAllFeedback,
  mapFeedbackEntry,
  type FeedbackEntry,
} from '@/core/database/models/feedback.model';

describe('Feedback Domain Model', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    sqliteStorage.ensureSchema(db);
    jest.spyOn(sqliteStorage, 'getSqliteDb').mockReturnValue(db);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createFeedback and defaults', () => {
    it('creates feedback with transactionRef and defaults status to new and needsAction to false', () => {
      const entry = createFeedback({
        comment: 'Great self-service experience!',
        category: 'service',
        rating: 5,
        transactionRef: 'TXN-FB-100',
      });

      expect(entry.id).toBeTruthy();
      expect(entry.status).toBe('new');
      expect(entry.needsAction).toBe(false);
      expect(entry.transactionRef).toBe('TXN-FB-100');
      expect(entry.archivedAt).toBeNull();

      const fetched = feedbackStore.findFeedbackById(entry.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.status).toBe('new');
      expect(fetched?.needsAction).toBe(false);
      expect(fetched?.transactionRef).toBe('TXN-FB-100');
    });

    it('creates feedback with custom status and needsAction flag', () => {
      const entry = createFeedback({
        comment: 'The paper tray was jammed and ate my 50 PHP note',
        category: 'hardware',
        rating: 1,
        transactionRef: 'TXN-FB-101',
        needsAction: true,
      });

      expect(entry.needsAction).toBe(true);

      const fetched = feedbackStore.findFeedbackById(entry.id);
      expect(fetched?.needsAction).toBe(true);
    });
  });

  describe('archiveFeedback and archiveAllReviewedFeedback', () => {
    let f1Id: string;
    let f2Id: string;
    let f3Id: string;

    beforeEach(() => {
      const f1 = createFeedback({
        comment: 'Needs attention',
        category: 'print',
        status: 'new',
      });
      f1Id = f1.id;

      const f2 = createFeedback({
        comment: 'Reviewed feedback 1',
        category: 'service',
        status: 'reviewed',
      });
      f2Id = f2.id;

      const f3 = createFeedback({
        comment: 'Reviewed feedback 2',
        category: 'service',
        status: 'reviewed',
      });
      f3Id = f3.id;
    });

    it('archives individual feedback setting status and archivedAt', () => {
      const archived = archiveFeedback(f1Id);
      expect(archived).not.toBeNull();
      expect(archived?.status).toBe('archived');
      expect(archived?.archivedAt).toBeTruthy();

      const fetched = feedbackStore.findFeedbackById(f1Id);
      expect(fetched?.status).toBe('archived');
      expect(fetched?.archivedAt).toBe(archived?.archivedAt);
    });

    it('returns null when archiving non-existent feedback', () => {
      const result = archiveFeedback('non-existent-id');
      expect(result).toBeNull();
    });

    it('archiveAllReviewedFeedback archives all rows with status reviewed and returns affected count', () => {
      const affected = archiveAllReviewedFeedback();
      expect(affected).toBe(2);

      const f1 = feedbackStore.findFeedbackById(f1Id);
      expect(f1?.status).toBe('new');
      expect(f1?.archivedAt).toBeNull();

      const f2 = feedbackStore.findFeedbackById(f2Id);
      expect(f2?.status).toBe('archived');
      expect(f2?.archivedAt).toBeTruthy();

      const f3 = feedbackStore.findFeedbackById(f3Id);
      expect(f3?.status).toBe('archived');
      expect(f3?.archivedAt).toBeTruthy();

      // Running again returns 0 affected since none are in reviewed status
      const affectedSecond = archiveAllReviewedFeedback();
      expect(affectedSecond).toBe(0);
    });
  });

  describe('setNeedsAction', () => {
    it('updates needs_action to true and false', () => {
      const entry = createFeedback({
        comment: 'Kiosk ran out of ink',
        category: 'hardware',
      });
      expect(entry.needsAction).toBe(false);

      const flagged = setNeedsAction(entry.id, true);
      expect(flagged).not.toBeNull();
      expect(flagged?.needsAction).toBe(true);

      const unflagged = setNeedsAction(entry.id, false);
      expect(unflagged).not.toBeNull();
      expect(unflagged?.needsAction).toBe(false);
    });

    it('returns null when updating non-existent feedback', () => {
      const result = setNeedsAction('non-existent-id', true);
      expect(result).toBeNull();
    });
  });

  describe('purgeFeedback and purgeAllFeedback', () => {
    it('throws error when purgeFeedback confirmation string is not PURGE', () => {
      const entry = createFeedback({ comment: 'To be purged' });

      expect(() => {
        purgeFeedback(entry.id, 'DELETE');
      }).toThrow('Typed confirmation PURGE required for permanent deletion.');

      expect(() => {
        purgeFeedback(entry.id, 'purge');
      }).toThrow('Typed confirmation PURGE required for permanent deletion.');

      expect(() => {
        purgeFeedback(entry.id, '');
      }).toThrow('Typed confirmation PURGE required for permanent deletion.');
    });

    it('permanently deletes row when confirmation is exactly PURGE', () => {
      const entry = createFeedback({ comment: 'To be purged' });

      const deleted = purgeFeedback(entry.id, 'PURGE');
      expect(deleted).toBe(true);

      const fetched = feedbackStore.findFeedbackById(entry.id);
      expect(fetched).toBeNull();

      // Second purge of already deleted row returns false
      const deletedAgain = purgeFeedback(entry.id, 'PURGE');
      expect(deletedAgain).toBe(false);
    });

    it('throws error when purgeAllFeedback confirmation is not PURGE', () => {
      expect(() => {
        purgeAllFeedback('CONFIRM');
      }).toThrow('Typed confirmation PURGE required for permanent deletion.');
    });

    it('permanently deletes all feedback when confirmation is exactly PURGE', () => {
      createFeedback({ comment: 'Feedback 1' });
      createFeedback({ comment: 'Feedback 2' });
      createFeedback({ comment: 'Feedback 3' });

      const count = purgeAllFeedback('PURGE');
      expect(count).toBe(3);

      const remaining = feedbackStore.listAllFeedback();
      expect(remaining).toHaveLength(0);
    });
  });

  describe('listFeedback filtering', () => {
    beforeEach(() => {
      createFeedback({ comment: 'New feedback 1', status: 'new' });
      createFeedback({ comment: 'New feedback 2', status: 'new' });
      createFeedback({ comment: 'Legacy open feedback', status: 'open' });
      createFeedback({ comment: 'Reviewed feedback', status: 'reviewed' });
      createFeedback({ comment: 'Archived feedback', status: 'archived' });
    });

    it('defaults to active queue view containing new, open, and reviewed items', () => {
      const defaultView = feedbackStore.listFeedback({
        limit: 10,
        offset: 0,
      });
      expect(defaultView.total).toBe(4);
      expect(
        defaultView.items.map((i) => i.status).every((s) => ['new', 'open', 'reviewed'].includes(s)),
      ).toBe(true);

      const explicitActive = feedbackStore.listFeedback({
        view: 'active',
        limit: 10,
        offset: 0,
      });
      expect(explicitActive.total).toBe(4);
    });

    it('filters archived queue view containing only archived items', () => {
      const archivedView = feedbackStore.listFeedback({
        view: 'archived',
        limit: 10,
        offset: 0,
      });
      expect(archivedView.total).toBe(1);
      expect(archivedView.items[0].status).toBe('archived');
    });

    it('returns all items when view is all', () => {
      const allView = feedbackStore.listFeedback({
        view: 'all',
        limit: 10,
        offset: 0,
      });
      expect(allView.total).toBe(5);
      expect(allView.items).toHaveLength(5);
    });

    it('filters by specific status when status option is passed', () => {
      const reviewedOnly = feedbackStore.listFeedback({
        status: 'reviewed',
        limit: 10,
        offset: 0,
      });
      expect(reviewedOnly.total).toBe(1);
      expect(reviewedOnly.items[0].comment).toBe('Reviewed feedback');

      const newOnly = feedbackStore.listFeedback({
        status: 'new',
        limit: 10,
        offset: 0,
      });
      expect(newOnly.total).toBe(2);
    });
  });

  describe('stats and legacy compatibility', () => {
    beforeEach(() => {
      createFeedback({ comment: 'New 1', status: 'new' });
      createFeedback({ comment: 'Legacy open 1', status: 'open' });
      createFeedback({ comment: 'Reviewed 1', status: 'reviewed' });
      createFeedback({ comment: 'Archived 1', status: 'archived' });
    });

    it('countOpen counts both new and open items as unhandled active', () => {
      expect(feedbackStore.countOpen()).toBe(2);
    });

    it('getFeedbackStats returns both legacy aggregate and granular status breakdown', () => {
      const stats = feedbackStore.getFeedbackStats();
      expect(stats.total).toBe(4);
      expect(stats.open).toBe(2); // new + open
      expect(stats.resolved).toBe(1); // reviewed + resolved
      expect(stats.new).toBe(1);
      expect(stats.reviewed).toBe(1);
      expect(stats.archived).toBe(1);
    });

    it('updateFeedbackResolved transitions to reviewed when true and new when false', () => {
      const fb = createFeedback({ comment: 'Test transition', status: 'new' });

      const resolved = feedbackStore.updateFeedbackResolved(fb.id, true);
      expect(resolved?.status).toBe('reviewed');
      expect(resolved?.resolvedAt).toBeTruthy();

      const reopened = feedbackStore.updateFeedbackResolved(fb.id, false);
      expect(reopened?.status).toBe('new');
      expect(reopened?.resolvedAt).toBeNull();
    });
  });

  describe('mapFeedbackEntry row mapper', () => {
    it('correctly maps raw SQLite row with all new fields', () => {
      const row = {
        id: 'fb-row-1',
        session_id: 's-row-1',
        timestamp: '2026-10-06T12:00:00.000Z',
        comment: 'Fast printing!',
        category: 'print',
        rating: 5,
        status: 'archived',
        resolved_at: '2026-10-06T12:05:00.000Z',
        meta_json: JSON.stringify({ device: 'kiosk-01' }),
        transaction_ref: 'TXN-FB-999',
        needs_action: 1,
        archived_at: '2026-10-06T12:10:00.000Z',
      };

      const mapped = mapFeedbackEntry(row);
      expect(mapped.id).toBe('fb-row-1');
      expect(mapped.sessionId).toBe('s-row-1');
      expect(mapped.comment).toBe('Fast printing!');
      expect(mapped.category).toBe('print');
      expect(mapped.rating).toBe(5);
      expect(mapped.status).toBe('archived');
      expect(mapped.resolvedAt).toBe('2026-10-06T12:05:00.000Z');
      expect(mapped.transactionRef).toBe('TXN-FB-999');
      expect(mapped.needsAction).toBe(true);
      expect(mapped.archivedAt).toBe('2026-10-06T12:10:00.000Z');
      expect(mapped.meta).toEqual({ device: 'kiosk-01' });
    });

    it('handles defaults when optional fields are null or unmapped', () => {
      const row = {
        id: 'fb-row-2',
        session_id: 's-row-2',
        timestamp: '2026-10-06T12:00:00.000Z',
        comment: 'Nice',
        category: null,
        rating: null,
        status: 'unknown-status',
        resolved_at: null,
        meta_json: null,
        transaction_ref: null,
        needs_action: 0,
        archived_at: null,
      };

      const mapped = mapFeedbackEntry(row);
      expect(mapped.status).toBe('new');
      expect(mapped.needsAction).toBe(false);
      expect(mapped.transactionRef).toBeNull();
      expect(mapped.archivedAt).toBeNull();
    });
  });
});
