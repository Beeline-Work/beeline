import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { McpRegistryClient } from './mcp-registry.js';
import { connectorIdentityId } from './workbench.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const OWNER = 'a'.repeat(64);
const HELPER = 'b'.repeat(64);
const COMMAND = 'registry-connect-command';
const REQUEST = 'registry-connect-request';
const GENERATION = 'registry-connect-generation';

describe('Registry MCP connection orchestration', () => {
  let database: PgliteDatabase;
  let daemon: DaemonService;
  let exactFetches: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle)
       VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
      [OWNER, HELPER],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,machine_id,machine_name)
       VALUES($1,$2,'machine-one','Owner laptop')`,
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
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('registry-source',$1,$2,'Connect Linear')`,
      [ROOM, OWNER],
    );
    await database.query(
      `INSERT INTO agent_commands(
         id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
         root_command_id,root_source_message_id,agent_depth,state,generation_id,lease_expires_at
       ) VALUES($1,$2,$3,'registry-source',$4,'input','human_tag',$1,'registry-source',0,
         'claimed',$5,now()+interval '10 minutes')`,
      [COMMAND, ROOM, HELPER, REQUEST, GENERATION],
    );
    exactFetches = vi.fn(async () =>
      Response.json({
        server: {
          name: 'app.linear/linear',
          version: '1.0.1',
          title: 'Linear',
          websiteUrl: 'https://linear.app',
          repository: { url: 'https://github.com/linear/linear', source: 'github' },
          remotes: [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }],
          packages: [],
        },
      }),
    );
    daemon = new DaemonService(
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
      undefined,
      { enabled: false },
      new McpRegistryClient(exactFetches as typeof fetch),
    );
  });

  afterEach(async () => database.close());

  const connectInput = (handoffToOwner = false) => ({
    roomId: ROOM,
    requestId: REQUEST,
    generationId: GENERATION,
    serverName: 'app.linear/linear',
    version: '1.0.1',
    reason: 'Create the requested Linear issue',
    ...(handoffToOwner ? { handoffToOwner: true } : {}),
  });

  it('reuses one pinned row, deduplicates both handoff paths, resumes, and mounts without a new gate', async () => {
    const first = await daemon.execute('connectMcpServer', connectInput(), HELPER);
    expect(first).toMatchObject({ status: 'connecting' });
    const connectorId = (first as { connectorId: string }).connectorId;
    const initial = await database.query<{
      status: string;
      registry_server_name: string;
      registry_version: string;
      registry_manifest: unknown;
      install_agent_id: string;
      install_room_id: string;
      install_command_id: string;
    }>(
      `SELECT status,registry_server_name,registry_version,registry_manifest,
              install_agent_id,install_room_id,install_command_id
       FROM workspace_connectors WHERE id=$1`,
      [connectorId],
    );
    expect(initial.rows[0]).toMatchObject({
      status: 'installing',
      registry_server_name: 'app.linear/linear',
      registry_version: '1.0.1',
      install_agent_id: HELPER,
      install_room_id: ROOM,
      install_command_id: COMMAND,
    });
    expect(JSON.stringify(initial.rows[0]!.registry_manifest)).not.toMatch(
      /access_token|refresh_token|authorization_code|secretValue/i,
    );
    expect((await database.query(`SELECT 1 FROM connector_offers`)).rowCount).toBe(0);
    expect((await database.query(`SELECT 1 FROM agent_grants`)).rowCount).toBe(0);

    await daemon.execute(
      'postConnectorStatus',
      {
        agentId: HELPER,
        connectorId,
        steps: [
          { label: 'Discover remote authentication', status: 'done' },
          { label: 'Connect provider account', status: 'running' },
        ],
        signIn: {
          method: 'oauth',
          url: 'https://mcp.linear.app/authorize?state=opaque-one',
          attemptId: 'attempt-one',
        },
      },
      HELPER,
    );
    await expect(daemon.execute('connectMcpServer', connectInput(), HELPER)).resolves.toEqual({
      status: 'needs_sign_in',
      connectorId,
      authorizationUrl: 'https://mcp.linear.app/authorize?state=opaque-one',
    });
    expect(
      await database.query(`SELECT 1 FROM messages WHERE author_id=$1`, [
        connectorIdentityId('registry-mcp'),
      ]),
    ).toHaveProperty('rowCount', 0);

    await daemon.execute('connectMcpServer', connectInput(true), HELPER);
    await daemon.execute('connectMcpServer', connectInput(true), HELPER);
    expect(
      (
        await database.query(`SELECT text FROM messages WHERE author_id=$1`, [
          connectorIdentityId('registry-mcp'),
        ])
      ).rows,
    ).toHaveLength(1);

    await database.query(
      `UPDATE workspace_connectors
       SET sign_in=$2::jsonb,registry_handoff_attempt=NULL,registry_squire_relayed_attempt=NULL
       WHERE id=$1`,
      [
        connectorId,
        JSON.stringify({
          method: 'oauth',
          url: 'https://mcp.linear.app/authorize?state=opaque-two',
          attemptId: 'attempt-two',
        }),
      ],
    );
    await daemon.execute(
      'postSquireApproval',
      {
        roomId: ROOM,
        requestId: REQUEST,
        generationId: GENERATION,
        tool: 'operate_login',
        title: 'Continue Linear sign-in',
        detail: 'Approve the provider sign-in in the shared browser session.',
        approvalUrl: 'https://squire.example/approval/one',
        approvalId: 'squire-attempt-two',
        linkKind: 'approval',
      },
      HELPER,
    );
    await daemon.execute('connectMcpServer', connectInput(true), HELPER);
    expect(
      (
        await database.query(`SELECT text FROM messages WHERE author_id=$1`, [
          connectorIdentityId('registry-mcp'),
        ])
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await database.query(`SELECT text FROM messages WHERE author_id=$1`, [
          connectorIdentityId('trusty-squire'),
        ])
      ).rows,
    ).toHaveLength(1);

    await daemon.execute('installConnector', { agentId: HELPER, connectorId }, HELPER);
    const connected = await database.query<{ status: string; sign_in: unknown }>(
      `SELECT status,sign_in FROM workspace_connectors WHERE id=$1`,
      [connectorId],
    );
    expect(connected.rows[0]).toEqual({ status: 'connected', sign_in: null });
    expect(
      (
        await database.query(
          `SELECT 1 FROM agent_commands
       WHERE room_id=$1 AND agent_id=$2 AND action='resume' AND parent_command_id=$3`,
          [ROOM, HELPER, COMMAND],
        )
      ).rowCount,
    ).toBe(1);
    const configuration = await daemon.execute(
      'getAgentConfiguration',
      {
        agentId: HELPER,
        roomId: ROOM,
      },
      HELPER,
    );
    expect(configuration.registryMcpRoutes).toEqual([
      expect.objectContaining({
        connectorId,
        serverName: 'app.linear/linear',
        target: 'registry-mcp:app.linear/linear',
      }),
    ]);
    const workbench = await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER);
    expect(workbench.registryServers).toEqual([
      expect.objectContaining({
        connectorId,
        serverName: 'app.linear/linear',
        version: '1.0.1',
        status: 'connected',
      }),
    ]);
    expect(
      (
        await database.query(
          `SELECT 1 FROM workspace_connectors
       WHERE owner_identity_id=$1 AND machine_id='machine-one'
         AND registry_server_name='app.linear/linear'`,
          [OWNER],
        )
      ).rowCount,
    ).toBe(1);
    expect(exactFetches).toHaveBeenCalledTimes(5);
    const transcript = await database.query<{ text: string; card: unknown }>(
      `SELECT text,card FROM messages WHERE room_id IN (
         SELECT id FROM rooms WHERE workspace_id=$1
       )`,
      [WORKSPACE],
    );
    expect(JSON.stringify(transcript.rows)).not.toMatch(
      /access[_ -]?token|refresh[_ -]?token|authorization code/i,
    );
  });
});
