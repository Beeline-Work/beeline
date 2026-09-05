import { createHash } from 'node:crypto';
import { generateKeypair } from '@beeline/nostr';
import { describe, expect, it } from 'vitest';
import {
  alphaTenant,
  app,
  bindGitHubIdentity,
  database,
  githubState,
  startCookie,
  state,
  useAuthServerFixture,
} from './server-test-fixture.js';

const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('agent connect device exchange', () => {
  useAuthServerFixture();

  it('issues credentials once after a linked human approves the exact agent', async () => {
    const human = generateKeypair();
    await bindGitHubIdentity(human, 'd'.repeat(43));
    await database.client.exec(`
      CREATE TABLE channels (
        community_id uuid NOT NULL,
        id uuid PRIMARY KEY,
        name text NOT NULL,
        updated_at timestamptz NOT NULL,
        deleted_at timestamptz,
        archived_at timestamptz
      );
      CREATE TABLE channel_members (
        community_id uuid NOT NULL,
        channel_id uuid NOT NULL,
        pubkey bytea NOT NULL,
        removed_at timestamptz
      );
      CREATE TABLE events (
        community_id uuid NOT NULL,
        channel_id uuid,
        id bytea NOT NULL,
        kind integer NOT NULL,
        tags jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        deleted_at timestamptz
      );
    `);
    await database.query(
      `INSERT INTO channels (community_id, id, name, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Brass Works', now())`,
      [alphaTenant.roomCommunityIds[0], WORKSPACE],
    );
    await database.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey)
       VALUES ($1::uuid, $2::uuid, decode($3, 'hex'))`,
      [alphaTenant.roomCommunityIds[0], WORKSPACE, human.publicKey],
    );
    await database.query(
      `INSERT INTO events (community_id, channel_id, id, kind, tags, created_at)
       VALUES ($1::uuid, $2::uuid, decode($3, 'hex'), 9007, $4::jsonb, now())`,
      [
        alphaTenant.roomCommunityIds[0],
        WORKSPACE,
        '1'.repeat(64),
        JSON.stringify([
          ['h', WORKSPACE],
          ['community', WORKSPACE],
        ]),
      ],
    );

    const verifier = 'device-verifier-with-enough-entropy';
    const started = await app.inject({
      method: 'POST',
      url: '/auth/device/connect',
      headers: { host: alphaTenant.host },
      payload: {
        harness: 'pi',
        provider: 'openrouter',
        model: 'z-ai/glm-5.3-flash',
        soul: 'Warm, direct, and deeply practical.',
        agent_name: 'Piper',
        code_challenge: createHash('sha256').update(verifier).digest('hex'),
      },
    });
    expect(started.statusCode).toBe(201);
    const device = started.json<{
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
    }>();
    expect(device.verification_uri_complete).toContain(device.user_code);
    expect(started.body).not.toContain('secret_key');
    expect(started.body).not.toContain('pairing_code');

    const pending = await app.inject({
      method: 'POST',
      url: '/auth/device/token',
      headers: { host: alphaTenant.host },
      payload: { device_code: device.device_code, code_verifier: verifier },
    });
    expect(pending.statusCode).toBe(428);

    const approvalPage = await app.inject({
      method: 'GET',
      url: `/auth/device/connect?user_code=${device.user_code}`,
      headers: { host: alphaTenant.host },
    });
    expect(approvalPage.statusCode).toBe(302);
    expect(approvalPage.headers.location).toBe(
      `/auth/github/start?device_user_code=${device.user_code}`,
    );

    const approvalStart = await app.inject({
      method: 'GET',
      url: approvalPage.headers.location!,
      headers: { host: alphaTenant.host },
    });
    expect(approvalStart.statusCode).toBe(302);
    const approved = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=github-code&state=${githubState}`,
      headers: {
        host: alphaTenant.host,
        cookie: startCookie(approvalStart.headers['set-cookie']),
      },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.body).toContain('Agent connected');

    const token = await app.inject({
      method: 'POST',
      url: '/auth/device/token',
      headers: { host: alphaTenant.host },
      payload: { device_code: device.device_code, code_verifier: verifier },
    });
    expect(token.statusCode).toBe(200);
    const credentials = token.json<Record<string, string>>();
    expect(credentials).toMatchObject({
      workspace_id: WORKSPACE,
      workspace_name: 'Brass Works',
      paired_by: human.publicKey,
      agent_name: 'Piper',
      harness: 'pi',
      provider: 'openrouter',
      model: 'z-ai/glm-5.3-flash',
      soul: 'Warm, direct, and deeply practical.',
    });
    expect(credentials.agent_secret_key).toMatch(/^[0-9a-f]{64}$/);
    expect(credentials.body_secret_key).toMatch(/^[0-9a-f]{64}$/);
    expect(credentials.agent_pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(credentials.pairing_code).toMatch(/^[0-9A-F]{8}-[0-9A-F]{8}$/);

    const grant = await database.query<{ agent_pubkey: string; minter_pubkey: string }>(
      `SELECT encode(agent_pubkey, 'hex') AS agent_pubkey,
              encode(minter_pubkey, 'hex') AS minter_pubkey
       FROM beeline_agent_connect_grants
       WHERE token_hash = $1`,
      [createHash('sha256').update(credentials.pairing_code).digest('hex')],
    );
    expect(grant.rows).toEqual([
      { agent_pubkey: credentials.agent_pubkey, minter_pubkey: human.publicKey },
    ]);

    const replay = await app.inject({
      method: 'POST',
      url: '/auth/device/token',
      headers: { host: alphaTenant.host },
      payload: { device_code: device.device_code, code_verifier: verifier },
    });
    expect(replay.statusCode).toBe(409);
  });
});

describe('app-authorized agent connect', () => {
  useAuthServerFixture();

  // Neither a name nor a soul is sent: the server seeds both from the animal
  // it assigns out of the Workspace roster.
  const payload = {
    pairing_code: '1234ABCD-5678EF90',
    harness: 'codex',
    model: 'gpt-5.4',
  };
  const seeded = {
    status: 'claimed',
    workspaceId: WORKSPACE,
    workspaceName: 'Brass Works',
    pairedBy: 'a'.repeat(64),
    agentName: 'Foxy',
    soul: 'You are a fox.',
    face: 'fox',
    daemonExchangeToken: `bde_${'d'.repeat(43)}`,
  } as const;

  it('returns a complete grant immediately and reserves the app-minted code', async () => {
    let claimed: Parameters<typeof state.agentPairingClaim>[0] | undefined;
    state.agentPairingClaim = async (input) => {
      claimed = input;
      return seeded;
    };

    const response = await app.inject({
      method: 'POST',
      url: '/auth/agent/connect',
      headers: { host: alphaTenant.host },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Record<string, string>>()).toMatchObject({
      workspace_id: WORKSPACE,
      workspace_name: 'Brass Works',
      paired_by: 'a'.repeat(64),
      agent_name: 'Foxy',
      agent_face: 'fox',
      harness: 'codex',
      model: 'gpt-5.4',
      soul: 'You are a fox.',
      daemon_exchange_token: `bde_${'d'.repeat(43)}`,
    });
    expect(response.json<Record<string, string>>().agent_secret_key).toMatch(/^[0-9a-f]{64}$/);
    expect(response.json<Record<string, string>>().body_secret_key).toMatch(/^[0-9a-f]{64}$/);
    expect(response.json<Record<string, string>>().agent_pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(claimed).toMatchObject({ code: payload.pairing_code, model: 'gpt-5.4' });
    expect(claimed).not.toHaveProperty('agentName');
    expect(claimed).not.toHaveProperty('soul');
    expect(claimed?.agentPubkey).toBe(response.json<Record<string, string>>().agent_pubkey);
  });

  it('accepts a self-configured pi with no provider, and still refuses an unknown one', async () => {
    // C96: the wizard skips provider, key and model for a harness that
    // enumerated models itself. This service stores no provider, so refusing
    // that claim only broke connect for the harnesses already set up.
    state.agentPairingClaim = async () => seeded;
    const selfConfigured = await app.inject({
      method: 'POST',
      url: '/auth/agent/connect',
      headers: { host: alphaTenant.host },
      payload: { ...payload, harness: 'pi', provider: undefined, model: 'openai/gpt-5.5' },
    });
    expect(selfConfigured.statusCode).toBe(200);

    const named = await app.inject({
      method: 'POST',
      url: '/auth/agent/connect',
      headers: { host: alphaTenant.host },
      payload: {
        ...payload,
        harness: 'pi',
        provider: 'openrouter',
        model: 'openrouter/z-ai/glm-5.3-flash',
      },
    });
    expect(named.statusCode).toBe(200);

    const bogus = await app.inject({
      method: 'POST',
      url: '/auth/agent/connect',
      headers: { host: alphaTenant.host },
      payload: { ...payload, harness: 'pi', provider: 'not-a-provider', model: 'x' },
    });
    expect(bogus.statusCode).toBe(400);
    // A harness that supplies its own provider still may not be handed one.
    const overreach = await app.inject({
      method: 'POST',
      url: '/auth/agent/connect',
      headers: { host: alphaTenant.host },
      payload: { ...payload, harness: 'codex', provider: 'openrouter' },
    });
    expect(overreach.statusCode).toBe(400);
  });

  it('passes the event kinds the CLI subscribed to into the claim', async () => {
    let claimed: Parameters<typeof state.agentPairingClaim>[0] | undefined;
    state.agentPairingClaim = async (input) => {
      claimed = input;
      return seeded;
    };
    const response = await app.inject({
      method: 'POST',
      url: '/auth/agent/connect',
      headers: { host: alphaTenant.host },
      payload: { ...payload, event_subscriptions: [' Joined ', '', 42, 'check-failed'] },
    });
    expect(response.statusCode).toBe(200);
    // Trimmed and lowercased here; the monolith drops anything not a real kind.
    expect(claimed?.eventSubscriptions).toEqual(['joined', 'check-failed']);
  });

  it.each(['BUZZ-1234ABCD-5678EF90', 'not-a-pairing-code'])(
    'accepts legacy pairing codes but rejects garbage (%s)',
    async (pairingCode) => {
      state.agentPairingClaim = async () => seeded;
      const response = await app.inject({
        method: 'POST',
        url: '/auth/agent/connect',
        headers: { host: alphaTenant.host },
        payload: { ...payload, pairing_code: pairingCode },
      });
      expect(response.statusCode).toBe(pairingCode.startsWith('BUZZ-') ? 200 : 400);
    },
  );

  it.each([
    ['expired', 410, 'pairing code has expired'],
    ['already_claimed', 409, 'pairing code was already claimed'],
  ] as const)('returns a clear 4xx for a %s code', async (status, expectedCode, message) => {
    state.agentPairingClaim = async () => ({ status });
    const response = await app.inject({
      method: 'POST',
      url: '/auth/agent/connect',
      headers: { host: alphaTenant.host },
      payload,
    });
    expect(response.statusCode).toBe(expectedCode);
    expect(response.json()).toMatchObject({ message });
  });

  it('renames the connected agent through the pairing code, once', async () => {
    let renamed: Parameters<typeof state.agentConnectRename>[0] | undefined;
    state.agentConnectRename = async (input) => {
      renamed = input;
      return { status: 'renamed', agentName: input.name };
    };
    const response = await app.inject({
      method: 'POST',
      url: '/auth/agent/connect/name',
      headers: { host: alphaTenant.host },
      payload: { pairing_code: payload.pairing_code, agent_name: '  Bramble  ' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ agent_name: 'Bramble' });
    expect(renamed).toEqual({ code: payload.pairing_code, name: 'Bramble' });
  });

  it('refuses a rename once the connect window has closed', async () => {
    state.agentConnectRename = async () => ({ status: 'expired' });
    const response = await app.inject({
      method: 'POST',
      url: '/auth/agent/connect/name',
      headers: { host: alphaTenant.host },
      payload: { pairing_code: payload.pairing_code, agent_name: 'Bramble' },
    });
    expect(response.statusCode).toBe(410);
  });

  it('refuses a rename that is not a spoken name', async () => {
    state.agentConnectRename = async () => ({ status: 'renamed', agentName: 'x' });
    const response = await app.inject({
      method: 'POST',
      url: '/auth/agent/connect/name',
      headers: { host: alphaTenant.host },
      payload: { pairing_code: payload.pairing_code, agent_name: 'rm -rf /' },
    });
    expect(response.statusCode).toBe(400);
  });
});
