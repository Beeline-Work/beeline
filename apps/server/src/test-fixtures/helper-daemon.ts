import { DaemonService } from '../daemon-service.js';
import { claimAgentConnection } from '../connection-presence.js';
import type { SqlDatabase } from '../database.js';
import type { LiveHub } from '../live.js';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import type { HelperTurnOwnershipSource } from '@beeline/api-contract/helper-turn-ownership';

const registrations = new WeakMap<SqlDatabase, Map<string, Promise<HelperTurnOwnershipSource>>>();
const instanceId = 'helper-fixture';

async function renewLease(database: SqlDatabase): Promise<void> {
  await database.query(`INSERT INTO live_server_instances(instance_id,renewed_at) VALUES($1,clock_timestamp())
    ON CONFLICT(instance_id) DO UPDATE SET renewed_at=EXCLUDED.renewed_at`, [instanceId]);
}

function register(database: SqlDatabase, live: LiveHub, agentId: string): Promise<HelperTurnOwnershipSource> {
  let agents = registrations.get(database);
  if (!agents) {
    agents = new Map();
    registrations.set(database, agents);
  }
  let pending = agents.get(agentId);
  if (!pending) {
    pending = (async () => {
      await renewLease(database);
      const current = (await database.query<HelperTurnOwnershipSource>(`SELECT
        COALESCE(connection.turn_connection_id,connection.connection_id) "connectionId",
        COALESCE(connection.turn_connection_epoch,connection.epoch)::integer epoch
        FROM agent_connections connection JOIN live_server_instances server ON server.instance_id=connection.instance_id
        WHERE connection.agent_id=$1 AND connection.released_at IS NULL
          AND server.renewed_at>clock_timestamp()-interval '90 seconds'`, [agentId])).rows[0];
      if (current) return current;
      const connectionId = 'helper-fixture:' + agentId;
      return { connectionId, epoch: await claimAgentConnection(database, live, agentId, {}, { connectionId, instanceId }) };
    })().finally(() => agents.delete(agentId));
    agents.set(agentId, pending);
  }
  return pending;
}

/** Direct-service workflow tests still model a registered helper transport.
 * Claims acquire a real connection source; later controls carry that recorded
 * source. MCP/legacy rows and explicit source-forgery tests keep their own wire. */
export class HelperDaemonService extends DaemonService {
  private readonly fixtureDatabase: SqlDatabase;
  private readonly fixtureLive: LiveHub;

  constructor(...args: ConstructorParameters<typeof DaemonService>) {
    super(...args);
    this.fixtureDatabase = args[0];
    this.fixtureLive = args[1];
  }

  override async execute<Name extends keyof DaemonOperationMap>(
    name: Name, input: DaemonOperationMap[Name]['input'], agentId: string,
    owner?: Parameters<DaemonService['execute']>[3], model?: Parameters<DaemonService['execute']>[4],
  ): Promise<DaemonOperationMap[Name]['output']> {
    if (!owner && name === 'claimAgentCommand') {
      owner = await register(this.fixtureDatabase, this.fixtureLive, agentId);
    } else if (!owner && (name === 'postAgentTurnReceipt' || name === 'acknowledgeAgentCommand')) {
      await renewLease(this.fixtureDatabase);
      const control = input as { roomId: string; commandId?: string; requestId?: string; generationId?: string };
      owner = (await this.fixtureDatabase.query<HelperTurnOwnershipSource>(`SELECT
        COALESCE(command.turn_owner_connection_id,binding.connection_id) "connectionId",
        COALESCE(command.turn_owner_epoch,binding.connection_epoch)::integer epoch
        FROM agent_commands command LEFT JOIN agent_command_generation_owners binding
          ON binding.command_id=command.id AND binding.generation_id=$5
        WHERE command.agent_id=$1 AND command.room_id=$2
          AND (($3::text IS NOT NULL AND command.id=$3) OR ($4::text IS NOT NULL AND command.turn_request_id=$4))
          AND COALESCE(command.turn_owner_connection_id,binding.connection_id) IS NOT NULL
        ORDER BY (command.action IN ('input','resume')) DESC,command.created_at DESC LIMIT 1`,
      [agentId, control.roomId, control.commandId ?? null, control.requestId ?? null, control.generationId ?? null])).rows[0];
    }
    return super.execute(name, input, agentId, owner, model);
  }
}
