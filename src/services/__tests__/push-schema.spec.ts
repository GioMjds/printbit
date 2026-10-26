import { db, initDB } from '../db';

describe('Push Notification Database Schema', () => {
  beforeAll(async () => {
    await initDB();
  });

  it('initializes adminPushSubscriptions array in db', async () => {
    expect(Array.isArray(db.data?.adminPushSubscriptions)).toBe(true);
  });

  it('provides default pushNotifications settings structure in db', async () => {
    expect(db.data?.settings.pushNotifications).toBeDefined();
    expect(typeof db.data?.settings.pushNotifications.enabled).toBe('boolean');
    expect(typeof db.data?.settings.pushNotifications.cooldownSeconds).toBe('number');
  });
});
