import { type PhoneIdentityRow as IdentityRow } from '../phone-identity.js';
import { withdrawMergeApprovalsBy } from '../corner-merge-approval.js';
import { cornerOwnerSql } from '../corner-worker.js';
import { collapseTombstonedCornerHolds } from '../corner-holds.js';
import { isFaceId, isPushLevel } from '@beeline/api-contract/phone';
import { lockCornerLifecycle, clearCornerReviewers } from '../corner-lifecycle.js';
import { transferWorkspaceOwnership, transferRoomOwnership, writeSurfacePushState } from '../membership-join.js';
import { ARTIFACT_TTL_HOURS, mediaTtlHours } from '../media-ttl.js';
import { closeCornerState, lockCornerArchivalAuthority, markOwnedCornersAbandoned } from '../corner-close.js';
import { DELETED_ACCOUNT_IDENTITY_ID, DELETED_ACCOUNT_NAME, SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { PhoneContext } from './context.js';
import { phoneRequireIdentity } from './access.js';
import { Input } from './types.js';
import { phoneManagedIdentity } from './repositories.js';


  /**
   * Deletes the signed-in person's account and personal data — a real
   * `DELETE FROM identities`, not a flag — in one transaction:
   *
   *   - every agent the account owns is removed outright (its identity row
   *     goes too); its daemon tokens, schedules and grants die with it, and
   *     the corners it owned lose their owner and archive as
   *     `done`/`abandoned` (account deletion is a full erasure, so those
   *     corners cannot wait for a helper);
   *   - Workspace/Room ownership the account held alone passes to the
   *     longest-serving remaining human (admin first), so shared surfaces
   *     stay manageable;
   *   - messages the account or its agents authored in Rooms, corners and
   *     DMs that others still read remain as the conversation record (the
   *     privacy page's "Room content may remain available" rule) but are
   *     re-attributed to the hidden DELETED_ACCOUNT_IDENTITY_ID author and
   *     stripped of their mentions of the deleted ids;
   *   - DM Rooms whose only other participants were the account's own agents
   *     are deleted outright — nobody else relies on them;
   *   - every Composio connected account the person owns is revoked at the
   *     provider first; a revocation failure aborts before anything is erased;
   *   - every free agent's Machine is deleted next, for the same reason;
   *   - sign-in identity links (`beeline_identity_links`) for the person's
   *     subjects and keys are deleted;
   *   - sessions, access/refresh/daemon tokens, push devices, media bytes,
   *     GitHub tokens/links/installations, invites, pairing codes, grants,
   *     read marks and succession rows all go with the identity row's
   *     cascades.
   *
   * Idempotent: once the identity row is gone the operation resolves without
   * effect, so a retried or doubled call never errors. A fresh GitHub sign-in
   * with the same subject afterwards creates a NEW account.
   */
  export async function phoneDeleteAccount(ctx: PhoneContext, viewerId: string) {
    if (viewerId === SYSTEM_IDENTITY_ID) throw new Error('only a person may delete their account');
    // Idempotency floor: an already-deleted account reads as an empty graph.
    const held = await ctx.database.query(`SELECT 1 FROM identities WHERE id=$1`, [viewerId]);
    if (!held.rowCount) return;
    const account = await phoneRequireIdentity(ctx, viewerId);
    if (account.kind !== 'human') throw new Error('only a person may delete their account');
    // Provider tokens live at Composio, not here: revoke every connected
    // account the person owns before erasing anything, so a failed revocation
    // leaves the account whole and a retry finishes the job. Composio's
    // deleteAccount already treats an account that is gone as revoked.
    const providerAccounts = await ctx.database.query<{ composio_account_id: string }>(
      `SELECT DISTINCT composio_account_id FROM workspace_apps
       WHERE owner_identity_id=$1 AND composio_account_id IS NOT NULL`,
      [viewerId],
    );
    if (providerAccounts.rowCount && !ctx.composio)
      throw new Error('App connections cannot be revoked now; try again later');
    for (const row of providerAccounts.rows)
      await ctx.composio!.deleteAccount(row.composio_account_id);
    // Free agents run on their own Machines. The identity delete cascades the
    // free_agents row the leader's removal sweep would need, so retire each
    // agent and delete its Machine first; anything left aborts for a retry.
    const freeAgentIds = (
      await ctx.database.query<{ agent_id: string }>(
        `UPDATE free_agents SET removed_at=coalesce(removed_at,now()),updated_at=now()
         WHERE owner_id=$1 OR agent_id IN (SELECT agent_id FROM agents WHERE owner_id=$1)
         RETURNING agent_id`,
        [viewerId],
      )
    ).rows.map((row) => row.agent_id);
    if (ctx.freeAgents)
      for (const agentId of freeAgentIds) await ctx.freeAgents.cleanupRemoved(agentId);
    const machinesLeft = await ctx.database.query(
      `SELECT 1 FROM free_agents WHERE agent_id=ANY($1) AND removal_cleaned_at IS NULL
         AND (fly_machine_id IS NOT NULL OR $2::boolean)`,
      [freeAgentIds, Boolean(ctx.freeAgents)],
    );
    if (machinesLeft.rowCount) throw new Error('Agent machines are still stopping; try again shortly');
    await ctx.database.transaction(async (database) => {
      const owned = await database.query<{ agent_id: string }>(
        `SELECT agent_id FROM agents WHERE owner_id=$1
         UNION SELECT agent_id FROM free_agents WHERE owner_id=$1`,
        [viewerId],
      );
      // Everything erased by this deletion: the person and each agent it owned.
      const gone = [viewerId, ...owned.rows.map((row) => row.agent_id)];
      const plannedCorners = await database.query<{id:string}>(
        `SELECT c.id FROM rooms c WHERE c.parent_id IS NOT NULL AND c.archived_at IS NULL
           AND ${cornerOwnerSql('c.id')}=ANY($1) ORDER BY c.id`, [gone]);
      for (const corner of plannedCorners.rows) await lockCornerLifecycle(database, corner.id);
      await lockCornerArchivalAuthority(database);
      // Discovery takes no row locks. A newly acquired agent/corner changes
      // the deletion scope and requires a new explicit attempt, rather than
      // taking another lifecycle lock while holding authority in reverse order.
      const currentOwned = await database.query<{agent_id:string}>(
        `SELECT agent_id FROM agents WHERE owner_id=$1
         UNION SELECT agent_id FROM free_agents WHERE owner_id=$1`, [viewerId]);
      const plannedAgents = new Set(owned.rows.map(row => row.agent_id));
      if (currentOwned.rows.length !== plannedAgents.size || currentOwned.rows.some(row => !plannedAgents.has(row.agent_id)))
        throw new Error('Account changed while deletion was being prepared; try again');
      const closingCorners = await database.query<{ id: string }>(
        `SELECT c.id FROM rooms c WHERE c.parent_id IS NOT NULL AND c.archived_at IS NULL
           AND ${cornerOwnerSql('c.id')}=ANY($1) ORDER BY c.id FOR KEY SHARE OF c`, [gone]);
      const plannedIds = new Set(plannedCorners.rows.map(row => row.id));
      if (closingCorners.rows.some(row => !plannedIds.has(row.id)))
        throw new Error('Account changed while deletion was being prepared; try again');
      await database.query(`SELECT 1 FROM identities WHERE id=$1 FOR UPDATE`, [viewerId]);
      if (!(await database.query(`SELECT 1 FROM identities WHERE id=$1`, [viewerId])).rowCount) return;

      // The agents are removed, not re-owned: tokens, schedules and grants die
      // with them, and their corners archive as removeAgent archives them.
      await database.query(`UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=ANY($1)`, [
        gone,
      ]);
      await database.query(
        `DELETE FROM agent_grants WHERE agent_id=ANY($1) OR requested_by=ANY($1)`,
        [gone],
      );
      await database.query(`UPDATE agent_grants SET decided_by=NULL WHERE decided_by=ANY($1)`, [
        gone,
      ]);
      // Lifecycle scope and authority were locked before any erasure above.
      // Preserve the common close path, including workflow and wake cleanup.
      for (const corner of closingCorners.rows) await closeCornerState(database, corner.id);
      await markOwnedCornersAbandoned(database, gone, `${account.name} deleted their account`);
      await database.query(
        `DELETE FROM agent_schedules WHERE agent_id=ANY($1) OR creator_id=ANY($1)`,
        [gone],
      );

      // Ownership the account held alone passes to the longest-serving
      // remaining human (admin first), so the shared surfaces stay manageable.
      await transferWorkspaceOwnership(database, [gone]);
      await transferRoomOwnership(database, [gone]);

      // Authored content survives as the shared record, anonymised to the one
      // hidden tombstone author. Nothing strips the tags those people were
      // named by: a tag is read against current membership, and a deleted
      // account is no longer a member, so its old @handle already names nobody.
      await database.query(
        `INSERT INTO identities(id,kind,name,hidden_from_roster,github_subject)
         VALUES ($1,'human',$2,true,NULL) ON CONFLICT (id) DO NOTHING`,
        [DELETED_ACCOUNT_IDENTITY_ID, DELETED_ACCOUNT_NAME],
      );
      await database.query(`UPDATE messages SET author_id=$2 WHERE author_id=ANY($1)`, [
        gone,
        DELETED_ACCOUNT_IDENTITY_ID,
      ]);
      // Workspace deletion audits outlive both the workspace and its actor.
      // Preserve the event while anonymising attribution like shared messages.
      await database.query(`UPDATE workspace_deletions SET deleted_by=$2 WHERE deleted_by=ANY($1)`, [
        gone,
        DELETED_ACCOUNT_IDENTITY_ID,
      ]);
      // Active merge holds stay active under the tombstone holder. A corner
      // keeps one active hold per holder, so when several holds on one corner
      // now share the tombstone, only the hardest to release stays. Any member
      // may release an agent's hold, while a person's hold needs standing above
      // its own, so person holds outrank agent holds before standing does.
      await collapseTombstonedCornerHolds(database, gone, DELETED_ACCOUNT_IDENTITY_ID);
      // Corner records and installed apps are shared
      // history: they keep the tombstone as author, like messages do.
      for (const [table, column] of [
        ['messages', 'deleted_by'],
        // Retained only for rolling-deployment and rollback compatibility.
        ['corner_facts', 'owner_agent_id'],
        ['corner_apps', 'author_agent_id'],
        ['corner_app_installations', 'installed_by'],
        ['corner_app_installations', 'developer_agent_id'],
        ['corner_app_bindings', 'bound_by'],
        ['corner_brief_revisions', 'author_id'],
        ['corner_merge_holds', 'actor_id'],
        ['corner_merge_holds', 'released_by'],
        ['corner_merge_holds', 'set_by_agent_id'],
      ])
        if ((await database.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL present`, [table])).rows[0]!.present)
          await database.query(`UPDATE ${table} SET ${column}=$2 WHERE ${column}=ANY($1)`, [
            gone,
            DELETED_ACCOUNT_IDENTITY_ID,
          ]);
      // Optional attributions simply lose the deleted id; a corner's own
      // reviewer changes only through the corner module.
      await clearCornerReviewers(database, gone);
      for (const [table, column] of [
        ['rooms', 'reviewer_agent_id'],
        ['connector_offers', 'accepted_by'],
        ['agent_schedules', 'owner_id'],
        ['agent_schedules', 'updated_by'],
        ['workspace_skills', 'creator_agent_id'],
        ['workspace_skills', 'owner_agent_id'],
      ])
        await database.query(`UPDATE ${table} SET ${column}=NULL WHERE ${column}=ANY($1)`, [gone]);

      // DM Rooms nobody else relies on (person↔own-agent) go with the account;
      // the rest lose the deleted participant from their participant list.
      await database.query(
        `UPDATE rooms SET direct_participants=(
           SELECT coalesce(jsonb_agg(p),'[]'::jsonb)
           FROM jsonb_array_elements(direct_participants) p
           WHERE p#>>'{}' <> ALL($1))
         WHERE direct_participants IS NOT NULL`,
        [gone],
      );
      await database.query(
        `DELETE FROM rooms WHERE direct_participants IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM memberships m JOIN identities i ON i.id=m.identity_id
           WHERE m.room_id=rooms.id AND m.removed_at IS NULL
             AND i.kind='human' AND i.id <> ALL($1))`,
        [gone],
      );

      // Receipts, output streams and authority rows that point at the gone ids.
      await database.query(`DELETE FROM live_outputs WHERE agent_id=ANY($1)`, [gone]);
      await database.query(
        `UPDATE agent_commands SET agent_id=$2 WHERE agent_id=ANY($1) AND reason='corner_objective'`,
        [gone, DELETED_ACCOUNT_IDENTITY_ID],
      );
      await database.query(`DELETE FROM agent_commands WHERE agent_id=ANY($1) AND reason<>'corner_objective'`, [gone]);
      await database.query(`DELETE FROM agent_turn_traces WHERE agent_id=ANY($1)`, [gone]);
      await database.query(`DELETE FROM agent_turns WHERE agent_id=ANY($1)`, [gone]);
      await database.query(`DELETE FROM agent_turn_traces WHERE agent_id=ANY($1)`, [gone]);
      await database.query(`DELETE FROM computer_sessions WHERE agent_id=ANY($1)`, [gone]);
      await database.query(
        `DELETE FROM starter_onboarding_runs
         WHERE user_id=ANY($1) OR beebee_id=ANY($1) OR luna_id=ANY($1)`,
        [gone],
      );
      await database.query(`DELETE FROM free_agents WHERE agent_id=ANY($1) OR owner_id=ANY($1)`, [
        gone,
      ]);
      await database.query(`DELETE FROM work_schedules WHERE agent_id=ANY($1)`, [gone]);
      await database.query(`DELETE FROM schedule_receipts WHERE agent_id=ANY($1)`, [gone]);
      await database.query(`DELETE FROM agent_mandates WHERE agent_id=ANY($1)`, [gone]);
      await database.query(`DELETE FROM permission_authority WHERE principal_id=ANY($1)`, [gone]);
      await withdrawMergeApprovalsBy(database, gone);
      await database.query(`DELETE FROM invites WHERE created_by=ANY($1)`, [gone]);
      await database.query(
        `DELETE FROM agent_pairing_codes WHERE created_by=ANY($1) OR claimed_by=ANY($1)`,
        [gone],
      );
      await database.query(
        `DELETE FROM identity_successions
         WHERE old_identity_id=ANY($1) OR new_identity_id=ANY($1)`,
        [gone],
      );

      // Object bytes are personal data: the rows go, and a tombstone keeps the
      // readers' story the one media-ttl.ts already tells (expired, not lost).
      if (ctx.objects) await ctx.objects.deleteOwnedBytes(gone, database);
      else if (
        (await database.query(`SELECT 1 FROM objects WHERE owner_id=ANY($1) LIMIT 1`, [gone]))
          .rowCount
      )
        throw new Error('object storage is not configured');
      await database.query(
        `WITH swept AS (DELETE FROM objects WHERE owner_id=ANY($1) RETURNING id,kind)
         INSERT INTO object_expirations(id,retention_hours)
         SELECT id,CASE kind WHEN 'artifact' THEN $2::integer ELSE $3::integer END FROM swept
         ON CONFLICT(id) DO NOTHING`,
        [gone, ARTIFACT_TTL_HOURS, mediaTtlHours()],
      );

      // Rooms and GitHub connections the account created: the artifacts stay,
      // the attribution goes.
      await database.query(`UPDATE rooms SET created_by=NULL WHERE created_by=ANY($1)`, [gone]);
      await database.query(`DELETE FROM github_installations WHERE owner_id=ANY($1)`, [gone]);
      await database.query(
        `DELETE FROM github_user_tokens WHERE subject IN (
           SELECT github_subject FROM identities WHERE id=$1 AND github_subject IS NOT NULL)`,
        [viewerId],
      );

      // Sign-in links (auth schema, same database) that map a Google, GitHub
      // or other OIDC subject to this person: every link of a key bound to one
      // of the person's subjects, and any link bound to the account id itself.
      await database.query(
        `WITH subjects AS (
           SELECT issuer,subject FROM identity_external_links WHERE identity_id=$1
           UNION SELECT 'https://github.com',github_subject FROM identities
           WHERE id=$1 AND github_subject IS NOT NULL
         ), keys AS (
           SELECT link.pubkey::text AS pubkey FROM beeline_identity_links link
           JOIN subjects ON subjects.issuer=link.issuer AND subjects.subject=link.subject
           UNION SELECT $1::text
         )
         DELETE FROM beeline_identity_links WHERE pubkey::text IN (SELECT pubkey FROM keys)`,
        [viewerId],
      );

      // The account itself. Sessions, access/refresh/daemon tokens, push
      // devices, memberships, external links, read marks and the agent rows
      // all follow through ON DELETE CASCADE. The agents go first so their
      // rows' owner_id link dies before the owner's row does.
      await database.query(`DELETE FROM identities WHERE id=ANY($1) AND kind='agent'`, [gone]);
      await database.query(`DELETE FROM identities WHERE id=$1`, [viewerId]);
    });
  }

  export async function phoneUpdateProfile(ctx: PhoneContext, input: Input<'updatePersonProfile'>, viewerId: string) {
    if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 60))
      throw new Error('invalid person name');
    if (
      input.handle !== undefined &&
      !/^[a-z0-9](?:[a-z0-9._-]{0,28}[a-z0-9])?$/.test(input.handle)
    )
      throw new Error('invalid person handle');
    return ctx.database.transaction(async (database) => {
      if (input.handle !== undefined) {
        if (['channel', 'system', 'play-review', 'review', 'scheduler'].includes(input.handle))
          throw new Error('invalid reserved handle');
      }
      const updated = await database.query<IdentityRow>(
        `WITH target AS MATERIALIZED (SELECT id FROM identities WHERE id=$1 FOR UPDATE),
         claimed AS MATERIALIZED (
           SELECT CASE WHEN $3::text IS NULL THEN NULL ELSE beeline_identity_handle($1,$3,true) END handle FROM target
         ) UPDATE identities
         SET name=CASE WHEN $2::text IS NULL THEN name ELSE $2 END,
             handle=CASE WHEN $3::text IS NULL THEN identities.handle ELSE claimed.handle END,
             avatar=CASE WHEN $4::text IS NULL THEN avatar ELSE NULLIF($4,'') END,
             updated_at=now()
         FROM claimed WHERE id=$1 AND ($3::text IS NULL OR claimed.handle=$3)
         RETURNING id,kind,name,identities.handle,avatar`,
        [viewerId, input.name ?? null, input.handle ?? null, input.avatar ?? null],
      );
      const profile = updated.rows[0];
      if (!profile) throw new Error(input.handle===undefined?'identity not found':'managed handle is already claimed');
      return {
        personId: profile.id,
        name: profile.name,
        ...(profile.handle ? { handle: profile.handle } : {}),
        ...(profile.avatar ? { avatar: profile.avatar } : {}),
      };
    });
  }

  /** The face ceremony: one of `FACE_IDS` for the viewer's own identity, or null to clear. */
  export async function phoneUpdateFace(ctx: PhoneContext, input: Input<'updateIdentityFace'>, viewerId: string) {
    if (input.faceId !== null && !isFaceId(input.faceId)) throw new Error('invalid face id');
    const updated = await ctx.database.query(
      `UPDATE identities SET face_id=$2,updated_at=now() WHERE id=$1`,
      [viewerId, input.faceId],
    );
    if (!updated.rowCount) throw new Error('identity not found');
  }

  export async function phoneUpdateRoomPushState(ctx: PhoneContext, input: Input<'updateRoomPushState'>, viewerId: string) {
    if (
      (input.muted !== undefined && typeof input.muted !== 'boolean') ||
      (input.viewing !== undefined && typeof input.viewing !== 'boolean') ||
      (input.viewing !== undefined &&
        (typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 100))
    )
      throw new Error('invalid push state');
    return ctx.database.transaction(async (database) => {
      const updated = await writeSurfacePushState<{ push_muted: boolean }>(database, [input.roomId, viewerId, input.muted ?? null]);
      if (!updated.rows[0]) throw new Error('room not found');
      if (input.viewing === true)
        await database.query(
          `INSERT INTO room_push_views(room_id,identity_id,session_id,expires_at)
         VALUES($1,$2,$3,now()+interval '45 seconds')
         ON CONFLICT(room_id,identity_id,session_id) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
          [input.roomId, viewerId, input.sessionId],
        );
      if (input.viewing === false)
        await database.query(
          `DELETE FROM room_push_views WHERE room_id=$1 AND identity_id=$2 AND session_id=$3`,
          [input.roomId, viewerId, input.sessionId],
        );
      return { muted: updated.rows[0].push_muted };
    });
  }


  export async function phoneUpdatePushLevel(ctx: PhoneContext, input: Input<'updateIdentityPushLevel'>, viewerId: string) {
    if (!isPushLevel(input.pushLevel)) throw new Error('invalid push level');
    const updated = await ctx.database.query(
      `UPDATE identities SET push_level=$2,updated_at=now() WHERE id=$1 AND kind='human'`,
      [viewerId, input.pushLevel],
    );
    if (!updated.rowCount) throw new Error('identity not found');
    return phoneManagedIdentity(ctx, viewerId);
  }
