import { phoneFetch } from '../../../tests/helpers/phone-operation.js';

import { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion } from './command-completion.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type randomBytes, randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

import { SCHEDULE_SCHEDULER_ID } from '@beeline/api-contract/scheduled-prompts';

import { LinkAgentWallet } from './link-agent-wallet.js';

import { migrate, PostgresDatabase } from './database.js';

import { PgliteDatabase, migratedDatabase } from './test-support.js';

import { DaemonService } from './daemon-service.js';

import { PhoneService } from './phone-service.js';

import { LiveHub } from './live.js';

import { ConnectionPresence } from './connection-presence.js';

import { McpRegistryClient } from './mcp-registry.js';

import { CompanyMcpDiscovery } from './company-mcp-discovery.js';

import { applyVaultList } from './workbench.js';

import { recordSquireSignIn } from './squire-machine.js';

import { beginComposioAppSignIn, connectApp, readOwnerApps, resolveAppRoute, type AppRouteProbes } from './app-connections.js';

import { cleanupUnfinishedAppSignIns } from './unfinished-app-sign-ins.js';

import { APP_FILE_MAXIMUM_BYTES, ComposioApps } from './composio-apps.js';

import { ObjectService } from './object-service.js';

import type { ObjectStorage } from './object-storage.js';

import { readRoomViewMessage } from '@beeline/api-contract/phone';

import type { AddressInfo } from 'node:net';

import type { TokenAuth } from './auth.js';

import { createBeelineServer } from './server.js';

import { captureServerError } from './sentry.js';


vi.mock('./sentry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./sentry.js')>(),
  captureServerError: vi.fn(),
}));


export const WORKSPACE = '11111111-1111-4111-8111-111111111111';

export const ROOM = '22222222-2222-4222-8222-222222222222';

export const CORNER = '44444444-4444-4444-8444-444444444444';

export const OWNER = 'a'.repeat(64);

export const HELPER = 'b'.repeat(64);

export const COMMAND = 'app-connect-command';

export const REQUEST = 'app-connect-request';

export const GENERATION = 'app-connect-generation';


export const turn = { roomId: ROOM, requestId: REQUEST, generationId: GENERATION };


export const linearServer = {
  name: 'app.linear/linear',
  version: '1.0.1',
  title: 'Linear',
  websiteUrl: 'https://linear.app',
  remotes: [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }],
  packages: [],
};


/** A Registry that answers from a fixed table, and counts what it was asked. */
export function fakeRegistry(servers: Record<string, unknown>[], fail = false) {
  const transport = vi.fn(async (url: URL | string) => {
    if (fail) return new Response('down', { status: 503 });
    const parsed = new URL(String(url));
    if (parsed.pathname === '/v0.1/servers') {
      const term = parsed.searchParams.get('search') ?? '';
      return Response.json({
        servers: servers
          .filter((server) => String(server.name).includes(term))
          .map((server) => ({ server })),
      });
    }
    const match = /^\/v0\.1\/servers\/(.+)\/versions\/(.+)$/.exec(parsed.pathname);
    const server = servers.find(
      (entry) =>
        match &&
        entry.name === decodeURIComponent(match[1]!) &&
        entry.version === decodeURIComponent(match[2]!),
    );
    return server ? Response.json({ server }) : new Response('missing', { status: 404 });
  });
  return { client: new McpRegistryClient(transport as unknown as typeof fetch, undefined, new CompanyMcpDiscovery(async () => ({ status: 404, body: '' }))), transport };
}
export function fixtureScope1() {

  const probes = (overrides: Partial<AppRouteProbes> = {}) => {
    const workbench = vi.fn(async () => undefined);
    const composio = vi.fn(async () => 'none' as const);
    return { workbench, composio, ...overrides } as AppRouteProbes & {
      workbench: ReturnType<typeof vi.fn>;
      composio: ReturnType<typeof vi.fn>;
    };
  };
return {
probes,
};
}
export function fixtureScope2() {

  let database: PgliteDatabase | PostgresDatabase;

  let cleanupPostgres: (() => Promise<void>) | undefined;


  const daemonWith = (registry: McpRegistryClient, composio: ComposioApps = {
    supportsOAuth: async () => false,
  } as ComposioApps, objects?: ObjectService, linkWallet?: LinkAgentWallet) =>
    new DaemonService(
      database,
      new LiveHub(),
      undefined,
      undefined,
      false,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { enabled: false },
      registry,
      undefined,
      composio,
      undefined,
      objects,
      linkWallet,
    );


  function fakeComposio(completedToolkit = 'slack') {
    let active = false;
    const provider = {
      supportsOAuth: vi.fn(async (toolkit: string) => ['slack', 'gmail'].includes(toolkit)),
      toolkit: vi.fn(async (toolkit: string) => ({ slug: toolkit,
        description: `Use ${toolkit} tools.`, logo: `https://cdn.composio.dev/${toolkit}.png` })),
      link: vi.fn(async (_person: string, _toolkit: string) => ({
        url: 'https://app.composio.dev/connect/fixture', accountId: 'ca_fixture',
        expiresAt: new Date(Date.now() + 600_000),
      })),
      account: vi.fn(async (_account: string, person: string) => active && person === OWNER),
      accountStatus: vi.fn(async (_account: string, person: string) => ({
        status: active && person === OWNER ? 'active' as const : 'pending' as const,
      })),
      completeAuth: vi.fn(async (_session: string, person: string) => {
        if (person !== OWNER) throw new Error('App provider request failed (400)');
        active = true;
        return { accountId: 'ca_fixture', toolkit: completedToolkit };
      }),
      listTools: vi.fn(async () => ({ tools: [{ slug: 'SLACK_POST_MESSAGE', name: 'Post message',
        description: 'Post to a channel', inputParameters: {} }] })),
      execute: vi.fn(async () => ({ ok: true })),
      deleteAccount: vi.fn(async () => { active = false; }),
    };
    return provider as typeof provider & ComposioApps;
  }


  let releaseCompletions: () => Promise<void>;

  beforeEach(async () => {
    const postgresUrl = process.env.BEELINE_APP_DISCOVERY_TEST_POSTGRES_URL;
    if (postgresUrl) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(postgresUrl).hostname))
        throw new Error('App discovery proofs require isolated loopback PostgreSQL');
      const name = `app_discovery_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: postgresUrl, max: 1 });
      await admin.query(`CREATE DATABASE ${name}`);
      const isolatedUrl = new URL(postgresUrl);
      isolatedUrl.pathname = `/${name}`;
      database = new PostgresDatabase(isolatedUrl.toString(), 2, { mode: 'migration' });
      cleanupPostgres = async () => {
        await admin.query(`DROP DATABASE ${name}`);
        await admin.end();
      };
      await migrate(database);
      releaseCompletions = async () => {};
    } else {
      database = await migratedDatabase();
      releaseCompletions = await database.client.listen(COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion);
    }
    await database.query(
      `INSERT INTO identities(id,kind,name,handle)
       VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
      [OWNER, HELPER],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,machine_id,machine_name,yolo_mode)
       VALUES($1,$2,'machine-one','Owner laptop',false)`,
      [HELPER, OWNER],
    );
    await database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Tools')`,
      [ROOM, WORKSPACE, OWNER],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
             ($1,$4,$2,'owner'),($1,$4,$3,'member')`,
      [WORKSPACE, OWNER, HELPER, ROOM],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('app-source',$1,$2,'Connect Linear')`,
      [ROOM, OWNER],
    );
    await database.query(
      `INSERT INTO agent_commands(
         id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
         root_command_id,root_source_message_id,agent_depth,state,generation_id,lease_expires_at
       ) VALUES($1,$2,$3,'app-source',$4,'input','human_tag',$1,'app-source',0,
         'claimed',$5,now()+interval '10 minutes')`,
      [COMMAND, ROOM, HELPER, REQUEST, GENERATION],
    );
  }, 120_000);


  afterEach(async () => {
    await releaseCompletions?.();
    await database?.close();
    await cleanupPostgres?.();
    cleanupPostgres = undefined;
  });


  async function connectSquire(): Promise<string> {
    await database.query(`UPDATE agents SET squire_report=$2::jsonb WHERE agent_id=$1`,
      [HELPER, JSON.stringify({ status: 'connected', reportedAt: Date.now() / 1000 })]);
    return 'squire:machine-one';
  }


  const routes = async () =>
    (
      await database.query<{ route: string; transport: string }>(
        `SELECT route,transport FROM workspace_app_routes ORDER BY created_at, id`,
      )
    ).rows;


  async function publishFlySignIn() {
    let connectorId = '';
    await vi.waitFor(async () => {
      connectorId = (await database.query<{ id: string }>(`SELECT id FROM workspace_connectors WHERE registry_server_name='io.fly/company-mcp'`)).rows[0]?.id ?? '';
      expect(connectorId).not.toBe('');
    });
    await database.query(`UPDATE workspace_connectors SET sign_in=$2::jsonb WHERE id=$1`,
      [connectorId, JSON.stringify({ method: 'oauth', url: 'https://fly.io/mcp/oauth/authorize?fixture=1', attemptId: 'proof' })]);
  }


  /**
   * Connects Slack for OWNER and returns its appId, the state the reported
   * feedback-triage run reached before its app step stalled.
   */
  async function connectedSlack(daemon: DaemonService, provider: ComposioApps): Promise<string> {
    const connected = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'post the launch notes' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: connected.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: connected.appId! }, OWNER);
    return connected.appId!;
  }


  /**
   * Seeds a saved workflow run and points this turn's command at a handoff
   * wake card for it. `startRequester` is the run's recorded starter (a
   * person for a person-started run, an agent otherwise); `gateAnswerer` adds
   * a newer card answered by that person.
   */
  async function seedWorkflowWake(input: {
    runId: string;
    startRequester: string;
    gateAnswerer?: string;
  }): Promise<void> {
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
       VALUES($1,$2,$3,'started workflow','system','workflow-handoff',$4::jsonb)`,
      [input.runId, ROOM, HELPER, JSON.stringify({ runId: input.runId, seq: 0, runStatus: 'live',
        workflowSlug: 'sweep', workflowVersion: 1, requesterId: input.startRequester, toState: 'work' })],
    );
    const handoffId = `${input.runId}-handoff`;
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
       VALUES($1,$2,$3,'handed off','system','workflow-handoff',$4::jsonb)`,
      [handoffId, ROOM, HELPER, JSON.stringify({ runId: input.runId, seq: 1,
        workflowSlug: 'sweep', workflowVersion: 1, toState: 'work' })],
    );
    if (input.gateAnswerer) {
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
         VALUES($1,$2,$3,'answered gate','system','workflow-handoff',$4::jsonb)`,
        [`${input.runId}-gate`, ROOM, input.gateAnswerer, JSON.stringify({ runId: input.runId, seq: 2,
          workflowSlug: 'sweep', workflowVersion: 1, toState: 'work',
          contents: { decision: 'go', answeredBy: input.gateAnswerer },
          receipt: { exit: { gate: 'go', actorId: input.gateAnswerer } } })],
      );
    }
    await database.query(`UPDATE agent_commands SET root_source_message_id=$1 WHERE id=$2`,
      [handoffId, COMMAND]);
  }
return {
get database(){return database;}, set database(value: typeof database){database=value;},
get cleanupPostgres(){return cleanupPostgres;}, set cleanupPostgres(value: typeof cleanupPostgres){cleanupPostgres=value;},
daemonWith,
fakeComposio,
get releaseCompletions(){return releaseCompletions;}, set releaseCompletions(value: typeof releaseCompletions){releaseCompletions=value;},
connectSquire,
routes,
publishFlySignIn,
connectedSlack,
seedWorkflowWake,
};
}
export function fixtureScope3(scope2: ReturnType<typeof fixtureScope2>) {

    const YOUTUBE_APP = '44444444-4444-4444-8444-444444444444';

    const OTHER_ROOM = '55555555-5555-4555-8555-555555555555';

    const IN_ROOM = '66666666-6666-4666-8666-666666666666';

    const ELSEWHERE = '77777777-7777-4777-8777-777777777777';

    const HUGE = '88888888-8888-4888-8888-888888888888';

    const S3KEY = 'uploads/youtube/staged-fixture.mp4';

    const PRESIGNED = 'https://composio-files.s3.amazonaws.com/uploads/youtube/staged-fixture.mp4?X-Amz-Signature=sig';

    const VIDEO = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);


    async function youtubeRoom() {
      await scope2.database.query(
        `INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,
           transport,route,composio_account_id)
         VALUES($1,$2,$3,'youtube','YouTube','composio','composio','ca_youtube')`,
        [YOUTUBE_APP, WORKSPACE, OWNER],
      );
      await scope2.database.query(
        `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Elsewhere')`,
        [OTHER_ROOM, WORKSPACE, OWNER],
      );
      const object = (id: string, title: string, size: number) => scope2.database.query(
        `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
         VALUES($1,$2,'artifact',$3,'application/octet-stream',$4,$5,$6,'ready',now()+interval '1 day')`,
        [id, HELPER, `artifact/${id}`, title, size, id.replaceAll('-', '').padEnd(64, '0')],
      );
      await object(IN_ROOM, 'song-take-2.mp4', VIDEO.length);
      await object(ELSEWHERE, 'other.mp4', VIDEO.length);
      await object(HUGE, 'long-cut.mp4', APP_FILE_MAXIMUM_BYTES + 1);
      const attach = (id: string, room: string, objectId: string) => scope2.database.query(
        `INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES($1,$2,$3,'take',$4::jsonb)`,
        [id, room, HELPER, JSON.stringify([{ kind: 'artifact',
          url: `https://beeline.example/v1/media/${objectId}` }])],
      );
      await attach('take-in-room', ROOM, IN_ROOM);
      await attach('take-elsewhere', OTHER_ROOM, ELSEWHERE);
      await attach('take-huge', ROOM, HUGE);
      const getObject = vi.fn(async (key: string) => (key === `artifact/${IN_ROOM}` ? VIDEO : null));
      const objects = new ObjectService(scope2.database, { getObject } as unknown as ObjectStorage,
        'https://beeline.example');
      const calls: { method: string; url: string; body?: unknown }[] = [];
      const transport = vi.fn(async (url: URL | string, init?: RequestInit) => {
        const href = String(url);
        calls.push({ method: init?.method ?? 'GET', url: href.split('?')[0]!,
          ...(init?.body instanceof Uint8Array ? { body: init.body }
            : init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (href === PRESIGNED) return new Response(null, { status: 200 });
        const path = new URL(href).pathname;
        if (path.endsWith('/connected_accounts/ca_youtube')) return Response.json({
          id: 'ca_youtube', user_id: OWNER, status: 'ACTIVE', toolkit: { slug: 'youtube' } });
        if (path.endsWith('/tools/YOUTUBE_MULTIPART_UPLOAD_VIDEO')) return Response.json({
          slug: 'YOUTUBE_MULTIPART_UPLOAD_VIDEO', version: '20260930_00', toolkit: { slug: 'youtube' },
          input_parameters: { type: 'object', properties: { title: { type: 'string' },
            videoFile: { type: 'object', file_uploadable: true } } } });
        if (path.endsWith('/tools/YOUTUBE_LIST_CHANNEL_VIDEOS')) return Response.json({
          slug: 'YOUTUBE_LIST_CHANNEL_VIDEOS', version: '20260930_00', toolkit: { slug: 'youtube' } });
        if (path === '/api/v3.1/files/upload/request') return Response.json({
          id: 'file-1', key: S3KEY, new_presigned_url: PRESIGNED, type: 'new' });
        if (path.endsWith('/tools/execute/YOUTUBE_MULTIPART_UPLOAD_VIDEO')) return Response.json({
          data: { id: 'yt-1', privacyStatus: 'private', source: S3KEY } });
        if (path.endsWith('/tools/execute/YOUTUBE_LIST_CHANNEL_VIDEOS'))
          return Response.json({ data: { items: [] } });
        if (path === '/api/v3/tools') return Response.json({ items: [{
          slug: 'YOUTUBE_LIST_CHANNEL_VIDEOS', name: 'List channel videos', toolkit: { slug: 'youtube' } }] });
        if (path === '/api/v3.1/tools/execute/proxy') return Response.json({ status: 200, data: {
          kind: 'youtubeAnalytics#resultTable',
          columnHeaders: [{ name: 'views', columnType: 'METRIC', dataType: 'INTEGER' }],
          rows: [[1234]] } });
        throw new Error(`unexpected request ${href}`);
      });
      const daemon = scope2.daemonWith(fakeRegistry([]).client,
        new ComposioApps('composio-project-key', transport as typeof fetch), objects);
      const upload = (objectId: string) => daemon.execute('executeAppTool', { ...turn,
        appId: YOUTUBE_APP, tool: 'YOUTUBE_MULTIPART_UPLOAD_VIDEO',
        arguments: { title: 'Song', videoFile: { beelineObjectId: objectId } } }, HELPER);
      return { daemon, upload, calls, transport, getObject };
    }
return {
YOUTUBE_APP,
OTHER_ROOM,
IN_ROOM,
ELSEWHERE,
HUGE,
S3KEY,
PRESIGNED,
VIDEO,
youtubeRoom,
};
}
export { phoneFetch } from '../../../tests/helpers/phone-operation.js';
export { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion } from './command-completion.js';
export { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
export { randomBytes, randomUUID } from 'node:crypto';
export { Pool } from 'pg';
export { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
export { SCHEDULE_SCHEDULER_ID } from '@beeline/api-contract/scheduled-prompts';
export { LinkAgentWallet } from './link-agent-wallet.js';
export { migrate, PostgresDatabase } from './database.js';
export { PgliteDatabase, migratedDatabase } from './test-support.js';
export { DaemonService } from './daemon-service.js';
export { PhoneService } from './phone-service.js';
export { LiveHub } from './live.js';
export { ConnectionPresence } from './connection-presence.js';
export { McpRegistryClient } from './mcp-registry.js';
export { CompanyMcpDiscovery } from './company-mcp-discovery.js';
export { applyVaultList } from './workbench.js';
export { recordSquireSignIn } from './squire-machine.js';
export { beginComposioAppSignIn, connectApp, readOwnerApps, resolveAppRoute } from './app-connections.js';
export { cleanupUnfinishedAppSignIns } from './unfinished-app-sign-ins.js';
export { APP_FILE_MAXIMUM_BYTES, ComposioApps } from './composio-apps.js';
export { ObjectService } from './object-service.js';
export { readRoomViewMessage } from '@beeline/api-contract/phone';
export { createBeelineServer } from './server.js';
export { captureServerError } from './sentry.js';
export type { AppRouteProbes } from './app-connections.js';
export type { ObjectStorage } from './object-storage.js';
export type { AddressInfo } from 'node:net';
export type { TokenAuth } from './auth.js';
