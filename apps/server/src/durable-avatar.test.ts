import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAvatar, AVATAR_MAX_BYTES, AVATAR_INPUT_MAX_BYTES } from './durable-avatar.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import { MediaExpiryLoop } from './background.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OWNER = createHash('sha256').update('github:owner').digest('hex');
const picture = (background = '#bb6633') =>
  sharp({
    create: { width: 900, height: 600, channels: 4, background },
  })
    .png()
    .withMetadata()
    .toBuffer();

describe('avatar byte policy', () => {
  it('decodes a large image to bounded, metadata-free pixels', async () => {
    const bytes = await normalizeAvatar(await picture());
    const meta = await sharp(bytes).metadata();
    expect(meta).toMatchObject({ width: 256, height: 256, format: 'webp' });
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(bytes.length).toBeLessThanOrEqual(AVATAR_MAX_BYTES);
  });

  it('rejects oversized, corrupt and non-raster uploads', async () => {
    await expect(normalizeAvatar(Buffer.alloc(AVATAR_INPUT_MAX_BYTES + 1))).rejects.toThrow('size');
    await expect(normalizeAvatar(Buffer.from('not an image'))).rejects.toThrow('invalid');
    await expect(
      normalizeAvatar(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
      ),
    ).rejects.toThrow('invalid');
    // A tiny compressed image with excessive dimensions must also be bounded.
    const bomb = await sharp({
      create: {
        width: 4100,
        height: 4100,
        channels: 3,
        background: '#ffffff',
      },
    })
      .png()
      .toBuffer();
    await expect(normalizeAvatar(bomb)).rejects.toThrow('invalid');
  });
});

describe('durable workspace avatars through the installed phone contract', () => {
  let database: PgliteDatabase;
  let auth: TokenAuth;
  let phone: PhoneService;
  let server: ReturnType<typeof createBeelineServer>;
  let origin: string;
  let token: string;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    auth = new TokenAuth(database, async (login) => ({ subject: login, login, name: login }));
    token = (await auth.exchangeGitHubOidc('owner')).accessToken;
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Avatar test')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`,
      [WORKSPACE, OWNER],
    );
    phone = new PhoneService(database, 'http://placeholder');
    const live = new LiveHub();
    server = createBeelineServer({
      database,
      auth,
      phone,
      live,
      daemon: new DaemonService(database, live),
      mediaMaximumBytes: AVATAR_INPUT_MAX_BYTES,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    (phone as unknown as { publicOrigin: string }).publicOrigin = origin;
  });
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (database) await database.close();
  });
  const set = (avatar: string, accessToken = token) =>
    fetch(`${origin}/v1/phone/operations/updateWorkspace`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: WORKSPACE, avatar }),
    });
  const read = async (accessToken = token) =>
    (
      await (
        await fetch(`${origin}/v1/phone/workspaces/${WORKSPACE}`, {
          headers: { authorization: `Bearer ${accessToken}` },
        })
      ).json()
    ).workspace;
  const upload = async (bytes: Buffer, accessToken = token) => {
    const response = await fetch(`${origin}/v1/phone/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'image/png' },
      body: bytes,
    });
    expect(response.status).toBe(201);
    return (await response.json()).url as string;
  };

  it('survives the actual 24h sweep and a fresh sign-in with no client cache', async () => {
    const uploaded = await upload(await picture());
    expect((await set(uploaded)).status).toBe(204);
    const saved = await read();
    expect(saved.avatar).toMatch(new RegExp(`^${origin}/v1/avatars/`));
    const first = await fetch(saved.avatar);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/webp');
    const bytes = Buffer.from(await first.arrayBuffer());
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 256, height: 256 });

    await database.query(`UPDATE media SET created_at=now()-interval '25 hours'`);
    expect(await new MediaExpiryLoop(database, 24).runOnce()).toBe(1);
    expect((await fetch(uploaded)).status).toBe(410);
    // Fresh session + fresh HTTP reads model the server boundary of reinstall.
    // Nothing from AsyncStorage, an old image cache or the previous read is used.
    const freshToken = (await auth.exchangeGitHubOidc('owner')).accessToken;
    const fresh = await read(freshToken);
    expect(fresh.avatar).toBe(saved.avatar);
    const afterSweep = await fetch(fresh.avatar, { cache: 'no-store' });
    expect(afterSweep.status).toBe(200);
    expect(Buffer.from(await afterSweep.arrayBuffer())).toEqual(bytes);
    const list = await (
      await fetch(`${origin}/v1/phone/workspaces`, {
        headers: { authorization: `Bearer ${freshToken}` },
      })
    ).json();
    expect(list.workspaces.find((w: { id: string }) => w.id === WORKSPACE).avatar).toBe(
      saved.avatar,
    );
    await migrate(database);
    expect((await fetch(saved.avatar)).status).toBe(200);
  });

  it('replaces and removes the workspace-owned object without accumulating old images', async () => {
    expect((await set(await upload(await picture()))).status).toBe(204);
    const first = (await read()).avatar;
    expect((await set(first)).status).toBe(204);
    expect((await read()).avatar).toBe(first);
    expect((await set(await upload(await picture('#22aa55')))).status).toBe(204);
    const second = (await read()).avatar;
    expect(second).not.toBe(first);
    expect((await fetch(first)).status).toBe(404);
    expect((await fetch(second)).status).toBe(200);
    expect((await database.query('SELECT 1 FROM avatars')).rowCount).toBe(1);
    expect((await set('')).status).toBe(204);
    expect((await read()).avatar).toBeUndefined();
    expect((await fetch(second)).status).toBe(404);
    expect((await database.query('SELECT 1 FROM avatars')).rowCount).toBe(0);
  });

  it('refuses another uploader, non-managers, external URLs and corrupt bytes without losing the avatar', async () => {
    expect((await set(await upload(await picture()))).status).toBe(204);
    const saved = (await read()).avatar;
    const outsider = (await auth.exchangeGitHubOidc('outsider')).accessToken;
    const otherUpload = await upload(await picture(), outsider);
    expect((await set(otherUpload)).status).toBe(404);
    expect((await set(saved, outsider)).ok).toBe(false);
    expect((await set('https://images.example/image.png')).status).toBe(400);
    expect((await set(await upload(Buffer.from('invalid image')))).status).toBe(400);
    expect((await read()).avatar).toBe(saved);
    expect((await fetch(saved)).status).toBe(200);
    expect((await fetch(`${origin}/v1/avatars/not-a-uuid`)).status).toBe(404);
  });
});
