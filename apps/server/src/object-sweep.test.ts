import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase, type SqlDatabase } from './test-support.js';
import { MediaExpiryLoop } from './background.js';
import { ObjectService } from './object-service.js';
import type { ObjectStorage } from './object-storage.js';

const AGENT = 'c'.repeat(64);

function storage() {
  return {
    putObject: vi.fn(async () => undefined),
    presignPost: vi.fn(async () => ({ url: 'https://s3/post', fields: {} })),
    presignGet: vi.fn(async () => 'https://s3/get'),
    headObject: vi.fn(async () => null),
    deleteObject: vi.fn(async () => undefined),
  } as unknown as ObjectStorage;
}

async function fixture() {
  const database = new PgliteDatabase() as unknown as SqlDatabase;
  await migrate(database);
  await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Hoots','hoots')`, [
    AGENT,
  ]);
  return database;
}

function sha(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('object sweep', () => {
  it('deletes storage first, then the row with a tombstone; the sweep is idempotent', async () => {
    const db = await fixture();
    try {
      const s = storage();
      const service = new ObjectService(db, s, 'https://x');
      const ready = await service.uploadArtifact(AGENT, Buffer.from('<p>x</p>'), 'text/html', 'T');
      await db.query(`UPDATE objects SET expires_at = now() - interval '1 minute' WHERE id=$1`, [
        ready.objectId,
      ]);

      const loop = new MediaExpiryLoop(db, 24, 0, { storage: s, service });
      await loop.runOnce();

      expect(s.deleteObject).toHaveBeenCalledWith(`artifact/${AGENT}/${sha('<p>x</p>')}`);
      expect(
        (await db.query(`SELECT 1 FROM objects WHERE id=$1`, [ready.objectId])).rows,
      ).toEqual([]);
      expect(
        (await db.query<{ id: string }>(`SELECT id::text id FROM object_expirations`, [])).rows,
      ).toEqual([{ id: ready.objectId }]);

      // Idempotent: second pass deletes nothing and re-tombstones nothing.
      s.deleteObject.mockClear();
      await loop.runOnce();
      expect(s.deleteObject).not.toHaveBeenCalled();

      // The tombstone is what the media read turns into a 410.
      await expect(service.readMediaObject(ready.objectId)).resolves.toEqual({ kind: 'expired' });
    } finally {
      await db.close();
    }
  });

  it('reaps pending orphans after an hour without a tombstone', async () => {
    const db = await fixture();
    try {
      const s = storage();
      const service = new ObjectService(db, s, 'https://x');
      const upload = await service.createUpload(AGENT, {
        kind: 'media',
        mimeType: 'application/pdf',
        size: 10,
        sha256: sha('orphan'),
      });
      await db.query(`UPDATE objects SET created_at = now() - interval '2 hours' WHERE id=$1`, [
        upload.objectId,
      ]);
      await new MediaExpiryLoop(db, 24, 0, { storage: s, service }).runOnce();
      expect(s.deleteObject).toHaveBeenCalledWith(`media/${AGENT}/${sha('orphan')}`);
      expect((await db.query(`SELECT 1 FROM objects WHERE id=$1`, [upload.objectId])).rows).toEqual(
        [],
      );
      expect((await db.query(`SELECT 1 FROM object_expirations`)).rows).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('leaves young pending rows and fresh ready objects alone', async () => {
    const db = await fixture();
    try {
      const s = storage();
      const service = new ObjectService(db, s, 'https://x');
      const ready = await service.uploadArtifact(AGENT, Buffer.from('<p>y</p>'), 'text/html', 'T');
      const pending = await service.createUpload(AGENT, {
        kind: 'media',
        mimeType: 'application/pdf',
        size: 10,
        sha256: sha('young'),
      });
      await new MediaExpiryLoop(db, 24, 0, { storage: s, service }).runOnce();
      expect(s.deleteObject).not.toHaveBeenCalled();
      expect((await db.query<{ id: string }>(`SELECT id::text id FROM objects`)).rows).toHaveLength(
        2,
      );
      void ready;
      void pending;
    } finally {
      await db.close();
    }
  });

  it('a storage delete failure keeps the row for the next sweep', async () => {
    const db = await fixture();
    try {
      const s = storage();
      const service = new ObjectService(db, s, 'https://x');
      const ready = await service.uploadArtifact(AGENT, Buffer.from('<p>z</p>'), 'text/html', 'T');
      await db.query(`UPDATE objects SET expires_at = now() - interval '1 minute' WHERE id=$1`, [
        ready.objectId,
      ]);
      (s.deleteObject as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('HTTP 500'));
      await new MediaExpiryLoop(db, 24, 0, { storage: s, service }).runOnce();
      expect((await db.query(`SELECT 1 FROM objects WHERE id=$1`, [ready.objectId])).rows).toHaveLength(1);
      await new MediaExpiryLoop(db, 24, 0, { storage: s, service }).runOnce();
      expect((await db.query(`SELECT 1 FROM objects WHERE id=$1`, [ready.objectId])).rows).toEqual([]);
      expect(
        (await db.query<{ id: string }>(`SELECT id::text id FROM object_expirations`, [])).rows,
      ).toEqual([{ id: ready.objectId }]);
    } finally {
      await db.close();
    }
  });

  it('without storage configured the loop sweeps nothing', async () => {
    const db = await fixture();
    try {
      const s = storage();
      const service = new ObjectService(db, s, 'https://x');
      const ready = await service.uploadArtifact(AGENT, Buffer.from('<p>w</p>'), 'text/html', 'T');
      await db.query(`UPDATE objects SET expires_at = now() - interval '1 minute' WHERE id=$1`, [
        ready.objectId,
      ]);
      await new MediaExpiryLoop(db).runOnce();
      expect(s.deleteObject).not.toHaveBeenCalled();
      expect((await db.query(`SELECT 1 FROM objects WHERE id=$1`, [ready.objectId])).rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});
