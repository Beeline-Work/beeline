import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import { GitHubOperations } from './github-operations.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import { isRoomView } from '@beeline/api-contract/phone';

const HUMAN = createHash('sha256').update('github:owner').digest('hex');
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');

describe('DM attachments', () => {
  let database: PgliteDatabase;
  let auth: TokenAuth;
  let origin: string;
  let server: ReturnType<typeof createBeelineServer>;
  let accessToken: string;
  let daemonToken: string;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await new AuthStore(database as unknown as TransactionalDatabase).migrate();
    await database.query(
      `INSERT INTO identities(id,kind,name,handle,github_subject) VALUES($1,'human','Owner','owner','owner'),($2,'agent','Bee','bee',NULL)`,
      [HUMAN, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
      [WORKSPACE, HUMAN, AGENT],
    );
    auth = new TokenAuth(database, async (proof) => {
      const login = proof === 'proof' ? 'owner' : proof;
      return { subject: login, login, name: login };
    });
    const githubOperations = new GitHubOperations(
      database,
      {
        authorizationUrl: ({ state }: { state: string }) => `https://github.test/?state=${state}`,
        exchangeCode: async () => ({
          issuer: 'https://github.com' as const,
          audience: 'oauth-client-id',
          subject: 'owner',
          login: 'owner',
          displayName: 'Owner',
          accessToken: 'github-user-token',
        }),
      } as unknown as GitHubOAuthClient,
      {} as unknown as GitHubAppClient,
      'github-client-secret',
    );
    vi.spyOn(githubOperations, 'refresh').mockResolvedValue({});
    const live = new LiveHub();
    const phone = new PhoneService(database, 'http://placeholder', githubOperations, vi.fn());
    const daemon = new DaemonService(database, live, async () => ({
      token: 'github-room-token',
      expiresAt: Date.now() + 60_000,
    }));
    server = createBeelineServer({
      database,
      auth,
      phone,
      daemon,
      live,
      mediaMaximumBytes: 1024 * 1024,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    (phone as unknown as { publicOrigin: string }).publicOrigin = origin;
    accessToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
    const exchange = await auth.createDaemonExchange(AGENT);
    daemonToken = (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (database) await database.close();
  });

  const request = async (path: string, method = 'GET', payload?: unknown, token = accessToken) =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
  const operation = (name: string, payload: unknown, token = accessToken) =>
    request(`/v1/phone/operations/${name}`, 'POST', payload, token);
  const daemonOperation = (name: string, payload: unknown) =>
    request(`/v1/daemon/operations/${name}`, 'POST', payload, daemonToken);

  const uploadPng = async () => {
    const upload = await fetch(`${origin}/v1/phone/media`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'image/png',
        'x-file-name': 'tiny.png',
      },
      body: PNG_BYTES,
    });
    expect(upload.status).toBe(201);
    const attachment = (await upload.json()) as {
      url: string;
      name: string;
      mimeType: string;
      size: number;
    };
    expect(attachment.url).toMatch(/^http/);
    return attachment;
  };

  const expectAttachment = (value: unknown) => {
    expect(value).toEqual([
      expect.objectContaining({
        url: expect.stringMatching(/^http/),
        name: 'tiny.png',
        mimeType: 'image/png',
        size: PNG_BYTES.byteLength,
      }),
    ]);
  };

  it('round-trips an uploaded file through a DM for every read surface', async () => {
    const dm = (await (
      await operation('resolveDirectMessage', { workspaceId: WORKSPACE, participantId: AGENT })
    ).json()) as { id: string };

    const attachment = await uploadPng();
    const sent = await operation('sendRoomMessage', {
      roomId: dm.id,
      messageId: 'a'.repeat(64),
      text: 'here is a file',
      attachments: [
        { url: attachment.url, name: 'tiny.png', mimeType: 'image/png', size: attachment.size },
      ],
    });
    expect(sent.status).toBe(200);

    // The bytes are fetchable by the peer.
    const bytes = await fetch(attachment.url);
    expect(bytes.status).toBe(200);
    expect(Buffer.from(await bytes.arrayBuffer())).toEqual(PNG_BYTES);

    // Signed Room view (what the phone paints).
    const view = (await (await request(`/v1/phone/rooms/${dm.id}`)).json()) as {
      messages: Array<{ id: string; attachments?: unknown }>;
    };
    expect(isRoomView(view)).toBe(true);
    expectAttachment(view.messages.find((m) => m.id === 'a'.repeat(64))?.attachments);

    // History read.
    const history = (await (
      await request(`/v1/phone/rooms/${dm.id}/history?before=${'a'.repeat(64)}`)
    ).json()) as { messages?: Array<{ id: string; attachments?: unknown }> };
    expectAttachment(history.messages?.find((m) => m.id === 'a'.repeat(64))?.attachments);

    // The agent peer's conversation read, both bounded and incremental.
    const conversation = (await (
      await daemonOperation('getRoomConversation', { roomId: dm.id, limit: 50 })
    ).json()) as { items: Array<{ id: string; attachments?: unknown }> };
    expectAttachment(conversation.items.find((item) => item.id === 'a'.repeat(64))?.attachments);

    const incremental = (await (
      await daemonOperation('getRoomConversation', { roomId: dm.id, after: `0,${'0'.repeat(64)}` })
    ).json()) as { items: Array<{ id: string; attachments?: unknown }> };
    expectAttachment(incremental.items.find((item) => item.id === 'a'.repeat(64))?.attachments);
  });

  it('round-trips a file attached to a DM reply', async () => {
    const dm = (await (
      await operation('resolveDirectMessage', { workspaceId: WORKSPACE, participantId: AGENT })
    ).json()) as { id: string };

    const first = await operation('sendRoomMessage', {
      roomId: dm.id,
      messageId: 'c'.repeat(64),
      text: 'seed message',
    });
    expect(first.status).toBe(200);

    const attachment = await uploadPng();
    const reply = await operation('sendRoomReply', {
      roomId: dm.id,
      messageId: 'd'.repeat(64),
      parentMessageId: 'c'.repeat(64),
      text: 'the file you asked about',
      attachments: [
        { url: attachment.url, name: 'tiny.png', mimeType: 'image/png', size: attachment.size },
      ],
    });
    expect(reply.status).toBe(200);

    const view = (await (await request(`/v1/phone/rooms/${dm.id}`)).json()) as {
      messages: Array<{ id: string; attachments?: unknown }>;
    };
    expectAttachment(view.messages.find((m) => m.id === 'd'.repeat(64))?.attachments);
  });

  it('treats a group Room the same way', async () => {
    const group = (await (
      await operation('createRoom', { workspaceId: WORKSPACE, name: 'Files' })
    ).json()) as { id: string };

    const attachment = await uploadPng();
    const sent = await operation('sendRoomMessage', {
      roomId: group.id,
      messageId: 'e'.repeat(64),
      text: 'group file',
      attachments: [
        { url: attachment.url, name: 'tiny.png', mimeType: 'image/png', size: attachment.size },
      ],
    });
    expect(sent.status).toBe(200);

    const view = (await (await request(`/v1/phone/rooms/${group.id}`)).json()) as {
      messages: Array<{ id: string; attachments?: unknown }>;
    };
    expectAttachment(view.messages.find((m) => m.id === 'e'.repeat(64))?.attachments);
  });
});
