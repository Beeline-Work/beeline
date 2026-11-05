import { describe, expect, it, MediaExpiryLoop, ARTIFACT_TTL_HOURS, MEDIA_SWEEP_INTERVAL_MS, MEDIA_TTL_HOURS, mediaTtlHours, fixtureScope2 } from './background.test-support.js';

describe('media TTL sweep', () => {
const scope2 = fixtureScope2();


  it('deletes only objects past expires_at and tombstones exactly what it deleted', async () => {
    const { db, storage, service } = await scope2.seed();
    try {
      expect(MEDIA_TTL_HOURS).toBe(24);
      expect(ARTIFACT_TTL_HOURS).toBe(168);
      expect(
        await new MediaExpiryLoop(db, 24, 0, { storage: storage.asStorage(), service }).runOnce(),
      ).toBe(1);
      expect((await db.query<{ id: string }>(`SELECT id::text id FROM objects`)).rows).toEqual([
        { id: scope2.fresh },
      ]);
      expect(
        (await db.query<{ id: string }>(`SELECT id::text id FROM object_expirations`)).rows,
      ).toEqual([{ id: scope2.stale }]);
    } finally {
      await db.close();
    }
  });


  it('sweeps hourly, not on every one-second background cycle', async () => {
    const { db, storage, service } = await scope2.seed();
    try {
      const loop = new MediaExpiryLoop(db, 24, MEDIA_SWEEP_INTERVAL_MS, {
        storage: storage.asStorage(),
        service,
      });
      const started = Date.now();
      expect(await loop.runOnce(started)).toBe(1);
      // The still-live row is past expires_at by the time an hour goes by, and
      // is still there because the second cycle never ran a DELETE.
      await db.query(`UPDATE objects SET expires_at=now()-interval '1 minute'`);
      expect(await loop.runOnce(started + MEDIA_SWEEP_INTERVAL_MS - 1)).toBe(0);
      expect((await db.query(`SELECT id FROM objects`)).rows).toHaveLength(1);
      expect(await loop.runOnce(started + MEDIA_SWEEP_INTERVAL_MS)).toBe(1);
      expect((await db.query(`SELECT id FROM objects`)).rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });


  it('takes one env override for the window and ignores an unusable value', async () => {
    expect(mediaTtlHours({} as NodeJS.ProcessEnv)).toBe(MEDIA_TTL_HOURS);
    expect(mediaTtlHours({ MEDIA_TTL_HOURS: 'soon' } as NodeJS.ProcessEnv)).toBe(MEDIA_TTL_HOURS);
    expect(mediaTtlHours({ MEDIA_TTL_HOURS: '0' } as NodeJS.ProcessEnv)).toBe(MEDIA_TTL_HOURS);
    expect(mediaTtlHours({ MEDIA_TTL_HOURS: '72' } as NodeJS.ProcessEnv)).toBe(72);
    const { db, storage, service } = await scope2.seed();
    try {
      await db.query(`UPDATE objects SET expires_at=now()+interval '48 hours'`);
      expect(
        await new MediaExpiryLoop(db, 72, 0, { storage: storage.asStorage(), service }).runOnce(),
      ).toBe(0);
      expect((await db.query(`SELECT id FROM objects`)).rows).toHaveLength(2);
    } finally {
      await db.close();
    }
  });
});
