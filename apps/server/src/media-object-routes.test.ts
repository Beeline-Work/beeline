import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import type { TokenAuth } from './auth.js';
import type { PhoneService } from './phone-service.js';
import type { DaemonService } from './daemon-service.js';
import type { LiveHub } from './live.js';
import type { ObjectService } from './object-service.js';
import { createBeelineServer } from './server.js';

const UUID = '44444444-4444-4444-8444-444444444444';
const MEDIA_UUID = '55555555-5555-4555-8555-555555555555';
const AGENT_TOKEN = 'Bearer daemon-token-0000000000';
const PHONE_TOKEN = 'Bearer phone-token-0000000000';

const auth = {
  authenticateDaemon: vi.fn(async (value: string) =>
    value === 'daemon-token-0000000000' ? 'agent-1' : null,
  ),
  authenticatePhone: vi.fn(async (value: string) =>
    value === 'phone-token-0000000000' ? 'ident-1' : null,
  ),
  retiredDaemonAgent: vi.fn(async () => null),
} as unknown as TokenAuth;

describe('media object routes', () => {
  const servers: ReturnType<typeof createBeelineServer>[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    return Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  function start(options: { objectService?: ObjectService }) {
    const server = createBeelineServer({
      database: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as SqlDatabase,
      auth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: {} as LiveHub,
      mediaMaximumBytes: 1024,
      ...options,
    });
    servers.push(server);
    return new Promise<string>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
    );
  }

  function objectService(overrides: Partial<Record<keyof ObjectService, unknown>> = {}) {
    return {
      readMediaObject: vi.fn(async () => ({ kind: 'redirect', location: 'https://s3/get' })),
      mediaLink: vi.fn(async () => ({ url: 'https://s3/get', expiresIn: 600 })),
      uploadArtifact: vi.fn(async () => ({ objectId: UUID, url: `https://x/v1/media/${UUID}` })),
      createUpload: vi.fn(async () => ({ objectId: UUID, deduped: false, url: `https://x/v1/media/${UUID}`, upload: { url: 'https://s3/post', fields: {} }, expiresAt: 1 })),
      finalizeUpload: vi.fn(async () => ({ state: 'ready' })),
      ...overrides,
    } as unknown as ObjectService;
  }

  it('redirects a ready object with a no-store cache policy', async () => {
    const objects = objectService();
    const origin = await start({ objectService: objects });
    const response = await fetch(`${origin}/v1/media/${UUID}`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://s3/get');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(objects.readMediaObject).toHaveBeenCalledWith(UUID);
  });

  it('answers 410 with the ttl fact for swept objects', async () => {
    const objects = objectService({
      readMediaObject: vi.fn(async () => ({ kind: 'expired' })),
    } as never);
    const origin = await start({ objectService: objects as ObjectService });
    const response = await fetch(`${origin}/v1/media/${UUID}`, { redirect: 'manual' });
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ error: 'media_expired' });
  });

  it('never exposes a pending object and falls through to legacy media otherwise', async () => {
    const pending = objectService({ readMediaObject: vi.fn(async () => ({ kind: 'pending' })) } as never);
    const origin = await start({ objectService: pending as ObjectService });
    expect((await fetch(`${origin}/v1/media/${UUID}`)).status).toBe(404);

    const absent = objectService({ readMediaObject: vi.fn(async () => undefined) } as never);
    const origin2 = await start({ objectService: absent as ObjectService });
    const legacy = await fetch(`${origin2}/v1/media/${MEDIA_UUID}`);
    expect(legacy.status).toBe(404);
    await expect(legacy.json()).resolves.toMatchObject({ error: 'media_not_found' });
  });

  it('the link endpoint is authenticated and object-backed', async () => {
    const objects = objectService();
    const origin = await start({ objectService: objects });
    expect((await fetch(`${origin}/v1/media/${UUID}/link`)).status).toBe(401);
    const authorized = await fetch(`${origin}/v1/media/${UUID}/link`, {
      headers: { authorization: PHONE_TOKEN },
    });
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toEqual({ url: 'https://s3/get', expiresIn: 600 });
    expect(objects.mediaLink).toHaveBeenCalledWith(UUID);

    const unknown = objectService({ mediaLink: vi.fn(async () => undefined) } as never);
    const origin2 = await start({ objectService: unknown as ObjectService });
    expect(
      (await fetch(`${origin2}/v1/media/${UUID}/link`, { headers: { authorization: PHONE_TOKEN } }))
        .status,
    ).toBe(404);
  });

  it('uploads small artifacts through the server with a title header', async () => {
    const objects = objectService();
    const origin = await start({ objectService: objects });
    expect(
      (
        await fetch(`${origin}/v1/daemon/artifacts`, {
          method: 'POST',
          body: '<p>hi</p>',
          headers: { 'content-type': 'text/html' },
        })
      ).status,
    ).toBe(401);
    const response = await fetch(`${origin}/v1/daemon/artifacts`, {
      method: 'POST',
      body: '<p>hi</p>',
      headers: {
        authorization: AGENT_TOKEN,
        'content-type': 'text/html',
        'x-artifact-title': 'Mock Page',
      },
    });
    expect(response.status).toBe(201);
    expect(objects.uploadArtifact).toHaveBeenCalledWith(
      'agent-1',
      expect.any(Uint8Array),
      'text/html',
      'Mock Page',
    );
  });

  it('refuses oversized artifact bodies with 413 before reading storage', async () => {
    const objects = objectService();
    const origin = await start({ objectService: objects });
    const response = await fetch(`${origin}/v1/daemon/artifacts`, {
      method: 'POST',
      body: Buffer.alloc(2 * 1024 * 1024 + 1, 1),
      headers: { authorization: AGENT_TOKEN, 'content-type': 'text/html' },
    });
    expect(response.status).toBe(413);
    expect(objects.uploadArtifact).not.toHaveBeenCalled();
  });

  it('object writes answer 503 when no storage is configured', async () => {
    const origin = await start({});
    const artifact = await fetch(`${origin}/v1/daemon/artifacts`, {
      method: 'POST',
      body: 'x',
      headers: { authorization: AGENT_TOKEN, 'content-type': 'text/html' },
    });
    expect(artifact.status).toBe(503);
    const mint = await fetch(`${origin}/v1/daemon/uploads`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'media', mimeType: 'application/pdf', size: 10, sha256: 'a'.repeat(64) }),
      headers: { authorization: AGENT_TOKEN, 'content-type': 'application/json' },
    });
    expect(mint.status).toBe(503);
  });

  it('mints and finalizes large-media uploads over the daemon boundary', async () => {
    const objects = objectService();
    const origin = await start({ objectService: objects });
    const mint = await fetch(`${origin}/v1/daemon/uploads`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'media',
        mimeType: 'application/pdf',
        size: 1024,
        sha256: 'a'.repeat(64),
      }),
      headers: { authorization: AGENT_TOKEN, 'content-type': 'application/json' },
    });
    expect(mint.status).toBe(201);
    await expect(mint.json()).resolves.toMatchObject({ objectId: UUID, deduped: false });

    const finalize = await fetch(`${origin}/v1/daemon/uploads/${UUID}/finalize`, {
      method: 'POST',
      headers: { authorization: AGENT_TOKEN },
    });
    expect(finalize.status).toBe(200);
    await expect(finalize.json()).resolves.toEqual({ state: 'ready' });

    const missing = objectService({
      finalizeUpload: vi.fn(async () => {
        throw new Error('object not found');
      }),
    } as never);
    const origin3 = await start({ objectService: missing as ObjectService });
    const notFound = await fetch(
      `${origin3}/v1/daemon/uploads/99999999-9999-4999-8999-999999999999/finalize`,
      { method: 'POST', headers: { authorization: AGENT_TOKEN } },
    );
    expect(notFound.status).toBe(404);
  });
});
