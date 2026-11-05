import { describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase, type SqlDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { ObjectService } from './object-service.js';
import type { ObjectStorage } from './object-storage.js';

const VIEWER = 'a'.repeat(64);
const AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

const storage = {
  putObject: async () => undefined,
  presignPost: async () => ({ url: '', fields: {} }),
  presignGet: async () => 'https://s3/get',
  headObject: async () => null,
  deleteObject: async () => undefined,
} as unknown as ObjectStorage;

async function fixture() {
  const database = new PgliteDatabase() as unknown as SqlDatabase;
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Charles','lunchboxfortwo'),($2,'agent','Hoots','hoots')`,
    [VIEWER, AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'welcome')`,
    [ROOM, WORKSPACE, VIEWER],
  );
  for (const id of [VIEWER, AGENT]) {
    await database.query(
      `INSERT INTO memberships(room_id,identity_id,workspace_id,role) VALUES($1,$2,$3,'member')`,
      [ROOM, id, WORKSPACE],
    );
    await database.query(
      `INSERT INTO memberships(room_id,identity_id,workspace_id,role) VALUES(NULL,$1,$2,'member')`,
      [id, WORKSPACE],
    );
  }
  return { database, objects: new ObjectService(database, storage, 'https://server.usebeeline.app') };
}

describe('artifact attachment projection', () => {
  it('stamps kind, title and author onto every ready object, including person file shares', async () => {
    const { database, objects } = await fixture();
    try {
      const artifact = await objects.uploadArtifact(
        AGENT,
        Buffer.from('<p>mock</p>'),
        'text/html',
        'Mock Page',
      );
      const shared = await objects.uploadSharedFile(
        AGENT,
        Buffer.from('pic'),
        'image/png',
        'pic.png',
      );
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,attachments)
         VALUES ($1,$2,$3,'here', $4::jsonb)`,
        [
          '77777777-7777-4777-8777-777777777777',
          ROOM,
          AGENT,
          JSON.stringify([
            { url: artifact.url, name: 'mock.html', mimeType: 'text/html', size: artifact.size },
            { url: shared.url, name: 'pic.png', mimeType: 'image/png', size: shared.size },
          ]),
        ],
      );

      const phone = new PhoneService(database, 'https://server.usebeeline.app');
      const view = await phone.readRoom(ROOM, VIEWER);
      const message = view?.messages.find((row) => row.text === 'here');
      expect(message?.attachments).toHaveLength(2);
      const [artifactAttachment, sharedAttachment] = message!.attachments!;
      expect(artifactAttachment).toMatchObject({
        kind: 'artifact',
        title: 'Mock Page',
        author: 'hoots',
        mimeType: 'text/html',
        size: artifact.size,
      });
      expect(sharedAttachment).toMatchObject({
        kind: 'artifact',
        title: 'pic.png',
        author: 'hoots',
        mimeType: 'image/png',
        size: shared.size,
      });
    } finally {
      await database.close();
    }
  });
});
