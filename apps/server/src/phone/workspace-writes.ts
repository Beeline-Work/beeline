import { createWorkspace } from '../workspace-creation.js';
import { storeWorkspaceAvatar } from '../durable-avatar.js';
import { revokeDaemonCredentials } from '../daemon-credential-lifetime.js';
import { removeWorkspaceMemberships } from '../membership-join.js';
import type { PhoneContext } from './context.js';
import { Input } from './types.js';
import { phoneRequireWorkspaceManager, phoneRequireIdentity } from './access.js';


  /**
   * Creates a Workspace owned by the viewer together with its public
   * `#general` Room (`ensureFirstRoom`), so the creator lands in a live Room.
   * A retry with the same client-chosen `workspaceId` by its owner is a no-op
   * that returns the same Room.
   */
  export async function phoneCreateWorkspace(ctx: PhoneContext, input: Input<'createWorkspace'>, viewerId: string) {
    const { id, roomId } = await ctx.database.transaction(db =>
      createWorkspace(db, input, viewerId, ctx.freeAgents));
    void ctx.starterOnboarding?.prepare(roomId).catch(error => console.error('[onboarding] prepare failed', error));
    return { id, roomId };
  }

  export async function phoneUpdateWorkspace(ctx: PhoneContext, input: Input<'updateWorkspace'>, viewerId: string) {
    if (input.allowFixSweep !== undefined && typeof input.allowFixSweep !== 'boolean')
      throw new Error('allowFixSweep must be a boolean');
    await ctx.database.transaction(async (database) => {
      await phoneRequireWorkspaceManager(ctx, input.workspaceId, viewerId, database);
      const current = (
        await database.query<{ visibility: 'public' | 'invite-only' }>(
          'SELECT visibility FROM workspaces WHERE id=$1 FOR UPDATE',
          [input.workspaceId],
        )
      ).rows[0];
      const avatar =
        input.avatar === undefined
          ? null
          : await storeWorkspaceAvatar(
              database,
              input.workspaceId,
              viewerId,
              input.avatar,
              ctx.publicOrigin,
              ctx.objects
                ? (id, ownerId) => ctx.objects!.readOwnedBytes(ownerId, id, database)
                : undefined,
            );
      await database.query(
        `UPDATE workspaces SET name=COALESCE($2,name),avatar=COALESCE($3,avatar),visibility=COALESCE($4,visibility),allow_fix_sweep=COALESCE($5,allow_fix_sweep),updated_at=now() WHERE id=$1`,
        [input.workspaceId, input.name ?? null, avatar, input.visibility ?? null, input.allowFixSweep ?? null],
      );
    });
  }

  export async function phoneLeaveWorkspace(ctx: PhoneContext, input: Input<'leaveWorkspace'>, viewerId: string) {
    const leaver = await phoneRequireIdentity(ctx, viewerId);
    await ctx.database.transaction(async (database) => {
      await database.query(`SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE`, [input.workspaceId]);
      const current = (
        await database.query<{ role: 'owner' | 'admin' | 'member' | 'spectator' }>(
          `SELECT role FROM memberships
           WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL FOR UPDATE`,
          [input.workspaceId, viewerId],
        )
      ).rows[0];
      if (!current) return;
      if (current.role === 'owner') {
        const otherOwner = await database.query(
          `SELECT 1 FROM memberships
           WHERE workspace_id=$1 AND room_id IS NULL AND identity_id<>$2 AND role='owner' AND removed_at IS NULL`,
          [input.workspaceId, viewerId],
        );
        if (!otherOwner.rowCount) throw new Error('workspace manager cannot leave as sole owner');
      }
      await removeWorkspaceMemberships(database, [input.workspaceId, viewerId]);
      await database.query(
        `DELETE FROM agent_pairing_codes WHERE workspace_id=$1 AND created_by=$2 AND claimed_by IS NULL`,
        [input.workspaceId, viewerId],
      );
      // The committed state is the silent audit record.
    });
  }

  /**
   * Deletes the workspace and everything in it — a real `DELETE FROM
   * workspaces`, not a flag. Owner-only. Idempotent: a retried or doubled
   * call on an already-deleted workspace resolves without effect.
   *
   * `rooms`/`memberships`/`agent_schedules`/`invites`/`agent_pairing_codes`/
   * `avatars`/`agent_grants` all carry `workspace_id ON DELETE CASCADE`, and
   * everything scoped by `room_id` (messages, corner_facts, agent_turns,
   * live_outputs, agent_commands, ...) chains through `rooms.workspace_id`'s
   * own cascade — so the single DELETE below empties the whole graph. Media
   * bytes are left for their existing TTL sweep (media-ttl.ts), same as
   * `deleteRoom`.
   *
   * Before the workspace disappears: an audit row survives it
   * (`workspace_deletions`, no FK back to the workspace), a notice row is
   * queued for every other human member so their next `readWorkspaces` can
   * tell them, and any agent whose only membership was here has its daemon
   * tokens revoked so its next daemon call is refused `agent_removed` — the
   * same terminal signal `removeAgent` uses, which the helper already
   * retires itself on (`retireRemovedAgent`/`isAgentRemovedError`).
   *
   * The idempotency floor (does the workspace still exist) runs BEFORE the
   * owner check, not after: a retried call must resolve quietly once the
   * workspace is gone even though the retrying identity's own `owner`
   * membership row went with it.
   */
  export async function phoneDeleteWorkspace(ctx: PhoneContext, input: Input<'deleteWorkspace'>, viewerId: string) {
    await ctx.database.transaction(async (database) => {
      const workspace = await database.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [
        input.workspaceId,
      ]);
      if (!workspace.rowCount) return;
      const owner = await database.query(
        `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
           AND identity_id=$2 AND role='owner' AND removed_at IS NULL`,
        [input.workspaceId, viewerId],
      );
      if (!owner.rowCount) throw new Error('workspace owner access denied');
      const retiring = await database.query<{ identity_id: string }>(
        `SELECT m.identity_id FROM memberships m JOIN identities i ON i.id=m.identity_id
         WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL AND i.kind='agent'
           AND NOT EXISTS(SELECT 1 FROM memberships other WHERE other.identity_id=m.identity_id
             AND other.removed_at IS NULL AND other.workspace_id<>$1)
         ORDER BY m.identity_id`,
        [input.workspaceId],
      );
      for (const agent of retiring.rows) await revokeDaemonCredentials(database, agent.identity_id);
      const outcome = await database.query<{ existed: boolean; deleted: boolean }>(
        `WITH existing AS MATERIALIZED (
         SELECT id,name FROM workspaces WHERE id=$1 FOR UPDATE
       ), members AS MATERIALIZED (
         SELECT m.identity_id,i.kind FROM memberships m JOIN identities i ON i.id=m.identity_id
         WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL
       ), deleted AS (
         DELETE FROM workspaces workspace USING existing
         WHERE workspace.id=existing.id AND EXISTS (
           SELECT 1 FROM memberships owner WHERE owner.workspace_id=existing.id
             AND owner.room_id IS NULL AND owner.identity_id=$2
             AND owner.removed_at IS NULL AND owner.role='owner'
         ) RETURNING workspace.id,workspace.name
       ), notices AS (
         INSERT INTO workspace_deletion_notices(identity_id,workspace_id)
         SELECT members.identity_id,deleted.id FROM deleted JOIN members ON true
         WHERE members.identity_id<>$2 AND members.kind='human' RETURNING identity_id
       ), audit AS (
         INSERT INTO workspace_deletions(workspace_id,workspace_name,deleted_by)
         SELECT id,name,$2 FROM deleted ON CONFLICT (workspace_id) DO NOTHING
         RETURNING workspace_id
       )
       SELECT EXISTS(SELECT 1 FROM existing) existed,EXISTS(SELECT 1 FROM deleted) deleted,
         (SELECT count(*) FROM notices) notice_count,
         (SELECT count(*) FROM audit) audit_count`,
        [input.workspaceId, viewerId],
      );
      if (outcome.rows[0]?.existed && !outcome.rows[0].deleted)
        throw new Error('workspace owner access denied');
    });
  }
