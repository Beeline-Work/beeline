import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { MAX_ACCESS_ALLOWLIST_ENTRIES, agentAccessPolicyRecord, isAgentAccessPolicy } from '@beeline/api-contract/agent-access';
import { retireAgentFromWorkspace } from '../agent-retirement.js';
import { revokeDaemonCredentials } from '../daemon-credential-lifetime.js';
import { removeIdentityMemberships } from '../membership-join.js';
import { systemLine } from '../system-line.js';
import type { PhoneContext } from './context.js';
import { Input } from './types.js';
import { phoneRequireWorkspaceMember, phoneRequireWorkspaceAgentRemover, phoneRequireIdentity } from './access.js';
import { AGENT_OWNER_AUTHORITY_MESSAGE, ACCESS_POLICY_AUTHORITY_MESSAGE } from './values.js';


  /**
   * The agent "yolo" switch. Authorization is decided here, never on the phone:
   * the viewer must be the agent's owner (the identity that connected it).
   * Public Workspaces reject enabling yolo while preserving the stored value
   * for a later return to invite-only. A flip posts one system line
   * to every live Room the agent is in so the change is visible where the
   * agent works; the line carries no mention and never pushes.
   */
  export async function phoneUpdateAgentYolo(ctx: PhoneContext, input: Input<'updateAgentYolo'>, viewerId: string) {
    if (typeof input.enabled !== 'boolean') throw new Error('enabled is required');
    const agent = (
      await ctx.database.query<{
        owner_id: string;
        agent_name: string;
        viewer_name: string;
        workspace_visibility: 'public' | 'invite-only';
      }>(
        `SELECT a.owner_id,agent.name agent_name,viewer.name viewer_name,
                workspace.visibility workspace_visibility
         FROM agents a
         JOIN identities agent ON agent.id=a.agent_id
         JOIN memberships m ON m.identity_id=a.agent_id
           AND m.workspace_id=$2 AND m.room_id IS NULL AND m.removed_at IS NULL
         JOIN identities viewer ON viewer.id=$3
         JOIN workspaces workspace ON workspace.id=$2
         WHERE a.agent_id=$1`,
        [input.agentId, input.workspaceId, viewerId],
      )
    ).rows[0];
    if (!agent) throw new Error('agent not found in workspace');
    await phoneRequireWorkspaceMember(ctx, input.workspaceId, viewerId);
    if (agent.owner_id !== viewerId) throw new Error(AGENT_OWNER_AUTHORITY_MESSAGE);
    if (input.enabled && agent.workspace_visibility === 'public')
      throw new Error('yolo cannot be enabled in a public workspace');
    await ctx.database.transaction(async (database) => {
      const changed = await database.query(
        `UPDATE agents SET yolo_mode=$2,yolo_set_by=$3,yolo_set_at=now(),updated_at=now()
         WHERE agent_id=$1 AND yolo_mode<>$2`,
        [input.agentId, input.enabled, viewerId],
      );
      if (!changed.rowCount) return;
      const rooms = await database.query<{ room_id: string }>(
        `SELECT m.room_id FROM memberships m
         JOIN rooms r ON r.id=m.room_id
         WHERE m.identity_id=$1 AND m.room_id IS NOT NULL AND m.removed_at IS NULL
           AND r.workspace_id=$2 AND r.archived_at IS NULL`,
        [input.agentId, input.workspaceId],
      );
      for (const room of rooms.rows)
        await systemLine(database, {
          roomId: room.room_id,
          subject: { kind: 'person', id: viewerId, name: agent.viewer_name },
          verb: input.enabled ? systemMessage("phone-service.turned-yolo-on-for") : systemMessage("phone-service.turned-yolo-off-for"),
          object: { text: agent.agent_name, id: input.agentId },
          consequence: input.enabled
            ? systemMessage("phone-service.grant-requests-are-now-approved-automatically")
            : systemMessage("phone-service.grant-requests-now-ask-before-running"),
          cardType: 'agent-yolo',
          card: { agentId: input.agentId, enabled: input.enabled },
        });
    });
  }

  /**
   * Who may address this agent. Authorization belongs only to the agent's owner
   * (the identity that connected it). The row is the ONLY
   * authority — a running helper reads it through `getRoomAuthority` on its next
   * poll, so the change takes effect without a reconnect or a restart.
   *
   * A change posts one system line to every active person's read-only @system
   * DM. It is Workspace configuration, not activity in every Room the agent is
   * in, and no agent should be woken by the notice.
   */
  export async function phoneUpdateAgentAccessPolicy(ctx: PhoneContext, input: Input<'updateAgentAccessPolicy'>, viewerId: string) {
    if (!isAgentAccessPolicy(input.policy)) throw new Error('policy is invalid');
    const allow = input.policy === 'allowlist' ? (input.allow ?? []) : [];
    if (input.policy === 'allowlist') {
      if (!allow.length || allow.length > MAX_ACCESS_ALLOWLIST_ENTRIES)
        throw new Error('allowlist is invalid');
      if (allow.some((entry) => typeof entry !== 'string' || !/^[0-9a-f]{64}$/.test(entry)))
        throw new Error('allowlist is invalid');
    }
    const agent = (
      await ctx.database.query<{
        owner_id: string;
        agent_name: string;
        viewer_handle: string | null;
        owner_handle: string | null;
      }>(
        `SELECT a.owner_id,agent.name agent_name,viewer.handle viewer_handle,owner.handle owner_handle
         FROM agents a
         JOIN identities agent ON agent.id=a.agent_id
         JOIN identities owner ON owner.id=a.owner_id
         JOIN memberships m ON m.identity_id=a.agent_id
           AND m.workspace_id=$2 AND m.room_id IS NULL AND m.removed_at IS NULL
         JOIN identities viewer ON viewer.id=$3
         WHERE a.agent_id=$1`,
        [input.agentId, input.workspaceId, viewerId],
      )
    ).rows[0];
    if (!agent) throw new Error('agent not found in workspace');
    await phoneRequireWorkspaceMember(ctx, input.workspaceId, viewerId);
    if (agent.owner_id !== viewerId) throw new Error(ACCESS_POLICY_AUTHORITY_MESSAGE);
    await ctx.database.transaction(async (database) => {
      const changed = await database.query(
        `UPDATE agents SET access_policy=$2::jsonb,updated_at=now()
         WHERE agent_id=$1 AND access_policy<>$2::jsonb`,
        [input.agentId, JSON.stringify(agentAccessPolicyRecord(input.policy, allow))],
      );
      if (!changed.rowCount) return;
      // The committed state is the silent audit record.
    });
  }

  /**
   * Roll back an agent registration whose connect helper never came up. Only
   * an agent that has NEVER reported presence is unrealizable: anything else
   * is a real daemon and must be removed by a human through removeAgent.
   */
  export async function phoneRollbackUnrealizedAgent(ctx: PhoneContext, agentId: string) {
    await ctx.database.transaction(async (database) => {
      const claimed = await database.query(
        `SELECT 1 FROM agent_pairing_codes WHERE claimed_by=$1`,
        [agentId],
      );
      if (!claimed.rowCount) throw new Error('pairing not found');
      const ran = await database.query(
        `SELECT 1 FROM live_outputs WHERE agent_id=$1 AND kind='presence' LIMIT 1`,
        [agentId],
      );
      if (ran.rowCount) throw new Error('agent already ran; use removeAgent instead');
      await revokeDaemonCredentials(database, agentId);
      await removeIdentityMemberships(database, [agentId]);
    });
  }


  /**
   * Removing an agent RETIRES it. Presence and authority end, its
   * configuration is cleared so the same key can never inherit it, and
   * everything that would still fire on its behalf stops — but the record of
   * what it did stays: `agent_turns` and every message it authored are left
   * exactly where they are, because the Room's account of the work outlives
   * the worker.
   *
   * The `agents` row is cleared in place rather than deleted. Grant history
   * and the agent detail read both join it for `owner_id`, so the row is what
   * keeps "who connected this agent" answerable after the fact; only the
   * mutable configuration — soul, model, effort, catalog, commands, schedule
   * ids, access policy, yolo and its setter — is reset to a freshly-paired
   * shape.
   *
   * A corner this agent owns is archived, exactly as a merged corner is:
   * every corner write admits only its owner agent, so an open corner behind
   * a retired agent is a Room nobody can advance and a pin the captain cannot
   * clear. It settles as `done`/`abandoned` with the reason, keeping its
   * transcript and its PR link readable.
   */
  export async function phoneRemoveAgent(ctx: PhoneContext, input: Input<'removeAgent'>, viewerId: string) {
    await phoneRequireWorkspaceAgentRemover(ctx, input.workspaceId, input.agentId, viewerId);
    const remover = await phoneRequireIdentity(ctx, viewerId);
    const removed = await phoneRequireIdentity(ctx, input.agentId);
    await ctx.database.transaction((database) =>
      retireAgentFromWorkspace(database, {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        remover,
        removed,
      }),
    );
    // Network cleanup is fire-and-forget after the removal commits; the leader retries it.
    ctx.freeAgents?.remove(input.agentId);
  }
