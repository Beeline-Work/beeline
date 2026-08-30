import { createHash, createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { generateKeypair, nip98AuthHeader, signEvent, type Keypair } from '@beeline/nostr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OidcClient } from './oidc.js';
import { GitHubAppClient, GitHubOAuthClient } from './github.js';
import { OIDC_BIND_KIND, OIDC_BIND_MARKER } from './protocol.js';
import { buildAuthServer } from './server.js';
import { AuthStore } from './store.js';
import type { FastifyInstance } from 'fastify';
import {
  DemoOidcProvider,
  PgliteDatabase,
  alphaTenant,
  betaTenant,
  bindEvent,
  startCookie,
  type BindChallenge,
} from './server-test-fixture.js';

describe('GitHub repository events in Rooms', () => {
  let provider: DemoOidcProvider;
  let database: PgliteDatabase;
  let store: AuthStore;
  let app: FastifyInstance;
  let roomTokenAuthority: NonNullable<
    Parameters<typeof buildAuthServer>[0]['authorizeGitHubRoomToken']
  >;

  const agent = generateKeypair();
  const ROOM_ID = 'room-1';
  const REPO = 'octocat/widget';

  function webhook(event: string, deliveryId: string, payload: unknown, secret = 'webhook-secret') {
    const body = JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url: '/auth/github/webhook',
      headers: {
        host: alphaTenant.host,
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
      payload: body,
    });
  }

  /** Deliver one of each shipped event type against `octocat/widget`. */
  async function deliverSampleEvents(prefix = 'd'): Promise<void> {
    await webhook('star', `${prefix}-star-1`, {
      action: 'created',
      starred_at: '2026-01-01T00:00:00Z',
      repository: { id: 42, full_name: REPO },
      sender: { login: 'lena' },
    });
    await webhook('issues', `${prefix}-issue-1`, {
      action: 'opened',
      issue: {
        number: 12,
        title: 'Fix login',
        html_url: `https://github.com/${REPO}/issues/12`,
        user: { login: 'lena' },
      },
      repository: { id: 42, full_name: REPO },
      sender: { login: 'lena' },
    });
    await webhook('pull_request', `${prefix}-pr-1`, {
      action: 'opened',
      pull_request: {
        number: 34,
        title: 'Add dark mode',
        html_url: `https://github.com/${REPO}/pull/34`,
        user: { login: 'lena' },
        merged: false,
      },
      repository: { id: 42, full_name: REPO },
      sender: { login: 'lena' },
    });
  }

  function roomEventsUrl(): string {
    return `${alphaTenant.origin}/auth/github/room-events`;
  }

  function fetchRoomEvents(
    identity: Keypair,
    options: { since?: number; waitMs?: number } = {},
    roomId = ROOM_ID,
  ) {
    const url = roomEventsUrl();
    return app.inject({
      method: 'POST',
      url: '/auth/github/room-events',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'POST'),
      },
      payload: {
        pubkey: identity.publicKey,
        room_id: roomId,
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(
            identity.secretKey,
            identity.publicKey,
            `${alphaTenant.origin}/query`,
            'POST',
          ),
        ),
        ...(options.since !== undefined ? { since: options.since } : {}),
        ...(options.waitMs !== undefined ? { wait_ms: options.waitMs } : {}),
      },
    });
  }

  beforeEach(async () => {
    provider = new DemoOidcProvider();
    await provider.start();
    const pglite = new PGlite();
    await pglite.waitReady;
    database = new PgliteDatabase(pglite);
    store = new AuthStore(database);
    await store.migrate();
    roomTokenAuthority = async () => ({ authorized: false, reason: 'agent_not_room_member' });
    app = buildAuthServer({
      store,
      oidc: new OidcClient({
        issuer: provider.issuer,
        authorizationEndpoint: `${provider.baseUrl}/authorize`,
        tokenEndpoint: `${provider.baseUrl}/token`,
        jwksUri: `${provider.baseUrl}/jwks`,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        allowInsecure: true,
      }),
      github: {
        oauth: {
          config: { clientId: 'github-client', clientSecret: 'github-secret' },
          authorizationUrl: ({ state, redirectUri }: { state: string; redirectUri: string }) =>
            `https://github.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
          exchangeCode: async () => ({
            issuer: 'https://github.com' as const,
            audience: 'github-client',
            subject: '123',
            login: 'octocat',
            accessToken: 'github-user-token',
          }),
        } as unknown as GitHubOAuthClient,
        app: {
          installationToken: async () => ({
            token: 'room-installation-token',
            expiresAt: '2030-01-01T00:00:00Z',
          }),
        } as unknown as GitHubAppClient,
        webhookSecret: 'webhook-secret',
      },
      authorizeGitHubRoomToken: (tenant, input) => roomTokenAuthority(tenant, input),
      tenants: [alphaTenant, betaTenant],
    });
  });

  afterEach(async () => {
    await app.close();
    await database.close();
    await provider.close();
  });

  it('stores a real star, issue, and pull request payload and releases it to an authorized Room', async () => {
    await deliverSampleEvents();
    roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === ROOM_ID
        ? { authorized: true, authorizedBy: agent.publicKey, fullName: REPO }
        : { authorized: false, reason: 'agent_not_room_member' };

    // Bootstrap read (no cursor): nothing old, just the position to start from.
    const bootstrap = await fetchRoomEvents(agent);
    expect(bootstrap.statusCode).toBe(200);
    const bootstrapped = bootstrap.json();
    expect(bootstrapped.full_name).toBe(REPO);
    expect(bootstrapped.events).toEqual([]);
    expect(bootstrapped.cursor).toBe(bootstrapped.head);
    expect(bootstrapped.head).toBeGreaterThan(0);

    const feed = await fetchRoomEvents(agent, { since: bootstrapped.cursor - 3 });
    expect(feed.statusCode).toBe(200);
    const events = feed.json().events;
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      'star',
      'issues',
      'pull_request',
    ]);
    expect(events[1]).toMatchObject({
      actor: 'lena',
      number: 12,
      title: 'Fix login',
      summary: 'lena opened issue #12 in octocat/widget: Fix login',
    });
    expect(events[2]).toMatchObject({
      actor: 'lena',
      number: 34,
      summary: 'lena opened pull request #34 in octocat/widget: Add dark mode',
    });
    expect(feed.json().cursor).toBe(feed.json().head);
  });

  it('rejects a webhook with an invalid signature before storing anything', async () => {
    const badSignature = await webhook(
      'star',
      'sig-star-1',
      {
        action: 'created',
        repository: { id: 42, full_name: REPO },
        sender: { login: 'lena' },
      },
      'wrong-secret',
    );
    expect(badSignature.statusCode).toBe(401);

    roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: agent.publicKey,
      fullName: REPO,
    });
    const bootstrap = await fetchRoomEvents(agent);
    expect(bootstrap.json().head).toBe(0);
  });

  it('collapses a duplicate delivery to one stored event', async () => {
    const payload = {
      action: 'created',
      repository: { id: 42, full_name: REPO },
      sender: { login: 'lena' },
    };
    const first = await webhook('star', 'dup-star-1', payload);
    expect(first.json()).toMatchObject({ accepted: true });
    const duplicate = await webhook('star', 'dup-star-1', payload);
    expect(duplicate.json()).toMatchObject({ accepted: true, duplicate: true });

    roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: agent.publicKey,
      fullName: REPO,
    });
    const feed = await fetchRoomEvents(agent, { since: 0 });
    expect(feed.json().events).toHaveLength(1);
  });

  it('stays silent on unreported actions and unrelated event types', async () => {
    // A `labeled` issue action is churn, never a Room notice.
    await webhook('issues', 'noise-issue-labeled', {
      action: 'labeled',
      issue: { number: 12, title: 'Fix login', user: { login: 'lena' } },
      repository: { id: 42, full_name: REPO },
      sender: { login: 'lena' },
    });
    // Deploy status is out of scope entirely.
    await webhook('deployment_status', 'noise-deploy', {
      action: 'created',
      repository: { id: 42, full_name: REPO },
      sender: { login: 'lena' },
    });

    roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: agent.publicKey,
      fullName: REPO,
    });
    const bootstrap = await fetchRoomEvents(agent);
    expect(bootstrap.json().head).toBe(0);
  });

  it('refuses a daemon that is not a member of a Room bound to the repo', async () => {
    await deliverSampleEvents();
    roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === ROOM_ID
        ? { authorized: true, authorizedBy: agent.publicKey, fullName: REPO }
        : { authorized: false, reason: 'agent_not_room_member' };

    const stranger = generateKeypair();
    const refused = await fetchRoomEvents(stranger, { since: 0 }, 'some-other-room');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({
      error: 'room_membership_required',
      message: 'agent is not a member of this Room',
    });

    // And a Room bound to a DIFFERENT repo reads that repo's feed, not ours.
    roomTokenAuthority = async (_tenant, input) => ({
      authorized: input.agentPubkey === agent.publicKey && input.roomId === 'other-room',
      authorizedBy: agent.publicKey,
      fullName: 'acme/other',
      ...(input.agentPubkey === agent.publicKey && input.roomId === 'other-room'
        ? {}
        : { reason: 'room_repository_missing' as const }),
    });
    const otherRoom = await fetchRoomEvents(agent, { since: 0 }, 'other-room');
    expect(otherRoom.statusCode).toBe(200);
    expect(otherRoom.json().full_name).toBe('acme/other');
    expect(otherRoom.json().events).toEqual([]);
    expect(otherRoom.json().head).toBe(0); // never leaks widget's activity
  });

  it('releases events late to a daemon whose cursor predates the outage window', async () => {
    await deliverSampleEvents('early');
    roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: agent.publicKey,
      fullName: REPO,
    });
    const first = await fetchRoomEvents(agent, { since: 0 });
    const cursorAfterEarly = first.json().cursor;

    // The daemon goes offline; more activity lands while it is away.
    await deliverSampleEvents('late');

    // Back online: catches up from its persisted cursor.
    const catchUp = await fetchRoomEvents(agent, { since: cursorAfterEarly });
    expect(catchUp.statusCode).toBe(200);
    const caught = catchUp.json();
    expect(caught.events).toHaveLength(3);
    // Only NEW events (ids past the persisted cursor), never a replay.
    for (const event of caught.events) {
      expect(event.id).toBeGreaterThan(cursorAfterEarly);
    }
  });
});
