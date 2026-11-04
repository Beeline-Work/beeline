import { randomUUID } from 'node:crypto';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import type { FreeAgentService } from './free-agents.js';
import { createWorkspaceOwnerMembership } from './membership-join.js';
import { ensureFirstRoom } from './first-room.js';
import { seedWelcomeVideoWorkflow } from './welcome-video-workflow.js';

/** Shared first-run creation. The caller owns the transaction, including any consent grant. */
export async function createWorkspace(
  db: SqlDatabase, input: PhoneOperationMap['createWorkspace']['input'], viewerId: string,
  freeAgents?: Pick<FreeAgentService, 'createInWorkspace'>,
): Promise<{ id: string; roomId: string }> {
  if (input.timeZone !== undefined) {
    if (typeof input.timeZone !== 'string' || input.timeZone.length > 100) throw new Error('Invalid time zone');
    try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }); } catch { throw new Error('Invalid time zone'); }
  }
  const id = input.workspaceId ?? randomUUID();
  const inserted = await db.query(
    `INSERT INTO workspaces(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [id, input.name],
  );
  if (!inserted.rowCount) {
    const owned = await db.query(
      `SELECT 1 FROM workspaces w JOIN memberships m ON m.workspace_id=w.id AND m.room_id IS NULL
       WHERE w.id=$1 AND m.identity_id=$2 AND m.role='owner' AND m.removed_at IS NULL`,
      [id, viewerId],
    );
    if (!owned.rowCount) throw new Error('workspaceId is invalid');
  } else {
    await createWorkspaceOwnerMembership(db, [id, viewerId]);
  }
  const generalId = await ensureFirstRoom(db, id, viewerId);
  await seedWelcomeVideoWorkflow(db, id, generalId);
  // Only a newly created Workspace gets a free starter agent, in the same
  // transaction as its #general, so the creator lands next to it.
  if (inserted.rowCount && freeAgents)
    await freeAgents.createInWorkspace(db, {
      workspaceId: id,
      creatorId: viewerId,
      roomId: generalId,
      team: true,
      timeZone: input.timeZone,
    });
  return { id, roomId: generalId };
}

/** The app asks for a name; automatic onboarding uses the person's first name. */
export function defaultWorkspaceName(identityName: string | null): string {
  const firstName = identityName?.trim().split(/\s+/)[0];
  return firstName ? `${firstName}'s team` : 'Your team';
}
