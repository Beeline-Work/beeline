import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase, type SqlDatabase } from './test-support.js';
import { ObjectService, isArtifactMimeType } from './object-service.js';
import type { ObjectStorage } from './object-storage.js';

const AGENT = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);

interface FakeStorage {
  put: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  head: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function fakeStorage(): { storage: ObjectStorage; fake: FakeStorage } {
  const fake: FakeStorage = {
    put: vi.fn(async () => undefined),
    post: vi.fn(async () => ({ url: 'https://s3/post', fields: { policy: 'p' } })),
    get: vi.fn(async () => 'https://s3/signed-get'),
    head: vi.fn(async () => null),
    delete: vi.fn(async () => undefined),
  };
  const storage = {
    putObject: fake.put,
    presignPost: fake.post,
    presignGet: fake.get,
    headObject: fake.head,
    deleteObject: fake.delete,
  } as unknown as ObjectStorage;
  return { storage, fake };
}

const HTML = '<!doctype html><p>mock</p>';
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fixture() {
  const database = new PgliteDatabase() as unknown as SqlDatabase;
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Hoots','hoots'),($2,'agent','Goosy','goosy')`,
    [AGENT, OTHER],
  );
  return database;
}

describe('ObjectService', () => {
  let database: SqlDatabase;
  let fake: FakeStorage;
  let storage: ObjectStorage;
  let service: ObjectService;

  beforeEach(async () => {
    database = await fixture();
    ({ storage, fake } = fakeStorage());
    service = new ObjectService(database, storage, 'https://server.usebeeline.app', 25 * 1024 * 1024);
  });

  it('streams a small artifact: storage put, ready row, canonical url', async () => {
    const result = await service.uploadArtifact(AGENT, Buffer.from(HTML), 'text/html', 'Mock Page');
    expect(result).toMatchObject({
      url: `https://server.usebeeline.app/v1/media/${result.objectId}`,
      title: 'Mock Page',
      mimeType: 'text/html',
      size: HTML.length,
      sha256: sha256(Buffer.from(HTML)),
    });
    expect(fake.put).toHaveBeenCalledWith(
      `artifact/${AGENT}/${sha256(Buffer.from(HTML))}`,
      expect.anything(),
      'text/html',
    );
    const row = (
      await database.query<{ state: string; title: string }>(
        `SELECT state,title FROM objects WHERE id=$1`,
        [result.objectId],
      )
    ).rows[0];
    expect(row).toMatchObject({ state: 'ready', title: 'Mock Page' });
  });

  it('refuses bad mime, empty bytes, over-cap bytes, and a blank title', async () => {
    await expect(
      service.uploadArtifact(AGENT, Buffer.from('x'), 'application/octet-stream', 't'),
    ).rejects.toThrow(/artifact mime/);
    await expect(
      service.uploadArtifact(AGENT, Buffer.alloc(0), 'text/html', 't'),
    ).rejects.toThrow(/size/);
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 7);
    await expect(service.uploadArtifact(AGENT, big, 'text/html', 't')).rejects.toThrow(/size/);
    await expect(service.uploadArtifact(AGENT, Buffer.from('x'), 'text/html', '  ')).rejects.toThrow(
      /title/,
    );
    expect(fake.put).not.toHaveBeenCalled();
  });

  it('dedupes identical bytes per owner and restarts the TTL window', async () => {
    const first = await service.uploadArtifact(AGENT, Buffer.from(HTML), 'text/html', 'Mock');
    await database.query(`UPDATE objects SET expires_at = now() - interval '1 minute' WHERE id=$1`, [
      first.objectId,
    ]);
    const second = await service.uploadArtifact(AGENT, Buffer.from(HTML), 'text/html', 'Mock');
    expect(second.objectId).toBe(first.objectId);
    expect(fake.put).toHaveBeenCalledTimes(1);
    const row = (
      await database.query<{ state: string }>(
        `SELECT state, expires_at > now() + interval '23 hours' as fresh FROM objects WHERE id=$1`,
        [first.objectId],
      )
    ).rows[0];
    expect(row).toMatchObject({ state: 'ready' });
    expect(row!.state).toBe('ready');
  });

  it('keeps per-owner dedupe: the same bytes from another owner is a new object', async () => {
    const first = await service.uploadArtifact(AGENT, Buffer.from(HTML), 'text/html', 'Mock');
    const second = await service.uploadArtifact(OTHER, Buffer.from(HTML), 'text/html', 'Mock');
    expect(second.objectId).not.toBe(first.objectId);
    expect(fake.put).toHaveBeenCalledTimes(2);
  });

  it('mints a presigned POST with an exact content-length-range and a pending row', async () => {
    const upload = await service.createUpload(AGENT, {
      kind: 'media',
      mimeType: 'application/pdf',
      size: 1024 * 1024,
      sha256: sha256(Buffer.from('pdf-bytes')),
      title: 'Report',
    });
    expect(upload.deduped).toBe(false);
    expect(upload.url).toBe(`https://server.usebeeline.app/v1/media/${upload.objectId}`);
    expect(upload.upload).toMatchObject({ url: 'https://s3/post', fields: { policy: 'p' } });
    expect(fake.post).toHaveBeenCalledWith(
      `media/${AGENT}/${sha256(Buffer.from('pdf-bytes'))}`,
      expect.objectContaining({ contentType: 'application/pdf', size: 1024 * 1024 }),
    );
    const row = (
      await database.query<{ state: string }>(`SELECT state FROM objects WHERE id=$1`, [
        upload.objectId,
      ])
    ).rows[0];
    expect(row).toMatchObject({ state: 'pending' });
  });

  it('refuses over-cap createUpload and malformed digests', async () => {
    await expect(
      service.createUpload(AGENT, {
        kind: 'media',
        mimeType: 'application/pdf',
        size: 25 * 1024 * 1024 + 1,
        sha256: sha256(Buffer.from('too-big')),
      }),
    ).rejects.toThrow(/size/);
    await expect(
      service.createUpload(AGENT, {
        kind: 'media',
        mimeType: 'application/pdf',
        size: 10,
        sha256: 'not-a-digest',
      }),
    ).rejects.toThrow(/sha256/);
    expect(fake.post).not.toHaveBeenCalled();
  });

  it('finalizeUpload flips pending to ready only on an exact size match', async () => {
    const bytes = Buffer.alloc(4096, 3);
    const upload = await service.createUpload(AGENT, {
      kind: 'artifact',
      mimeType: 'image/svg+xml',
      size: bytes.length,
      sha256: sha256(bytes),
    });
    fake.head.mockResolvedValueOnce({ size: bytes.length, etag: '"e"' });
    await expect(
      service.finalizeUpload(AGENT, { objectId: upload.objectId }),
    ).resolves.toEqual({ state: 'ready' });
    const row = (
      await database.query<{ state: string }>(`SELECT state FROM objects WHERE id=$1`, [
        upload.objectId,
      ])
    ).rows[0];
    expect(row).toMatchObject({ state: 'ready' });
  });

  it('finalizeUpload reports size mismatch and stays pending', async () => {
    const bytes = Buffer.alloc(8, 1);
    const upload = await service.createUpload(AGENT, {
      kind: 'media',
      mimeType: 'application/pdf',
      size: bytes.length,
      sha256: sha256(bytes),
    });
    fake.head.mockResolvedValueOnce({ size: bytes.length + 5, etag: '"e"' });
    await expect(
      service.finalizeUpload(AGENT, { objectId: upload.objectId }),
    ).resolves.toEqual({ state: 'pending', reason: 'size-mismatch' });
    const row = (
      await database.query<{ state: string }>(`SELECT state FROM objects WHERE id=$1`, [
        upload.objectId,
      ])
    ).rows[0];
    expect(row).toMatchObject({ state: 'pending' });
  });

  it('finalizeUpload reports a missing object and never leaves it ready', async () => {
    const bytes = Buffer.alloc(8, 4);
    const upload = await service.createUpload(AGENT, {
      kind: 'media',
      mimeType: 'application/pdf',
      size: bytes.length,
      sha256: sha256(bytes),
    });
    await expect(
      service.finalizeUpload(AGENT, { objectId: upload.objectId }),
    ).resolves.toEqual({ state: 'pending', reason: 'not-found' });
  });

  it('finalize is ownership-checked', async () => {
    const bytes = Buffer.alloc(8, 3);
    const upload = await service.createUpload(AGENT, {
      kind: 'media',
      mimeType: 'application/pdf',
      size: bytes.length,
      sha256: sha256(bytes),
    });
    await expect(
      service.finalizeUpload(OTHER, { objectId: upload.objectId }),
    ).rejects.toThrow('object not found');
  });

  it('readMediaObject: ready redirects, expired is a fact, pending does not exist', async () => {
    const result = await service.uploadArtifact(AGENT, Buffer.from(HTML), 'text/html', 'Mock');
    await expect(service.readMediaObject(result.objectId)).resolves.toEqual({
      kind: 'redirect',
      location: 'https://s3/signed-get',
    });
    await expect(fake.get).toHaveBeenCalledWith(
      expect.stringContaining('artifact/'),
      expect.objectContaining({ expiresIn: 600 }),
    );
    await database.query(
      `INSERT INTO object_expirations(id) VALUES($1)`,
      [result.objectId],
    );
    await expect(service.readMediaObject(result.objectId)).resolves.toEqual({ kind: 'expired' });
    await database.query(`DELETE FROM object_expirations WHERE id=$1`, [result.objectId]);
    await database.query(`UPDATE objects SET state='pending' WHERE id=$1`, [result.objectId]);
    await expect(service.readMediaObject(result.objectId)).resolves.toEqual({ kind: 'pending' });
    await expect(service.readMediaObject('99999999-9999-4999-8999-999999999999')).resolves
      .toBeUndefined();
  });

  it('mediaLink mints a ten-minute inline link only for ready artifacts', async () => {
    const result = await service.uploadArtifact(AGENT, Buffer.from(HTML), 'text/html', 'Mock Page');
    const link = await service.mediaLink(result.objectId);
    expect(link).toMatchObject({ url: 'https://s3/signed-get', expiresIn: 600 });
    expect(fake.get).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        responseContentDisposition: 'inline; filename="Mock Page"',
        responseContentType: 'text/html',
      }),
    );
    await expect(
      service.mediaLink('99999999-9999-4999-8999-999999999999'),
    ).resolves.toBeUndefined();
  });

  it('every write refuses with a clear error when storage is not configured', async () => {
    const bare = new ObjectService(database, undefined, 'https://server.usebeeline.app');
    await expect(
      bare.uploadArtifact(AGENT, Buffer.from(HTML), 'text/html', 'Mock'),
    ).rejects.toThrow('object storage is not configured');
    await expect(
      bare.createUpload(AGENT, {
        kind: 'media',
        mimeType: 'application/pdf',
        size: 10,
        sha256: sha256(Buffer.from('x')),
      }),
    ).rejects.toThrow('object storage is not configured');
  });

  it('classifies artifact mime types exactly', () => {
    for (const mime of ['text/html', 'image/svg+xml', 'application/pdf', 'text/markdown'])
      expect(isArtifactMimeType(mime)).toBe(true);
    expect(isArtifactMimeType('text/plain')).toBe(false);
    expect(isArtifactMimeType('application/json')).toBe(false);
  });
});