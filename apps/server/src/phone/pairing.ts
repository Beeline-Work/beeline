import { agentHandleFromName } from '@beeline/api-contract/phone';
import { assetUrl } from '../phone-identity.js';
import { isSubscribableEventKind } from '@beeline/api-contract/phone';
import { setRoomEventSubscriptions } from '../agent-subscriptions.js';
import { CornerAccessDatabase } from '../corner-access-database.js';
import { recordAgentConnectedAfterNudge } from '../free-agent-warning.js';
import { machineSquireReport } from '../squire-machine.js';
import type { AgentPairingClaimView, InviteView } from '@beeline/api-contract/phone';
import { assignSeededAgentIdentity, uniqueAgentHandle, isCommunityInviteToken, resolveFace } from '@beeline/api-contract/phone';
import { type SqlDatabase } from '../database.js';
import { ensureInvitedWorkspaceMembership, restorePairedWorkspaceMembership, joinRooms } from '../membership-join.js';
import { grantSquireToOwnerMachineAgents } from '../workbench.js';
import type { PhoneContext } from './context.js';
import { hash, unix, normalizeAgentName, CONNECT_RENAME_WINDOW_MS } from './values.js';



  export async function phoneReadInvite(ctx: PhoneContext, rawToken: string, viewerId: string): Promise<InviteView | null> {
    if (!isCommunityInviteToken(rawToken)) return null;
    const result = await ctx.database.query<{
      name: string;
      avatar: string | null;
      expires_at: Date | null;
      workspace_id: string;
      already_joined: boolean;
      inviter_name: string;
      inviter_handle: string | null;
      inviter_face: string | null;
      inviter_role: 'owner' | 'admin' | 'member' | 'spectator' | null;
      people: number;
      agents: number;
    }>(
      `SELECT w.name,w.avatar,i.expires_at,i.workspace_id,
         EXISTS(SELECT 1 FROM memberships joined
           WHERE joined.workspace_id=i.workspace_id AND joined.room_id IS NULL
             AND joined.identity_id=$2 AND joined.removed_at IS NULL) already_joined,
         inviter.name inviter_name,inviter.handle inviter_handle,inviter.face_id inviter_face,
         creator.role inviter_role,
         (SELECT count(*)::int FROM memberships m JOIN identities member ON member.id=m.identity_id
          WHERE m.workspace_id=i.workspace_id AND m.room_id IS NULL AND m.removed_at IS NULL
            AND member.kind='human' AND member.hidden_from_roster=false) people,
         (SELECT count(*)::int FROM memberships m JOIN identities member ON member.id=m.identity_id
          WHERE m.workspace_id=i.workspace_id AND m.room_id IS NULL AND m.removed_at IS NULL
            AND member.kind='agent' AND member.hidden_from_roster=false) agents
       FROM invites i
       JOIN workspaces w ON w.id=i.workspace_id
       LEFT JOIN memberships creator ON creator.workspace_id=i.workspace_id AND creator.room_id IS NULL
         AND creator.identity_id=i.created_by AND creator.removed_at IS NULL
       JOIN identities inviter ON inviter.id=i.created_by
       WHERE i.token_hash=$1 AND (i.expires_at IS NULL OR i.expires_at>now()) AND i.consumed_at IS NULL
         AND ((i.public_token IS NOT NULL AND w.visibility='public')
           OR (i.public_token IS NULL AND creator.identity_id IS NOT NULL))`,
      [hash(rawToken), viewerId],
    );
    const row = result.rows[0];
    return row
      ? {
          name: row.name,
          ...(row.avatar ? { avatar: assetUrl(row.avatar, ctx.publicOrigin) } : {}),
          expiresAt: row.expires_at ? unix(row.expires_at) : 0,
          ...(row.already_joined ? { joinedWorkspaceId: row.workspace_id } : {}),
          inviter: {
            name: row.inviter_name,
            ...(row.inviter_handle ? { handle: row.inviter_handle } : {}),
            ...(row.inviter_face ? { face: row.inviter_face } : {}),
            role: row.inviter_role ?? 'member',
          },
          memberCount: row.people,
          agentCount: row.agents,
        }
      : null;
  }


  export async function phoneLockPairingIssuer(ctx: PhoneContext, database: SqlDatabase, workspaceId: string, issuerId: string) {
    database = new CornerAccessDatabase(database);
    await database.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [workspaceId]);
    const issuer = await database.query(
      `SELECT id FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
         AND identity_id=$2 AND removed_at IS NULL FOR UPDATE`,
      [workspaceId, issuerId],
    );
    return issuer.rowCount > 0;
  }


  export async function phoneClaimAgentPairing(ctx: PhoneContext, code: string, agentId: string): Promise<AgentPairingClaimView | null> {
    return ctx.database.transaction(async (database) => {
      const candidate = (
        await database.query<{ workspace_id: string; created_by: string }>(
          `SELECT workspace_id,created_by FROM agent_pairing_codes WHERE code_hash=$1
             AND EXISTS(SELECT 1 FROM identities WHERE id=$2 AND kind='agent')`,
          [hash(code),agentId],
        )
      ).rows[0];
      if (!candidate) return null;
      if (!(await ctx.lockPairingIssuer(database, candidate.workspace_id, candidate.created_by)))
        return null;
      const result = await database.query<{
        workspace_id: string;
        created_by: string;
        claimed_by: string | null;
      }>(
        `SELECT workspace_id,created_by,claimed_by FROM agent_pairing_codes WHERE code_hash=$1 AND expires_at>now() FOR UPDATE`,
        [hash(code)],
      );
      const pairing = result.rows[0];
      if (!pairing || (pairing.claimed_by && pairing.claimed_by !== agentId)) return null;
      const joined = !pairing.claimed_by;
      if (joined)
        await database.query(
          `UPDATE agent_pairing_codes SET claimed_by=$2,claimed_at=now() WHERE code_hash=$1`,
          [hash(code), agentId],
        );
      const workspaceMembership = await ensureInvitedWorkspaceMembership(database, [pairing.workspace_id, agentId, pairing.created_by]);
      const rooms = await joinRooms(database, {
        workspaceId: pairing.workspace_id,
        identityId: agentId,
        invitedById: pairing.created_by,
        rooms: { type: 'all-live-top-level' },
        workspaceJoined: workspaceMembership.rowCount > 0,
      });
      return {
        workspaceId: pairing.workspace_id,
        pairedBy: pairing.created_by,
        joined,
        attachedRoomIds: rooms.roomIds,
      };
    });
  }


  /**
   * The animals, names and souls the Workspace is already using. Only the
   * server knows the roster, so seeded-identity assignment happens here — and
   * always inside the caller's transaction, under the Workspace row lock, so
   * two agents connecting at once cannot both take the fox.
   */
  export async function phoneWornSeededIdentity(ctx: PhoneContext,
    database: SqlDatabase,
    workspaceId: string,
    exceptIdentityId: string,
  ): Promise<{ faces: string[]; names: string[] }> {
    database = new CornerAccessDatabase(database);
    const rows = await database.query<{
      id: string;
      name: string;
      face_id: string | null;
    }>(
      `SELECT i.id,i.name,i.face_id
       FROM memberships m
       JOIN identities i ON i.id=m.identity_id
       WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL
         AND i.hidden_from_roster=false AND i.id<>$2`,
      [workspaceId, exceptIdentityId],
    );
    return {
      // A member with no chosen face still wears one: the hash default every
      // tile draws. Both count as taken, people and agents alike.
      faces: rows.rows.map((row) => resolveFace(row.face_id, row.id)),
      names: rows.rows.map((row) => row.name),
    };
  }


  

  export async function phoneClaimAgentConnectPairing(ctx: PhoneContext, input: {
      code: string;
      agentPubkey: string;
      model: string;
      effort?: string;
      avatarSeed?: string;
      eventSubscriptions?: readonly string[];
      deferJoin?: boolean;
      machineId?: string;
      machineName?: string;
    }, createDaemonExchange?: (
      agentId: string,
      database: SqlDatabase,
    ) => Promise<{ exchangeToken: string }>): Promise<
    | {
        status: 'claimed';
        workspaceId: string;
        workspaceName: string;
        pairedBy: string;
        agentName: string;
        soul: string;
        face: string;
        workspaceJoined: boolean;
        daemonExchangeToken?: string;
      }
    | { status: 'not_found' | 'expired' | 'already_claimed' }
  > {
    return ctx.database.transaction(async (database) => {
      const candidate = (await database.query<{ workspace_id: string; created_by: string }>(
        `SELECT workspace_id,created_by FROM agent_pairing_codes WHERE code_hash=$1`, [hash(input.code)],
      )).rows[0];
      if (!candidate) return { status: 'not_found' };
      if (!(await ctx.lockPairingIssuer(database, candidate.workspace_id, candidate.created_by)))
        return { status: 'not_found' };
      const result = await database.query<{
        workspace_id: string;
        workspace_name: string;
        created_by: string;
        claimed_by: string | null;
        expires_at: Date;
      }>(
        `SELECT pairing.workspace_id,workspace.name AS workspace_name,pairing.created_by,
                pairing.claimed_by,pairing.expires_at
         FROM agent_pairing_codes pairing
         JOIN workspaces workspace ON workspace.id=pairing.workspace_id
         WHERE pairing.code_hash=$1
         FOR UPDATE OF pairing`,
        [hash(input.code)],
      );
      const pairing = result.rows[0];
      if (!pairing) return { status: 'not_found' };
      if (pairing.expires_at.getTime() <= Date.now()) return { status: 'expired' };
      if (pairing.claimed_by) return { status: 'already_claimed' };

      const worn = await ctx.wornSeededIdentity(database, pairing.workspace_id, input.agentPubkey);
      const seeded = assignSeededAgentIdentity({
        seed: input.agentPubkey,
        takenFaces: worn.faces,
        takenNames: worn.names,
      });
      // Pairing a key whose agent was removed starts it over rather than
      // resurrecting it: the seeded name, animal and soul are assigned afresh
      // under the same dedup, and every retired setting is written back to its
      // freshly-paired value. A key that belongs to a person is never
      // overwritten into an agent.
      const identityRow = await database.query(
        `INSERT INTO identities(id,kind,name,handle,face_id) VALUES($1,'agent',$2,beeline_identity_handle($1,$3),$4)
         ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,face_id=EXCLUDED.face_id,
           avatar=NULL,hidden_from_roster=false,updated_at=now()
         WHERE identities.kind='agent'
         RETURNING id`,
        [input.agentPubkey, seeded.name, agentHandleFromName(seeded.name), seeded.face],
      );
      if (!identityRow.rowCount) throw new Error('pairing key belongs to a person');
      await database.query(
        `INSERT INTO agents(agent_id,owner_id,soul,selected_model,selected_effort,machine_id,machine_name)
         VALUES($1,$2,$3::jsonb,$4,$5,$6,$7)
         ON CONFLICT(agent_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,soul=EXCLUDED.soul,
           selected_model=EXCLUDED.selected_model,selected_effort=EXCLUDED.selected_effort,
           model_catalog='[]'::jsonb,model_unavailable=NULL,commands='[]'::jsonb,
           yolo_mode=false,yolo_set_by=NULL,yolo_set_at=NULL,
           access_policy='{"type":"everyone"}'::jsonb,machine_id=EXCLUDED.machine_id,
           machine_name=EXCLUDED.machine_name,updated_at=now()`,
        [
          input.agentPubkey,
          pairing.created_by,
          JSON.stringify({
            name: seeded.name,
            instructions: seeded.soul,
            avatarSeed: input.avatarSeed || input.agentPubkey,
          }),
          input.model,
          input.effort || null,
          input.machineId || null,
          input.machineName || null,
        ],
      );
      await database.query(
        `UPDATE agent_pairing_codes SET claimed_by=$2,claimed_at=now() WHERE code_hash=$1`,
        [hash(input.code), input.agentPubkey],
      );
      const workspaceMembership = await restorePairedWorkspaceMembership(database, [pairing.workspace_id, input.agentPubkey, pairing.created_by]);
      // A deferring CLI joins Rooms itself through `finishAgentConnectPairing`
      // once its rename decision settles — a system line is a fact written
      // once, never rewritten by a later rename, so it must not be written
      // under the seeded name only to go stale the moment the person renames.
      // A CLI that never asked to defer (every already-installed helper) gets
      // the original, immediate join right here instead.
      if (!input.deferJoin) {
        const joined = await joinRooms(database, {
          workspaceId: pairing.workspace_id,
          identityId: input.agentPubkey,
          invitedById: pairing.created_by,
          rooms: { type: 'all-live-top-level' },
          workspaceJoined: workspaceMembership.rowCount > 0,
        });
        // Old helpers can advertise retired per-item kinds; those were never actionable subscriptions.
        const subscriptions = [...new Set(input.eventSubscriptions ?? [])].filter(isSubscribableEventKind);
        if (subscriptions.length && joined.roomIds.length) {
          for (const roomId of joined.roomIds) await setRoomEventSubscriptions(database, roomId, input.agentPubkey, subscriptions);
        }
      }
      const machineId = input.machineId || input.agentPubkey;
      const squireOnMachine = await machineSquireReport(database, pairing.created_by, machineId);
      const squireInstalling = await database.query(
        `SELECT 1 FROM squire_machines source JOIN agents a ON a.agent_id=source.helper_agent_id
         JOIN memberships m ON m.identity_id=a.agent_id
         WHERE source.owner_id=$1 AND source.machine_id=$2
           AND source.squire_work->>'install'='true'
           AND m.workspace_id=$3 AND m.room_id IS NULL AND m.removed_at IS NULL LIMIT 1`,
        [pairing.created_by, machineId, pairing.workspace_id],
      );
      if (squireOnMachine?.status === 'connected' || squireInstalling.rowCount) {
        await grantSquireToOwnerMachineAgents(database, {
          workspaceId: pairing.workspace_id, ownerIdentityId: pairing.created_by,
          machineId, agentId: input.agentPubkey,
        });
      }
      await recordAgentConnectedAfterNudge(database, pairing.created_by, pairing.workspace_id, input.agentPubkey);
      const exchange = createDaemonExchange
        ? await createDaemonExchange(input.agentPubkey, database)
        : undefined;
      return {
        status: 'claimed',
        workspaceId: pairing.workspace_id,
        workspaceName: pairing.workspace_name,
        pairedBy: pairing.created_by,
        agentName: seeded.name,
        soul: seeded.soul,
        face: seeded.face,
        workspaceJoined: workspaceMembership.rowCount > 0,
        ...(exchange ? { daemonExchangeToken: exchange.exchangeToken } : {}),
      };
    });
  }


  /**
   * The one rename the terminal may make: right after `usebeeline connect`
   * prints the seeded identity, before the person has ever opened the app.
   * Authority is the pairing code itself — typed out of the app by someone who
   * could already add an agent — and it expires with the claim, so the CLI
   * never holds standing authority over the name. Every later rename goes
   * through the app's owner-gated agent page.
   */
  export async function phoneRenameConnectedAgent(ctx: PhoneContext, input: {
    code: string;
    name: string;
  }): Promise<{ status: 'renamed'; agentName: string } | { status: 'not_found' | 'expired' }> {
    const name = normalizeAgentName(input.name);
    return ctx.database.transaction(async (database) => {
      const pairing = (
        await database.query<{
          claimed_by: string | null;
          claimed_at: Date | null;
          workspace_id: string;
        }>(
          `SELECT claimed_by,claimed_at,workspace_id FROM agent_pairing_codes WHERE code_hash=$1 FOR UPDATE`,
          [hash(input.code)],
        )
      ).rows[0];
      if (!pairing?.claimed_by || !pairing.claimed_at) return { status: 'not_found' };
      if (Date.now() - pairing.claimed_at.getTime() > CONNECT_RENAME_WINDOW_MS)
        return { status: 'expired' };
      await database.query(`UPDATE identities SET name=$2,updated_at=now() WHERE id=$1`, [
        pairing.claimed_by,
        name,
      ]);
      await database.query(
        `UPDATE agents SET soul=jsonb_set(soul,'{name}',to_jsonb($2::text)),updated_at=now()
         WHERE agent_id=$1 AND soul IS NOT NULL`,
        [pairing.claimed_by, name],
      );
      return { status: 'renamed', agentName: name };
    });
  }


  /**
   * The last step of `usebeeline connect`: room membership and the "joined"
   * announcement, run once the wizard's one rename window has closed (kept or
   * renamed). `renameConnectedAgent` may have already retitled the identity by
   * the time this runs, so `joinRooms` reads its final name straight off
   * `identities` — the same order a human follows, whose name is sealed at
   * GitHub sign-in before they ever join a Workspace.
   */
  export async function phoneFinishAgentConnectPairing(ctx: PhoneContext, input: {
    code: string;
    workspaceJoined: boolean;
    eventSubscriptions?: readonly string[];
  }): Promise<{ status: 'finished' } | { status: 'not_found' | 'expired' }> {
    return ctx.database.transaction(async (database) => {
      const pairing = (
        await database.query<{
          claimed_by: string | null;
          claimed_at: Date | null;
          created_by: string;
          workspace_id: string;
        }>(
          `SELECT claimed_by,claimed_at,created_by,workspace_id
           FROM agent_pairing_codes WHERE code_hash=$1 FOR UPDATE`,
          [hash(input.code)],
        )
      ).rows[0];
      if (!pairing?.claimed_by || !pairing.claimed_at) return { status: 'not_found' };
      if (Date.now() - pairing.claimed_at.getTime() > CONNECT_RENAME_WINDOW_MS)
        return { status: 'expired' };
      const joined = await joinRooms(database, {
        workspaceId: pairing.workspace_id,
        identityId: pairing.claimed_by,
        invitedById: pairing.created_by,
        rooms: { type: 'all-live-top-level' },
        workspaceJoined: input.workspaceJoined,
      });
      // What this agent reacts to, in the Rooms it just joined. A subscription
      // is per Room because an event happens in a Room; `usebeeline connect
      // --subscribe joined` is what a greeter is set up with.
      // Old helpers can advertise retired per-item kinds; those were never actionable subscriptions.
      const subscriptions = [...new Set(input.eventSubscriptions ?? [])].filter(isSubscribableEventKind);
      if (subscriptions.length && joined.roomIds.length) {
        for (const roomId of joined.roomIds) await setRoomEventSubscriptions(database, roomId, pairing.claimed_by, subscriptions);
      }
      return { status: 'finished' };
    });
  }
