import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  APP_FILE_MAXIMUM_BYTES, ComposioApps, composioToolkitForApp, resolveAppFiles, type AppFile,
} from './composio-apps.js';

const PERSON = 'a'.repeat(64);
const ACCOUNT = 'ca_fixture';
const json = (value: unknown, status = 200) => Response.json(value, { status });

describe('managed app provider boundary', () => {
  it('uses an identity id and v3 Connect Links for a managed OAuth toolkit', async () => {
    const calls: { path: string; body?: Record<string, unknown> }[] = [];
    const transport = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path.endsWith('/auth_configs')) return json({ items: [{ id: 'ac_fixture',
        toolkit: { slug: 'gmail' }, auth_scheme: 'OAUTH2', is_composio_managed: true,
        status: 'ENABLED' }] });
      if (path.endsWith('/connected_accounts/link')) return json({
        redirect_url: 'https://app.composio.dev/connect/fixture',
        connected_account_id: ACCOUNT, expires_at: new Date(Date.now() + 600_000).toISOString(),
      }, 201);
      throw new Error('unexpected request');
    });
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    const link = await provider.link(PERSON, 'gmail');
    expect(link.accountId).toBe(ACCOUNT);
    expect(calls.at(-1)).toEqual({ path: '/api/v3/connected_accounts/link',
      body: { auth_config_id: 'ac_fixture', user_id: PERSON } });
    expect(JSON.stringify(calls)).not.toContain('@');
  });

  it('verifies the returning signed-in identity through the single-use completion API', async () => {
    const transport = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(new URL(String(url)).pathname).toBe('/api/v3.1/connected_accounts/complete_auth');
      const body = JSON.parse(String(init?.body)) as { user_id: string; session_uri: string };
      if (body.user_id !== PERSON) return json({}, 400);
      expect(body.session_uri).toBe('session-fixture');
      return json({ connected_account_id: ACCOUNT, toolkit_slug: 'gmail' });
    });
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    await expect(provider.completeAuth('session-fixture', 'b'.repeat(64)))
      .rejects.toThrow('App provider request failed (400)');
    await expect(provider.completeAuth('session-fixture', PERSON)).resolves.toEqual({
      accountId: ACCOUNT, toolkit: 'gmail',
    });
  });

  it('pins execution to one account, person and toolkit and removes secret-shaped fields', async () => {
    const transport = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith(`/connected_accounts/${ACCOUNT}`)) return json({
        id: ACCOUNT, user_id: PERSON, status: 'ACTIVE', toolkit: { slug: 'slack' },
      });
      if (path.endsWith('/tools/SLACK_POST_MESSAGE')) return json({
        slug: 'SLACK_POST_MESSAGE', version: '20260928_00', toolkit: { slug: 'slack' },
      });
      if (path.endsWith('/tools/execute/SLACK_POST_MESSAGE')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          connected_account_id: ACCOUNT, user_id: PERSON,
          arguments: { channel: 'announcements', text: 'Hello' },
          version: '20260928_00',
        });
        return json({ data: { ok: true, access_token: 'hidden', nested: { apiKey: 'hidden' } } });
      }
      throw new Error('unexpected request');
    });
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    await expect(provider.execute({ accountId: ACCOUNT, userId: PERSON, toolkit: 'slack',
      tool: 'SLACK_POST_MESSAGE', arguments: { channel: 'announcements', text: 'Hello' } }))
      .resolves.toEqual({ ok: true, nested: {} });
  });

  it('maps Google product names to separate managed OAuth toolkits', () => {
    expect(['Gmail', 'Calendar', 'Drive', 'Docs', 'Sheets'].map((name) =>
      composioToolkitForApp(name.toLowerCase()))).toEqual([
      'gmail', 'googlecalendar', 'googledrive', 'googledocs', 'googlesheets',
    ]);
  });

  describe('Room files for file-upload parameters', () => {
    const OBJECT = '0b1e7c3a-6d2f-4c1a-9e8b-5a4d3c2b1a00';
    const S3KEY = 'uploads/youtube/fixture-s3key.mp4';
    const PRESIGNED = 'https://composio-files.s3.amazonaws.com/uploads/youtube/fixture-s3key.mp4?X-Amz-Signature=sig';
    const VIDEO = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    const youtubeDefinition = {
      slug: 'YOUTUBE_UPLOAD_VIDEO', version: '20260930_00', toolkit: { slug: 'youtube' },
      input_parameters: { type: 'object', properties: {
        title: { type: 'string' },
        privacyStatus: { type: 'string' },
        videoFile: { $ref: '#/$defs/FileUploadable' },
      }, $defs: { FileUploadable: { type: 'object', file_uploadable: true, properties: {
        name: { type: 'string' }, mimetype: { type: 'string' }, s3key: { type: 'string' },
      } } } },
    };
    const video = (overrides: Partial<AppFile> = {}): AppFile => ({
      name: 'clip.mp4', mimeType: 'application/octet-stream', size: VIDEO.length,
      read: vi.fn(async () => VIDEO), ...overrides,
    });

    function youtubeTransport(executeData: unknown = { id: 'yt-video-1', status: 'private' }) {
      const calls: { method: string; url: string; headers: Record<string, string>;
        body?: unknown }[] = [];
      const transport = vi.fn(async (url: URL | string, init?: RequestInit) => {
        const href = String(url);
        const body = init?.body instanceof Uint8Array ? init.body
          : init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method: init?.method ?? 'GET', url: href,
          headers: (init?.headers ?? {}) as Record<string, string>, ...(body ? { body } : {}) });
        if (href === PRESIGNED) return new Response(null, { status: 200 });
        const path = new URL(href).pathname;
        if (path.endsWith(`/connected_accounts/${ACCOUNT}`)) return json({
          id: ACCOUNT, user_id: PERSON, status: 'ACTIVE', toolkit: { slug: 'youtube' },
        });
        if (path.endsWith('/tools/YOUTUBE_UPLOAD_VIDEO')) return json(youtubeDefinition);
        if (path === '/api/v3.1/files/upload/request') return json({
          id: 'file-1', key: S3KEY, new_presigned_url: PRESIGNED, type: 'new',
          metadata: { storage_backend: 's3' },
        });
        if (path.endsWith('/tools/execute/YOUTUBE_UPLOAD_VIDEO')) return json({ data: executeData });
        throw new Error('unexpected request');
      });
      return { transport, calls };
    }

    it('stages a Room video through the Files API and executes with the Composio descriptor', async () => {
      const { transport, calls } = youtubeTransport({ id: 'yt-video-1', status: 'private',
        uploaded: { s3key: S3KEY, source: PRESIGNED } });
      const provider = new ComposioApps('fixture-only', transport as typeof fetch);
      const file = video();
      const files = vi.fn(async (id: string) => {
        expect(id).toBe(OBJECT);
        return file;
      });
      const args = { title: 'Song', privacyStatus: 'private', videoFile: { beelineObjectId: OBJECT } };
      const result = await provider.execute({ accountId: ACCOUNT, userId: PERSON, toolkit: 'youtube',
        tool: 'YOUTUBE_UPLOAD_VIDEO', arguments: args, files: await resolveAppFiles(args, files) });
      expect(calls.map((call) => `${call.method} ${call.url.split('?')[0]}`)).toEqual([
        `GET https://backend.composio.dev/api/v3/connected_accounts/${ACCOUNT}`,
        'GET https://backend.composio.dev/api/v3/tools/YOUTUBE_UPLOAD_VIDEO',
        'POST https://backend.composio.dev/api/v3.1/files/upload/request',
        `PUT ${PRESIGNED.split('?')[0]}`,
        'POST https://backend.composio.dev/api/v3/tools/execute/YOUTUBE_UPLOAD_VIDEO',
      ]);
      expect(calls[2]!.body).toEqual({ toolkit_slug: 'youtube', tool_slug: 'YOUTUBE_UPLOAD_VIDEO',
        filename: 'clip.mp4', mimetype: 'video/mp4',
        md5: createHash('md5').update(VIDEO).digest('hex') });
      expect(calls[3]!.body).toEqual(VIDEO);
      expect(calls[3]!.headers).toEqual({ 'content-type': 'video/mp4' });
      expect(calls[4]!.body).toEqual({ connected_account_id: ACCOUNT, user_id: PERSON,
        version: '20260930_00', arguments: { title: 'Song', privacyStatus: 'private',
          videoFile: { name: 'clip.mp4', mimetype: 'video/mp4', s3key: S3KEY } } });
      expect(result).toEqual({ id: 'yt-video-1', status: 'private',
        uploaded: { s3key: '[staged file]', source: '[staged file]' } });
      const returned = JSON.stringify(result);
      for (const hidden of ['fixture-only', S3KEY, PRESIGNED, 'composio-files'])
        expect(returned).not.toContain(hidden);
    });

    it('keeps the staging key and upload URL out of a failed execution message', async () => {
      const { transport } = youtubeTransport();
      const failing = vi.fn(async (url: URL | string, init?: RequestInit) =>
        String(url).includes('/tools/execute/')
          ? Promise.reject(new Error(`provider rejected ${S3KEY} from ${PRESIGNED}`))
          : transport(url, init));
      const provider = new ComposioApps('fixture-only', failing as typeof fetch);
      const args = { videoFile: { beelineObjectId: OBJECT } };
      const error = await provider.execute({ accountId: ACCOUNT, userId: PERSON, toolkit: 'youtube',
        tool: 'YOUTUBE_UPLOAD_VIDEO', arguments: args,
        files: await resolveAppFiles(args, async () => video()) }).catch((e: unknown) => e as Error);
      expect(error.message).toBe('provider rejected [staged file] from [staged file]');
    });

    it('refuses an oversize or disallowed Room file without reading its bytes', async () => {
      const long = video({ name: 'long.mp4', size: APP_FILE_MAXIMUM_BYTES + 1 });
      await expect(resolveAppFiles({ videoFile: { beelineObjectId: OBJECT } }, async () => long))
        .rejects.toThrow('Room file is larger than the 128 MB app tool limit');
      expect(long.read).not.toHaveBeenCalled();
      await expect(resolveAppFiles({ videoFile: { beelineObjectId: OBJECT } },
        async () => video({ name: 'page.html', mimeType: 'text/html' })))
        .rejects.toThrow('Room file type text/html cannot be sent to an app tool');
      await expect(resolveAppFiles({ videoFile: { beelineObjectId: 7 } }, async () => video()))
        .rejects.toThrow('beelineObjectId must be a Room object id');
    });

    it('will not execute a Room file reference that was never resolved', async () => {
      const { transport } = youtubeTransport();
      const provider = new ComposioApps('fixture-only', transport as typeof fetch);
      await expect(provider.execute({ accountId: ACCOUNT, userId: PERSON, toolkit: 'youtube',
        tool: 'YOUTUBE_UPLOAD_VIDEO', arguments: { videoFile: { beelineObjectId: OBJECT } } }))
        .rejects.toThrow('Room files are unavailable for app tools');
      expect(transport).not.toHaveBeenCalled();
    });

    it('refuses a Room file at a parameter the tool does not mark as a file upload', async () => {
      const { transport, calls } = youtubeTransport();
      const provider = new ComposioApps('fixture-only', transport as typeof fetch);
      const args = { title: { beelineObjectId: OBJECT } };
      await expect(provider.execute({ accountId: ACCOUNT, userId: PERSON, toolkit: 'youtube',
        tool: 'YOUTUBE_UPLOAD_VIDEO', arguments: args,
        files: await resolveAppFiles(args, async () => video()) }))
        .rejects.toThrow('A Room file was passed for a parameter that does not take a file');
      expect(calls.map((call) => call.method)).toEqual(['GET', 'GET']);
    });

    it('leaves a call without Room files exactly as before', async () => {
      const { transport, calls } = youtubeTransport();
      const provider = new ComposioApps('fixture-only', transport as typeof fetch);
      const resolve = vi.fn();
      const descriptor = { name: 'clip.mp4', mimetype: 'video/mp4', s3key: 'already-staged' };
      const args = { title: 'Song', videoFile: descriptor };
      const files = await resolveAppFiles(args, resolve);
      expect(files.size).toBe(0);
      expect(resolve).not.toHaveBeenCalled();
      await provider.execute({ accountId: ACCOUNT, userId: PERSON, toolkit: 'youtube',
        tool: 'YOUTUBE_UPLOAD_VIDEO', arguments: args, files });
      expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST']);
      expect(calls[2]!.body).toEqual({ connected_account_id: ACCOUNT, user_id: PERSON,
        arguments: { title: 'Song', videoFile: descriptor }, version: '20260930_00' });
    });
  });
});
