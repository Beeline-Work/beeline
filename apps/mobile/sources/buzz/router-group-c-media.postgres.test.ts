import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresDatabase } from '../../../server/src/database.js';
import { DURABLE_LIVE_SCHEMA } from '../../../server/src/durable-live.js';
import { ROUTER_PROJECTION_SCHEMA } from '../../../server/src/router-projection-schema.js';
import { MEDIA_AUTHORITY_SCHEMA } from '../../../server/src/media-authority-schema.js';
import { fenceMediaMetadataEnqueue, readMediaMetadata } from '../../../server/src/phone-media.js';
import { AdmissionOwner } from '../../../../packages/net/src/private/admission.js';
import { MediaDemandOwner } from '../../../../packages/net/src/private/media-demand-owner.js';
import { resetClientState } from '@/sync/client-reset';

const mocks = vi.hoisted(() => ({ disk: new Map<string, Uint8Array>(),
  fetch: vi.fn(), action: (_action: string, _objectId: string) => {}, open: vi.fn(),
}));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: { fetch: mocks.fetch } }));
vi.mock('./router-owner', () => ({ routerOwnerArtifactAction: (action: string, objectId: string) => mocks.action(action, objectId) }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: mocks.open }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => ({ publicKey: 'synthetic-owner' }) }));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://media.test' }) }));
vi.mock('./artifact-byte-store', () => ({ createArtifactByteStore: () => ({
  get: async (key: string) => mocks.disk.get(key) ?? null,
  set: async (key: string, bytes: Uint8Array) => { mocks.disk.set(key, bytes); },
  remove: async (key: string) => { mocks.disk.delete(key); }, clear: async () => { mocks.disk.clear(); },
  revoke: async () => [], localUri: async () => 'file:///synthetic/cache.png',
}) }));
import { readArtifactObject } from './artifact-byte-owner';
import { artifactImageSource, artifactLocalUri, fetchArtifactBytes, openArtifactInBrowser } from './artifact-link';
import { requestMediaPlayback } from './media-cache-connection';
import { installMediaCacheConnection, receiveMediaAuthorityRemoval, suspendMediaCacheConnection } from './media-cache-connection';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Group C media proofs require isolated loopback PostgreSQL');
const object = '33333333-3333-4333-8333-333333333333', thumb = '44444444-4444-4444-8444-444444444444';
const room = '22222222-2222-4222-8222-222222222222';
const bytes = new Uint8Array([1, 2, 3]);
const attachment = { url: `/v1/media/${object}`, name: 'photo.png', mimeType: 'image/png', size: 3, kind: 'artifact' as const };
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

// Real server metadata/authority + real admission/metadata/immutable byte owners.
// Disk/native leaf is deliberately synthetic; this is not native cohort proof.
describe.skipIf(!url)('Group C P8/P10/P11 PostgreSQL media composition', () => {
  it('F07/F23: preview, view and save share one admitted metadata/HTTP flight; expiry waits for demand and revocation fences reuse', async () => {
    resetClientState(); await Promise.resolve(); mocks.disk.clear();
    const schema = `group_c_media_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const db = new PostgresDatabase('', 2, { pool: new Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 2 }) });
    const byteStarted = deferred(), releaseBytes = deferred(), linkStarted = deferred(), releaseLink = deferred(); let transfers = 0, metadataReads = 0;
    const server = createServer((_request, response) => {
      transfers++; byteStarted.resolve();
      void releaseBytes.promise.then(() => { response.writeHead(200, { 'content-type': 'image/png' }); response.end(bytes); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const byteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/immutable`;
    const admission = new AdmissionOwner({ origin: 'https://media.test', principal: 'synthetic-owner', sessionEpoch: 1 });
    const owner = new MediaDemandOwner(admission, () => ({ screen: 'Room', roomId: room, generation: 1 }));
    owner.connected(1); owner.viewport(room, [object]);
    mocks.action = (action, objectId) => owner.action(action as 'OpenArtifactBrowser', objectId);
    mocks.open.mockClear(); mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`https://media.test/v1/media/${object}`);
      return fetch(byteUrl, init);
    });
    let active: Promise<unknown>[] = [];
    try {
      await db.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
        CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
        CREATE VIEW room_access AS SELECT * FROM memberships;
        CREATE TABLE objects(id uuid PRIMARY KEY,owner_id text,key text,sha256 text,size bigint,mime text,state text,expires_at timestamptz);
        CREATE TABLE object_expirations(id uuid PRIMARY KEY);
        CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,attachments jsonb,deleted_at timestamptz);`);
      await db.query(DURABLE_LIVE_SCHEMA); await db.query(ROUTER_PROJECTION_SCHEMA); await db.query(MEDIA_AUTHORITY_SCHEMA);
      await db.query(`INSERT INTO objects VALUES($1,'synthetic-owner','immutable/key',$2,3,'image/png','ready',now()+interval '1 day')`,
        [object, createHash('sha256').update(bytes).digest('hex')]);
      installMediaCacheConnection({ origin: 'https://media.test', principal: 'synthetic-owner', generation: 1, mediaMetadataV1: true,
        joinedMetadata: id => owner.satisfy('readMediaMetadata', id),
        executeMetadata: id => owner.dispatch('readMediaMetadata', id, async () => {
          metadataReads++;
          const result = await readMediaMetadata(db, id, 'synthetic-owner');
          await fenceMediaMetadataEnqueue(db, id, 'synthetic-owner', result.authority, () => undefined);
          return result;
        }),
        executePlayback: id => owner.dispatch('readMediaPlayback', id, async () => ({ url: 'https://games.test/play/file', expiresIn: 60 })),
        executeLink: id => owner.dispatch('readMediaLink', id, async () => {
          const metadata = await readMediaMetadata(db, id, 'synthetic-owner');
          await fenceMediaMetadataEnqueue(db, id, 'synthetic-owner', metadata.authority, () => undefined);
          linkStarted.resolve(); await releaseLink.promise;
          return { url: 'https://files.test/private-file', expiresIn: 60 };
        }),
      });
      const read = vi.fn(async (_id: string, signal: AbortSignal, maxBytes: number) => {
        const response = await fetch(byteUrl, { signal });
        const result = new Uint8Array(await response.arrayBuffer());
        expect(result.byteLength).toBeLessThanOrEqual(maxBytes); return result;
      });
      const preview = artifactImageSource(attachment, { preview: true }); active.push(preview);
      await byteStarted.promise;
      owner.action('OpenArtifact', object);
      const view = fetchArtifactBytes(attachment); active.push(view);
      owner.action('SaveArtifact', object);
      const save = artifactLocalUri(attachment); active.push(save);
      // Retain the original immutable-owner guarantees as well as proving the
      // concrete image/view/save adapters above use this same physical flight.
      const owned = [readArtifactObject(attachment, read, { preview: true }),
        readArtifactObject(attachment, read), readArtifactObject(attachment, read)];
      active.push(...owned);
      releaseBytes.resolve();
      const results = await Promise.all([preview, view, save]);
      const values = await Promise.all(owned);
      expect(values.map(result => [...result.bytes])).toEqual([[1, 2, 3], [1, 2, 3], [1, 2, 3]]);
      expect(new Set(values.map(result => result.key)).size).toBe(1);
      expect(read).not.toHaveBeenCalled();
      expect(results).toEqual([{ uri: 'file:///synthetic/cache.png' }, bytes, 'file:///synthetic/cache.png']);
      expect({ metadataReads, transfers, byteCalls: mocks.fetch.mock.calls.length }).toEqual({ metadataReads: 1, transfers: 1, byteCalls: 1 });
      owner.action('RunArtifact', object);
      await expect(requestMediaPlayback(object)).resolves.toMatchObject({ url: 'https://games.test/play/file' });
      expect(metadataReads).toBe(1);
      // Time invalidates freshness but cannot issue its own metadata/byte read.
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      await vi.advanceTimersByTimeAsync(86_400_001);
      expect({ metadataReads, transfers }).toEqual({ metadataReads: 1, transfers: 1 });
      await db.query(`UPDATE objects SET expires_at=now()+interval '3 days' WHERE id=$1`, [object]);
      owner.action('OpenArtifact', object);
      expect((await readArtifactObject(attachment, read)).bytes).toEqual(bytes);
      expect({ metadataReads, transfers }).toEqual({ metadataReads: 2, transfers: 1 });
      const value = await readArtifactObject(attachment, read);
      const link = openArtifactInBrowser(attachment); active.push(link);
      const refusedLink = expect(link).rejects.toThrow('authority'); await linkStarted.promise;
      const previous = await readMediaMetadata(db, object, 'synthetic-owner');
      await db.query(`UPDATE objects SET owner_id='other-owner' WHERE id=$1`, [object]);
      receiveMediaAuthorityRemoval(`object:${object}`, previous.authority.scopes[0]!.epoch);
      releaseLink.resolve(); await refusedLink;
      expect(mocks.open).not.toHaveBeenCalled(); expect(value.isCurrent()).toBe(false);
      expect(values.every(result => !result.isCurrent())).toBe(true);
      owner.action('SaveArtifact', object);
      await expect(readArtifactObject(attachment, read)).rejects.toMatchObject({ status: 404 });
      expect(transfers).toBe(1);
      suspendMediaCacheConnection();
      await expect(readArtifactObject(attachment, read)).rejects.toThrow('awaiting connection');
      expect(transfers).toBe(1);
    } finally {
      releaseBytes.resolve(); releaseLink.resolve(); await Promise.allSettled(active); owner.disconnected(); resetClientState(); vi.useRealTimers();
      await new Promise<void>(resolve => server.close(() => resolve())); await db.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    }
  });

  it.each([16 * 1024, 16 * 1024 + 1])('F07/F23: PostgreSQL grants a raster preview only within 16 KiB (%s)', async size => {
    const schema = `group_c_preview_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const db = new PostgresDatabase('', 2, { pool: new Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 2 }) });
    try {
      await db.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
        CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
        CREATE VIEW room_access AS SELECT * FROM memberships;
        CREATE TABLE objects(id uuid PRIMARY KEY,owner_id text,key text,sha256 text,size bigint,mime text,state text,expires_at timestamptz);
        CREATE TABLE object_expirations(id uuid PRIMARY KEY);
        CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,attachments jsonb,deleted_at timestamptz);`);
      await db.query(DURABLE_LIVE_SCHEMA); await db.query(ROUTER_PROJECTION_SCHEMA); await db.query(MEDIA_AUTHORITY_SCHEMA);
      const workspace = '11111111-1111-4111-8111-111111111111';
      await db.query('INSERT INTO workspaces VALUES($1)', [workspace]);
      await db.query('INSERT INTO rooms(id,workspace_id) VALUES($1,$2)', [room, workspace]);
      await db.query(`INSERT INTO memberships VALUES($1,NULL,'reader','member',NULL),($1,$2,'reader','member',NULL)`, [workspace, room]);
      await db.query(`INSERT INTO objects VALUES($1,'synthetic-owner','full',$3,26214400,'image/png','ready',now()+interval '1 day'),
        ($2,'synthetic-owner','thumbnail',$3,$4,'image/webp','ready',now()+interval '1 day')`, [object, thumb, 'a'.repeat(64), size]);
      await db.query(`INSERT INTO messages VALUES('file',$1,'synthetic-owner',$2::jsonb,NULL)`,
        [room, JSON.stringify([{ url: `/v1/media/${object}`, thumbnailUrl: `/v1/media/${thumb}` }])]);
      const result = await readMediaMetadata(db, object, 'reader');
      expect(result.size).toBe(25 * 1024 * 1024);
      if (size === 16 * 1024) expect(result.thumbnail).toMatchObject({ objectId: thumb, size });
      else expect(result.thumbnail).toBeUndefined();
    } finally { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
});
