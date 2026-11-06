import { phoneFetch } from '../../../../tests/helpers/phone-operation.js';
import { createAgentCommand, claimAgentCommand } from '.././agent-command.js';
import { createHash, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import type WebSocket from 'ws';
import { migrate } from '.././database.js';
import { MemoryObjectStorage, PgliteDatabase, migratedDatabase } from '.././test-support.js';
import { ObjectService } from '.././object-service.js';
import { TokenAuth } from '.././auth.js';
import { PhoneService } from '.././phone-service.js';
import { HelperDaemonService as DaemonService } from '.././test-fixtures/helper-daemon.js';
import { LiveHub } from '.././live.js';
import { createBeelineServer } from '.././server.js';
import { GitHubOperations } from '.././github-operations.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import { createMonolithAuth, type MonolithAuthMount } from '.././monolith-auth.js';
import { ReviewAccess } from '.././review-access.js';
import { taggedIdentityIdsSql } from '.././message-mentions.js';


/** Who a message tags, read the way every surface reads it: from its own text. */
export async function taggedBy(database: PgliteDatabase, messageId: string): Promise<string[]> {
  return (
    (
      await database.query<{ tagged_ids: string[] }>(
        `SELECT ${taggedIdentityIdsSql('m')} tagged_ids FROM messages m WHERE m.id=$1`,
        [messageId],
      )
    ).rows[0]?.tagged_ids ?? []
  );
}


/** Which agents a message actually started a turn for. */
export async function wokenBy(database: PgliteDatabase, messageId: string): Promise<string[]> {
  return (
    await database.query<{ agent_id: string }>(
      `SELECT agent_id FROM agent_commands WHERE source_message_id=$1 ORDER BY agent_id`,
      [messageId],
    )
  ).rows.map((row) => row.agent_id);
}


export const HUMAN = createHash('sha256').update('github:owner').digest('hex');

export const AGENT = 'b'.repeat(64);

export const WORKSPACE = '11111111-1111-4111-8111-111111111111';

export const REVIEW_SECRET = 'play-review-secret-value-0001';

export const WELCOME_AGENT = 'c'.repeat(64);

export const ROOM = '22222222-2222-4222-8222-222222222222';


export function next(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (value.type !== type) return;
      cleanup();
      resolve(value);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('websocket event timeout'));
    }, 3000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
    };
    socket.on('message', onMessage);
  });
}

export function monolithFixture() {

  let database: PgliteDatabase;

  let live: LiveHub;

  let auth: TokenAuth;

  let origin: string;

  let server: ReturnType<typeof createBeelineServer>;

  let accessToken: string;

  let daemonToken: string;

  let sendPushTest: ReturnType<typeof vi.fn>;

  let mountedAuth: MonolithAuthMount;

  let completeInstallation: ReturnType<typeof vi.fn>;

  let processWebhook: ReturnType<typeof vi.fn>;

  let githubOperations: GitHubOperations;

  let phone: PhoneService;

  let objectStorage: MemoryObjectStorage;

  let objectService: ObjectService;

  let githubApp: {
    deleteBranch: ReturnType<typeof vi.fn>;
    branchDeletionSafety: ReturnType<typeof vi.fn>;
    openPullRequestsForBranch: ReturnType<typeof vi.fn>;
    mergePullRequest: ReturnType<typeof vi.fn>;
    installationToken: ReturnType<typeof vi.fn>;
    readCommitCheckRollup: ReturnType<typeof vi.fn>;
  };

  let githubRollupState: 'pending' | 'passed' | 'failed';

  let roomTokenFailure: Error | undefined;

  // Export only migrated schema; every test owns a new database and fresh seed rows.
  let databaseSnapshot: Blob | File;

  beforeAll(async () => {
    const template = await migratedDatabase();
    try {
      await new AuthStore(template as unknown as TransactionalDatabase).migrate();
      databaseSnapshot = await template.snapshot();
    } finally {
      await template.close();
    }
  });


  beforeEach(async () => {
    roomTokenFailure = undefined;
    database = PgliteDatabase.fromSnapshot(databaseSnapshot);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle,github_subject) VALUES($1,'human','Owner','owner','owner'),($2,'agent','Bee','bee',NULL)`,
      [HUMAN, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
      [WORKSPACE, HUMAN, AGENT, ROOM],
    );
    auth = new TokenAuth(database, async (proof) => {
      const login = proof === 'proof' ? 'owner' : proof === 'recipient-proof' ? 'recipient' : proof;
      return { subject: login, login, name: login[0]!.toUpperCase() + login.slice(1) };
    });
    githubRollupState = 'pending';
    githubApp = {
      deleteBranch: vi.fn(async () => undefined),
      branchDeletionSafety: vi.fn(async () => ({ defaultBranch: 'main', aheadBy: 0, protected: false, openBasePullRequest: false })),
      openPullRequestsForBranch: vi.fn(async () => []),
      mergePullRequest: vi.fn(async () => undefined),
      installationToken: vi.fn(async () => ({
        token: 'github-room-token',
        expiresAt: '2030-01-01T00:00:00Z',
      })),
      readCommitCheckRollup: vi.fn(async () => ({
        state: githubRollupState,
        total: 1,
        failing: githubRollupState === 'failed' ? ['typecheck'] : [],
        checks: [{ name: 'typecheck', status: githubRollupState }],
      })),
    };
    githubOperations = new GitHubOperations(
      database,
      {
        authorizationUrl: ({ state, redirectUri }: { state: string; redirectUri: string }) =>
          `https://github.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
        exchangeCode: async () => ({
          issuer: 'https://github.com' as const,
          audience: 'oauth-client-id',
          subject: 'owner',
          login: 'owner',
          displayName: 'Owner',
          accessToken: 'github-user-token',
        }),
      } as unknown as GitHubOAuthClient,
      githubApp as unknown as GitHubAppClient,
      'github-client-secret',
    );
    vi.spyOn(githubOperations, 'refresh').mockResolvedValue({});
    vi.spyOn(githubOperations, 'beginInstallation').mockResolvedValue({
      url: 'https://github.com/apps/beeline-test/installations/new?state=server-state',
    });
    vi.spyOn(githubOperations, 'createRepository').mockImplementation(async (_viewerId, input) => ({
      id: 102,
      fullName: `owner/${input.name}`,
      installationId: input.installationId,
      defaultBranch: 'main',
      private: input.private !== false,
    }));
    sendPushTest = vi.fn(async () => undefined);
    objectStorage = new MemoryObjectStorage();
    await objectStorage.listen();
    objectService = new ObjectService(
      database,
      objectStorage.asStorage(),
      'http://placeholder',
      1024 * 1024,
    );
    phone = new PhoneService(
      database,
      'http://placeholder',
      githubOperations,
      sendPushTest,
      undefined,
      false,
      database,
      objectService,
      undefined,
    );
    live = new LiveHub();
    const daemon = new DaemonService(
      database,
      live,
      async () => ({
        token: 'github-room-token',
        expiresAt: Date.now() + 60_000,
      }),
      undefined,
      false,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
    );
    mountedAuth = await createMonolithAuth(database, 'https://server.test', undefined, {
      createDaemonExchange: (agentId, transaction) =>
        auth.createDaemonExchange(agentId, transaction),
      env: {
        NODE_ENV: 'test',
        BEELINE_AUTH_TENANTS_JSON: JSON.stringify([
          {
            host: 'server.test',
            community: 'integration-community',
            roomCommunityIds: ['integration-community'],
            origin: 'https://server.test',
          },
        ]),
        BEELINE_AUTH_OIDC_ISSUER: 'https://accounts.example',
        BEELINE_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.example/authorize',
        BEELINE_AUTH_OIDC_TOKEN_ENDPOINT: 'https://accounts.example/token',
        BEELINE_AUTH_OIDC_JWKS_URI: 'https://accounts.example/jwks',
        BEELINE_AUTH_OIDC_CLIENT_ID: 'test-client',
      },
    });
    completeInstallation = vi.fn(async () => 'beeline://buzz/github-installation?installed=1');
    processWebhook = vi.fn(async () => undefined);
    server = createBeelineServer({
      database,
      auth,
      phone,
      daemon,
      live,
      review: new ReviewAccess({
        secret: REVIEW_SECRET,
        mint: () => auth.exchangeReviewIdentity(),
        log: () => undefined,
      }),
      authHandler: mountedAuth.handle,
      mediaMaximumBytes: 1024 * 1024,
      objectService,
      github: {
        webhookSecret: 'webhook-secret',
        roomToken: async () => {
          if (roomTokenFailure) throw roomTokenFailure;
          return { token: 'github-room-token', expiresAt: Date.now() + 60_000 };
        },
        completeInstallation,
        onWebhook: processWebhook,
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    (phone as unknown as { publicOrigin: string }).publicOrigin = origin;
    (objectService as unknown as { publicOrigin: string }).publicOrigin = origin;
    const phoneTokens = await auth.exchangeGitHubOidc('proof');
    accessToken = phoneTokens.accessToken;
    const exchange = await auth.createDaemonExchange(AGENT);
    daemonToken = (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (mountedAuth) await mountedAuth.close();
    if (objectStorage) await objectStorage.close();
    if (database) await database.close();
  });

  const request = async (path: string, method = 'GET', payload?: unknown, token = accessToken) =>
    phoneFetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });

  const phoneToken = async (login: string) => (await auth.exchangeGitHubOidc(login)).accessToken;

  const operation = (name: string, payload: unknown, token = accessToken) =>
    request(`/v1/phone/operations/${name}`, 'POST', payload, token);

  // These fixtures test projections and lifecycle behavior downstream of intake.
  // Supply an explicit command first. Routing/refusal tests call DaemonService
  // directly in agent-command.integration.test.ts and never use this helper.
  const settleCornerWork = async (cornerId: string) => {
    await database.query(`UPDATE agent_commands SET state='complete' WHERE room_id=$1`, [cornerId]);
    await database.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1`, [cornerId]);
  };

  const daemonOperation = async (name: string, payload: unknown, token = daemonToken) => {
    const input = { ...(payload as Record<string, unknown>) };
    if (name === 'requestAgentGrant' && !Object.hasOwn(input, 'purpose')) input.purpose = input.reason;
    const fixtureOmitBrief = input.fixtureOmitBrief === true;
    delete input.fixtureOmitBrief;
    const writes = new Set([
      'postRoomMessage',
      'postAgentDraft',
      'postAgentThought',
      'postAgentActivity',
      'postAgentAttachment',
      'postAgentTurnReceipt',
      'retractAgentLiveOutput',
      'postSquireApproval',
      'postSquireLoginWall',
      'createCorner',
      'reviseCornerBrief',
      'postRoomEvent',
      'requestAgentGrant',
      'authorizeSquireCall',
      'authorizeResourceCall',
      'authorizeRepositoryCall',
      'authorizeHostCall',
      'listTurnAgentGrants',
      'offerConnector',
      'askRoomChoice',
      'openRoomPoll',
      // Schedule edits and deletes are judged by the person behind the turn.
      'updateAgentSchedule',
      'deleteAgentSchedule',
    ]);
    const who = await auth.authenticateDaemon(token);
    if (who && typeof input.roomId === 'string' && writes.has(name)) {
      const requestId = String(
        input.requestId ??
          input.turnId ??
          createHash('sha256')
            .update(String(Date.now()) + Math.random())
            .digest('hex'),
      );
      const sourceId = /^[0-9a-f]{64}$/.test(requestId)
        ? requestId
        : createHash('sha256').update(requestId).digest('hex');
      input.requestId = requestId;
      input.generationId ??= 'fixture-generation';
      await database.transaction(async (tx) => {
        const existing = (
          await tx.query<{ id: string }>(
            `SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 ORDER BY created_at DESC LIMIT 1`,
            [input.roomId, who, requestId],
          )
        ).rows[0];
        if (existing) {
          await claimAgentCommand(
            tx,
            String(input.roomId),
            who,
            existing.id,
            String(input.generationId),
          ).catch(() => undefined);
          return;
        }
        await tx.query(
          `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES($1,$2,$3,'Fixture command','activity') ON CONFLICT(id) DO NOTHING`,
          [sourceId, input.roomId, HUMAN],
        );
        const command = await createAgentCommand(tx, {
          roomId: String(input.roomId),
          agentId: who,
          sourceMessageId: sourceId,
          turnRequestId: requestId,
          reason: 'fixture',
        });
        if (command)
          await claimAgentCommand(
            tx,
            String(input.roomId),
            who,
            command.id,
            String(input.generationId),
          );
      });
      const suppliedBrief = input.brief as
        | { content?: unknown; attachments?: unknown; change?: unknown; spec?: unknown }
        | undefined;
      if (suppliedBrief?.content && suppliedBrief.spec === undefined) {
        input.brief = {
          spec: String(suppliedBrief.content),
          approval: { sourceMessageId: sourceId },
          ...(suppliedBrief.attachments ? { attachments: suppliedBrief.attachments } : {}),
          ...(suppliedBrief.change ? { change: suppliedBrief.change } : {}),
        };
      } else if (name === 'createCorner' && input.brief === undefined && !fixtureOmitBrief) {
        const sourceRoom = (
          await database.query<{ repository_key: string | null; repository_resolution: string }>(
            `SELECT repository_key,repository_resolution FROM rooms WHERE id=$1`,
            [input.roomId],
          )
        ).rows[0];
        if (
          input.repository ||
          sourceRoom?.repository_key ||
          sourceRoom?.repository_resolution === 'repository'
        ) {
          input.brief = {
            spec: String(input.objective ?? 'Complete the requested work.'),
            approval: { sourceMessageId: sourceId },
          };
        }
      }
    }
    return request(`/v1/daemon/operations/${name}`, 'POST', input, token);
  };

  const webhook = async (event: string, delivery: string, payload: unknown) => {
    const bytes = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac('sha256', 'webhook-secret').update(bytes).digest('hex')}`;
    return phoneFetch(`${origin}/v1/github/webhook`, {
      method: 'POST',
      headers: {
        'x-hub-signature-256': signature,
        'x-github-delivery': delivery,
        'x-github-event': event,
        'content-type': 'application/json',
      },
      body: bytes,
    });
  };


  const redeemReview = (secret: unknown) =>
    phoneFetch(`${origin}/v1/auth/review/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
return {
get database(){ return database; }, set database(value: typeof database) { database=value; },
get live(){ return live; }, set live(value: typeof live) { live=value; },
get auth(){ return auth; }, set auth(value: typeof auth) { auth=value; },
get origin(){ return origin; }, set origin(value: typeof origin) { origin=value; },
get server(){ return server; }, set server(value: typeof server) { server=value; },
get accessToken(){ return accessToken; }, set accessToken(value: typeof accessToken) { accessToken=value; },
get daemonToken(){ return daemonToken; }, set daemonToken(value: typeof daemonToken) { daemonToken=value; },
get sendPushTest(){ return sendPushTest; }, set sendPushTest(value: typeof sendPushTest) { sendPushTest=value; },
get mountedAuth(){ return mountedAuth; }, set mountedAuth(value: typeof mountedAuth) { mountedAuth=value; },
get completeInstallation(){ return completeInstallation; }, set completeInstallation(value: typeof completeInstallation) { completeInstallation=value; },
get processWebhook(){ return processWebhook; }, set processWebhook(value: typeof processWebhook) { processWebhook=value; },
get githubOperations(){ return githubOperations; }, set githubOperations(value: typeof githubOperations) { githubOperations=value; },
get phone(){ return phone; }, set phone(value: typeof phone) { phone=value; },
get objectStorage(){ return objectStorage; }, set objectStorage(value: typeof objectStorage) { objectStorage=value; },
get objectService(){ return objectService; }, set objectService(value: typeof objectService) { objectService=value; },
get githubApp(){ return githubApp; }, set githubApp(value: typeof githubApp) { githubApp=value; },
get githubRollupState(){ return githubRollupState; }, set githubRollupState(value: typeof githubRollupState) { githubRollupState=value; },
get roomTokenFailure(){ return roomTokenFailure; }, set roomTokenFailure(value: typeof roomTokenFailure) { roomTokenFailure=value; },
get databaseSnapshot(){ return databaseSnapshot; }, set databaseSnapshot(value: typeof databaseSnapshot) { databaseSnapshot=value; },
request,
phoneToken,
operation,
settleCornerWork,
daemonOperation,
webhook,
redeemReview,
};
}
