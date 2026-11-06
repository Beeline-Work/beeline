import { parseAgentAccessPolicy, senderMayAddressAgent } from '@beeline/api-contract/agent-access';
import type { DaemonContext } from './context.js';
import { Input } from './values.js';


  /**
   * Who this principal is in the Room, and — the half a helper cannot decide for
   * itself — whether the agent asking is allowed to answer them.
   *
   * The access policy lives on `agents.access_policy` and is read HERE, on the
   * round trip the intake loop already makes per candidate message. That is what
   * makes an owner's change in the members page effective on a helper that is
   * already running: the next poll asks again and gets the new answer, with no
   * reconnect, no restart, and nothing cached in the runtime record.
   */
  export async function daemonRoomAuthority(ctx: DaemonContext, input: Input<'getRoomAuthority'>, agentId: string) {
    const row = (
      await ctx.database.query<{
        workspace_id: string;
        role: 'owner' | 'admin' | 'member';
        kind: 'human' | 'agent';
        archived: boolean;
        access_policy: unknown;
        owner_id: string | null;
      }>(
        `SELECT r.workspace_id,CASE WHEN m.identity_id IS NOT NULL THEN COALESCE(workspace_member.role,m.role) END role,
           i.kind,r.archived_at IS NOT NULL archived,a.access_policy,a.owner_id
         FROM rooms r
         LEFT JOIN memberships m ON m.room_id=r.id AND m.identity_id=$2 AND m.removed_at IS NULL
         LEFT JOIN memberships workspace_member ON workspace_member.workspace_id=r.workspace_id
           AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
           AND workspace_member.removed_at IS NULL
         LEFT JOIN identities i ON i.id=$2
         LEFT JOIN agents a ON a.agent_id=$3
         WHERE r.id=$1`,
        [input.roomId, input.principalId, agentId],
      )
    ).rows[0];
    return row
      ? {
          workspaceId: row.workspace_id,
          member: Boolean(row.role),
          ...(row.role ? { role: row.role } : {}),
          ...(row.kind ? { principalKind: row.kind } : {}),
          archived: row.archived,
          // An agent is a server-validated Room member and is never gated by the
          // owner's cost policy; only a human sender answers to it. With no
          // `agents` row the server has nothing to say and says nothing: the
          // field is absent and the helper keeps its own reading.
          ...(row.access_policy === null
            ? {}
            : {
                mayAddressAgent:
                  row.kind === 'agent' ||
                  senderMayAddressAgent(
                    parseAgentAccessPolicy(row.access_policy),
                    input.principalId,
                    row.owner_id ?? undefined,
                  ),
              }),
        }
      : { workspaceId: input.roomId, member: false, archived: true };
  }

  export async function daemonPermissionAuthority(ctx: DaemonContext, input: Input<'getPermissionAuthority'>) {
    const row = (
      await ctx.database.query<{ status: string; generation: string }>(
        `SELECT status,generation FROM permission_authority WHERE permission_id=$1 AND room_id=$2 AND principal_id=$3 AND ($4::text IS NULL OR action_id=$4)`,
        [input.permissionId, input.roomId, input.principalId, input.actionId ?? null],
      )
    ).rows[0];
    return row
      ? {
          status:
            row.status === 'authorized'
              ? 'authorized'
              : row.status === 'denied'
                ? 'denied'
                : 'unavailable',
          generation: Number(row.generation),
        }
      : { status: 'unavailable' as const };
  }

  export async function daemonMissionAuthority(ctx: DaemonContext) {
    // Nothing has ever written mission authority; this is the answer an absent row gave.
    return { status: 'unavailable' as const };
  }

  export async function daemonScheduleAuthority(ctx: DaemonContext, input: Input<'getWorkScheduleAuthority'>, agentId: string) {
    if (input.agentId !== agentId) return { status: 'denied' as const };
    const row = await ctx.database.query<{ authority_status: string }>(
      `SELECT authority_status FROM work_schedules WHERE schedule_id=$1 AND revision=$2 AND agent_id=$3 AND room_id=$4`,
      [input.scheduleId, input.revision, agentId, input.roomId],
    );
    return {
      status:
        row.rows[0]?.authority_status === 'authorized'
          ? ('authorized' as const)
          : ('unavailable' as const),
    };
  }

  export async function daemonMandate(ctx: DaemonContext, input: Input<'getAgentToolMandate'>, agentId: string) {
    const row = (
      await ctx.database.query<{ generation: string; mandate: { expiresAt?: number } }>(
        `SELECT generation,mandate FROM agent_mandates WHERE agent_id=$1 AND room_id=$2`,
        [agentId, input.roomId],
      )
    ).rows[0];
    return row && (!row.mandate.expiresAt || row.mandate.expiresAt > Date.now())
      ? { status: 'valid' as const, generation: Number(row.generation) }
      : { status: row ? ('invalid' as const) : ('unavailable' as const) };
  }

  export async function daemonTargetAuthority(ctx: DaemonContext, input: Input<'getTargetAgentAuthority'>, agentId: string) {
    if (input.controllerAgentId !== agentId) return { status: 'denied' as const };
    const controller = await ctx.database.query(
      `SELECT 1 FROM memberships c JOIN memberships t ON t.room_id=c.room_id WHERE c.room_id=$1 AND c.identity_id=$2 AND t.identity_id=$3 AND c.removed_at IS NULL AND t.removed_at IS NULL`,
      [input.roomId, agentId, input.targetAgentId],
    );
    return { status: controller.rowCount ? ('authorized' as const) : ('denied' as const) };
  }
