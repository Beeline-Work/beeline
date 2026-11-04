import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import sharp from 'sharp';
import type { TokenAuth } from './auth.js';
import type { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { ObjectService } from './object-service.js';
import { PhoneService } from './phone-service.js';
import { readMediaMetadata } from './phone-media.js';
import { createBeelineServer } from './server.js';
import { MemoryObjectStorage, migratedDatabase } from './test-support.js';
import { phoneArtifactHost } from './test-fixtures/phone-artifact-host.js';

const VIEWER = 'a'.repeat(64), AGENT = 'b'.repeat(64);
const WS = '11111111-1111-4111-8111-111111111111', ROOM = '22222222-2222-4222-8222-222222222222';

it('downloads a roughly 500 KB agent image without a thumbnail for the phone artifact card and shares its bytes with Open', async () => {
  const db = await migratedDatabase(), storage = new MemoryObjectStorage();
  const objects = new ObjectService(db, storage.asStorage(), 'https://synthetic.test');
  const server = createBeelineServer({ database: db, objectService: objects,
    auth: { authenticatePhone: async () => VIEWER } as unknown as TokenAuth,
    phone: new PhoneService(db, 'https://synthetic.test'), daemon: {} as DaemonService,
    live: new LiveHub(), mediaMaximumBytes: 25 * 1024 * 1024 });
  let host: Awaited<ReturnType<typeof phoneArtifactHost>> | undefined;
  try {
    await storage.listen();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic reader'),($2,'agent','Synthetic artist')`, [VIEWER, AGENT]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic image proof')`, [WS]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Experiments')`, [ROOM, WS, VIEWER]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`, [WS, ROOM, VIEWER]);
    const bytes = await sharp({ create: { width: 512, height: 331, channels: 3, background: '#334455' } }).png({ compressionLevel: 0 }).toBuffer();
    expect(bytes.byteLength).toBeGreaterThan(490 * 1024);
    const attachment = await objects.uploadArtifact(AGENT, bytes, 'image/png', 'Synthetic Canyon');
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES('image-proof',$1,$2,'Image',$3::jsonb)`, [ROOM, AGENT, JSON.stringify([attachment])]);
    const id = attachment.objectId;
    const metadata = await readMediaMetadata(db, id, VIEWER);
    expect(metadata.thumbnail).toBeUndefined();
    const response = await fetch(`${origin}/v1/media/${id}`);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    host = await phoneArtifactHost(VIEWER, origin);
    host.phone.installMediaCacheConnection({ origin, principal: VIEWER, generation: 1, mediaMetadataV1: true,
      executeMetadata: (objectId: string) => readMediaMetadata(db, objectId, VIEWER) });
    const image = await host.phone.artifactImageSource({ ...attachment, name: 'canyon.png', kind: 'artifact' }, { preview: true });
    expect(image).toEqual({ uri: 'file:///synthetic/image.png' });
    expect(await host.phone.artifactLocalUri({ ...attachment, name: 'canyon.png', kind: 'artifact' })).toBe(image.uri);
    expect(host.phone.host.requests).toEqual([`${origin}/v1/media/${id}`]);
    expect(Buffer.from([...host.phone.host.bytes.values()][0] as Uint8Array).equals(bytes)).toBe(true);
    expect(await sharp(Buffer.from([...host.phone.host.bytes.values()][0] as Uint8Array)).metadata()).toMatchObject({ width: 512, height: 331 });
  } finally {
    await host?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await storage.close();
    await db.close();
  }
});
