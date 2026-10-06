import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteStorage from '@/core/database/sqlite-storage';
import { feedbackStore } from '@/core/database/models/feedback.model';
import { FeedbackService } from '@/modules/feedback/feedback.service';
import { FeedbackController } from '@/modules/feedback/feedback.controller';

jest.mock('@/middleware/admin-auth', () => ({
  requireAdminLocalAccess: (_req: any, _res: any, next: any) => next(),
  requireAdminPin: (_req: any, _res: any, next: any) => next(),
}));

describe('Feedback Admin API & Lifecycle', () => {
  let db: DatabaseSync;
  let app: Express;
  let server: http.Server;
  let baseUrl: string;
  let feedbackService: FeedbackService;
  let feedbackController: FeedbackController;

  beforeAll(async () => {
    feedbackService = new FeedbackService();
    feedbackController = new FeedbackController(feedbackService, {
      resolvePublicBaseUrl: () => new URL('http://127.0.0.1:3000'),
    });

    app = express();
    app.use(express.json());
    app.use('/api/feedback', feedbackController.router);
    app.use('/api/admin/feedback', feedbackController.createAdminRouter());

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    sqliteStorage.ensureSchema(db);
    jest.spyOn(sqliteStorage, 'getSqliteDb').mockReturnValue(db);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Submitting feedback with transactionRef', () => {
    it('persists transactionRef when submitting feedback via API', async () => {
      const response = await fetch(`${baseUrl}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment: 'Very easy to use, excellent print quality.',
          category: 'service',
          rating: 5,
          transactionRef: 'TXN-FEEDBACK-1234',
        }),
      });

      expect(response.status).toBe(201);
      const data = (await response.json()) as { ok: boolean; feedbackId: string };
      expect(data.ok).toBe(true);

      const saved = feedbackStore.findFeedbackById(data.feedbackId);
      expect(saved).not.toBeNull();
      expect(saved?.comment).toBe('Very easy to use, excellent print quality.');
      expect(saved?.transactionRef).toBe('TXN-FEEDBACK-1234');
      expect(saved?.status).toBe('new');
      expect(saved?.needsAction).toBe(false);
      expect(saved?.archivedAt).toBeNull();
    });
  });

  describe('PATCH /api/admin/feedback/:id/status', () => {
    it('marks feedback as reviewed and updates resolvedAt timestamp', async () => {
      const entry = await feedbackService.submitFeedback({
        comment: 'Slightly slow coin feeder',
        rating: 3,
      });

      const response = await fetch(
        `${baseUrl}/api/admin/feedback/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'reviewed',
          }),
        },
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; entry: any };
      expect(body.ok).toBe(true);
      expect(body.entry.status).toBe('reviewed');
      expect(body.entry.resolvedAt).toBeDefined();

      const dbEntry = feedbackStore.findFeedbackById(entry.id);
      expect(dbEntry?.status).toBe('reviewed');
      expect(dbEntry?.resolvedAt).not.toBeNull();
    });

    it('reopens feedback back to status "new" and clears resolvedAt', async () => {
      const entry = await feedbackService.submitFeedback({
        comment: 'Scanner lamp flicker',
        rating: 2,
      });
      await feedbackService.updateFeedbackStatus(entry.id, 'reviewed');

      const response = await fetch(
        `${baseUrl}/api/admin/feedback/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'new',
          }),
        },
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; entry: any };
      expect(body.entry.status).toBe('new');
      expect(body.entry.resolvedAt).toBeNull();
    });

    it('sets needsAction flag to true and false', async () => {
      const entry = await feedbackService.submitFeedback({
        comment: 'Refund needed for failed scan',
        rating: 1,
      });

      // Set to true
      const resTrue = await fetch(
        `${baseUrl}/api/admin/feedback/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            needsAction: true,
          }),
        },
      );
      expect(resTrue.status).toBe(200);
      const bodyTrue = (await resTrue.json()) as { ok: boolean; entry: any };
      expect(bodyTrue.entry.needsAction).toBe(true);

      let dbEntry = feedbackStore.findFeedbackById(entry.id);
      expect(dbEntry?.needsAction).toBe(true);

      // Set back to false
      const resFalse = await fetch(
        `${baseUrl}/api/admin/feedback/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            needsAction: false,
          }),
        },
      );
      expect(resFalse.status).toBe(200);
      const bodyFalse = (await resFalse.json()) as { ok: boolean; entry: any };
      expect(bodyFalse.entry.needsAction).toBe(false);

      dbEntry = feedbackStore.findFeedbackById(entry.id);
      expect(dbEntry?.needsAction).toBe(false);
    });

    it('archives individual feedback when action is "archive"', async () => {
      const entry = await feedbackService.submitFeedback({
        comment: 'All good!',
        rating: 5,
      });

      const response = await fetch(
        `${baseUrl}/api/admin/feedback/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'archive',
          }),
        },
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; entry: any };
      expect(body.entry.status).toBe('archived');
      expect(body.entry.archivedAt).toBeDefined();

      const dbEntry = feedbackStore.findFeedbackById(entry.id);
      expect(dbEntry?.status).toBe('archived');
      expect(dbEntry?.archivedAt).not.toBeNull();
    });

    it('supports combined action e.g. status reviewed and needsAction true', async () => {
      const entry = await feedbackService.submitFeedback({
        comment: 'Please call customer support',
        rating: 2,
      });

      const response = await fetch(
        `${baseUrl}/api/admin/feedback/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'reviewed',
            needsAction: true,
          }),
        },
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; entry: any };
      expect(body.entry.status).toBe('reviewed');
      expect(body.entry.needsAction).toBe(true);
    });

    it('returns 400 when invalid status is provided', async () => {
      const entry = await feedbackService.submitFeedback({
        comment: 'Great app',
      });

      const response = await fetch(
        `${baseUrl}/api/admin/feedback/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'in_progress',
          }),
        },
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('Valid status required: new | reviewed');
    });

    it('returns 400 without mutating row when invalid status is sent alongside needsAction', async () => {
      const entry = await feedbackService.submitFeedback({
        comment: 'Needs action test',
      });
      expect(entry.needsAction).toBe(false);

      const response = await fetch(
        `${baseUrl}/api/admin/feedback/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            needsAction: true,
            status: 'invalid_status_value',
          }),
        },
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('Valid status required: new | reviewed');

      // Verify needsAction was NOT mutated in SQLite
      const untouched = feedbackStore.findFeedbackById(entry.id);
      expect(untouched?.needsAction).toBe(false);
      expect(untouched?.status).toBe('new');
    });

    it('returns 400 when action="archive" and status are both provided', async () => {
      const entry = await feedbackService.submitFeedback({
        comment: 'Conflicting update test',
      });

      const response = await fetch(
        `${baseUrl}/api/admin/feedback/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'archive',
            status: 'reviewed',
          }),
        },
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe(
        'Cannot set both action="archive" and status simultaneously.',
      );

      // Verify no mutation occurred
      const untouched = feedbackStore.findFeedbackById(entry.id);
      expect(untouched?.status).toBe('new');
      expect(untouched?.archivedAt).toBeNull();
    });

    it('returns 400 when invalid action is provided', async () => {
      const entry = await feedbackService.submitFeedback({
        comment: 'Invalid action test',
      });

      const response = await fetch(
        `${baseUrl}/api/admin/feedback/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'destroy',
          }),
        },
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('Invalid action. Only "archive" is supported.');
    });

    it('returns 400 when non-boolean needsAction is provided', async () => {
      const entry = await feedbackService.submitFeedback({
        comment: 'Non boolean test',
      });

      const response = await fetch(
        `${baseUrl}/api/admin/feedback/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            needsAction: 'not-a-bool',
          }),
        },
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('needsAction must be a boolean.');
    });

    it('returns 404 for non-existent feedback id', async () => {
      const response = await fetch(
        `${baseUrl}/api/admin/feedback/non-existent-uuid/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'reviewed',
          }),
        },
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('Feedback entry not found.');
    });
  });

  describe('POST /api/admin/feedback/archive-reviewed', () => {
    it('bulk archives all reviewed feedback entries and returns affected count', async () => {
      const fb1 = await feedbackService.submitFeedback({ comment: 'Entry 1', rating: 4 });
      const fb2 = await feedbackService.submitFeedback({ comment: 'Entry 2', rating: 5 });
      const fb3 = await feedbackService.submitFeedback({ comment: 'Entry 3', rating: 1 });

      // Mark fb1 and fb2 as reviewed, keep fb3 as new
      feedbackService.updateFeedbackStatus(fb1.id, 'reviewed');
      feedbackService.updateFeedbackStatus(fb2.id, 'reviewed');

      const response = await fetch(
        `${baseUrl}/api/admin/feedback/archive-reviewed`,
        {
          method: 'POST',
        },
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; count: number };
      expect(body.ok).toBe(true);
      expect(body.count).toBe(2);

      const db1 = feedbackStore.findFeedbackById(fb1.id);
      const db2 = feedbackStore.findFeedbackById(fb2.id);
      const db3 = feedbackStore.findFeedbackById(fb3.id);

      expect(db1?.status).toBe('archived');
      expect(db1?.archivedAt).not.toBeNull();
      expect(db2?.status).toBe('archived');
      expect(db2?.archivedAt).not.toBeNull();
      expect(db3?.status).toBe('new');
      expect(db3?.archivedAt).toBeNull();
    });

    it('returns count 0 when no reviewed items are available', async () => {
      await feedbackService.submitFeedback({ comment: 'Only new item', rating: 4 });

      const response = await fetch(
        `${baseUrl}/api/admin/feedback/archive-reviewed`,
        {
          method: 'POST',
        },
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; count: number };
      expect(body.ok).toBe(true);
      expect(body.count).toBe(0);
    });
  });

  describe('DELETE with "PURGE" confirmation enforcement', () => {
    it('returns 400 when deleting individual feedback without PURGE confirmation', async () => {
      const entry = await feedbackService.submitFeedback({ comment: 'Delete me test' });

      // Missing confirm body
      const res1 = await fetch(`${baseUrl}/api/admin/feedback/${entry.id}`, {
        method: 'DELETE',
      });
      expect(res1.status).toBe(400);
      const data1 = (await res1.json()) as { error: string };
      expect(data1.error).toBe('Typed confirmation PURGE required.');

      // Wrong confirm string
      const res2 = await fetch(`${baseUrl}/api/admin/feedback/${entry.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'delete' }),
      });
      expect(res2.status).toBe(400);
      const data2 = (await res2.json()) as { error: string };
      expect(data2.error).toBe('Typed confirmation PURGE required.');

      // Entry must still exist
      expect(feedbackStore.findFeedbackById(entry.id)).not.toBeNull();
    });

    it('permanently purges individual feedback row when confirm is "PURGE"', async () => {
      const entry = await feedbackService.submitFeedback({ comment: 'Purge me target' });

      const response = await fetch(`${baseUrl}/api/admin/feedback/${entry.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'PURGE' }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { ok: boolean };
      expect(data.ok).toBe(true);

      // Row is permanently deleted from SQLite
      expect(feedbackStore.findFeedbackById(entry.id)).toBeNull();
    });

    it('returns 404 when purging non-existent feedback with "PURGE"', async () => {
      const response = await fetch(`${baseUrl}/api/admin/feedback/unknown-id-123`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'PURGE' }),
      });

      expect(response.status).toBe(404);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe('Feedback entry not found.');
    });

    it('returns 400 when bulk purging all feedback without PURGE confirmation', async () => {
      await feedbackService.submitFeedback({ comment: 'Row 1' });
      await feedbackService.submitFeedback({ comment: 'Row 2' });

      const response = await fetch(`${baseUrl}/api/admin/feedback`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'ALL' }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe('Typed confirmation PURGE required.');

      expect(feedbackStore.listAllFeedback().length).toBe(2);
    });

    it('permanently purges all feedback rows when confirm is "PURGE"', async () => {
      await feedbackService.submitFeedback({ comment: 'Row 1' });
      await feedbackService.submitFeedback({ comment: 'Row 2' });
      await feedbackService.submitFeedback({ comment: 'Row 3' });

      const response = await fetch(`${baseUrl}/api/admin/feedback`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'PURGE' }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { ok: boolean; count: number };
      expect(data.ok).toBe(true);
      expect(data.count).toBe(3);

      expect(feedbackStore.listAllFeedback().length).toBe(0);
    });
  });
});
