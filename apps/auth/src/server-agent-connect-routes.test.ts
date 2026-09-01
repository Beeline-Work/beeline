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
    expect(credentials.pairing_code).toMatch(/^BUZZ-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

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

  const payload = {
    pairing_code: '1234ABCD-5678EF90',
    harness: 'codex',
    model: 'gpt-5.4',
    soul: 'Brisk, practical, and kind.',
    agent_name: 'Scout',
  };

  it('returns a complete grant immediately and reserves the app-minted code', async () => {
    let claimed: Parameters<typeof state.agentPairingClaim>[0] | undefined;
    state.agentPairingClaim = async (input) => {
      claimed = input;
      return {
        status: 'claimed',
        workspaceId: WORKSPACE,
        workspaceName: 'Brass Works',
        pairedBy: 'a'.repeat(64),
        daemonExchangeToken: `bde_${'d'.repeat(43)}`,
      };
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
      agent_name: 'Scout',
      harness: 'codex',
      model: 'gpt-5.4',
      soul: payload.soul,
      daemon_exchange_token: `bde_${'d'.repeat(43)}`,
    });
    expect(response.json<Record<string, string>>().agent_secret_key).toMatch(/^[0-9a-f]{64}$/);
    expect(response.json<Record<string, string>>().body_secret_key).toMatch(/^[0-9a-f]{64}$/);
    expect(response.json<Record<string, string>>().agent_pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(claimed).toMatchObject({
      code: payload.pairing_code,
      agentName: 'Scout',
      model: 'gpt-5.4',
      soul: payload.soul,
    });
    expect(claimed?.agentPubkey).toBe(response.json<Record<string, string>>().agent_pubkey);
  });

  it.each(['BUZZ-1234ABCD-5678EF90', 'not-a-pairing-code'])(
    'accepts legacy pairing codes but rejects garbage (%s)',
    async (pairingCode) => {
      state.agentPairingClaim = async () => ({
        status: 'claimed',
        workspaceId: WORKSPACE,
        workspaceName: 'Brass Works',
        pairedBy: 'a'.repeat(64),
        daemonExchangeToken: `bde_${'d'.repeat(43)}`,
      });
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
});
