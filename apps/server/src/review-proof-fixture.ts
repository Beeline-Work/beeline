import type { SqlDatabase } from './database.js';
import { ensureFirstRoom } from './first-room.js';
import { joinRooms } from './membership-join.js';

/**
 * The release proof's corner fixture.
 *
 * The emulator release proof signs in as the fixed Play review identity
 * (`exchangeReviewIdentity`) and its corner-opens flow needs ONE room on that
 * identity's deck carrying a live corner. It used to borrow whatever corner
 * happened to be open in the production welcome Workspace — which archived
 * with its work like any corner does, and every v0.0.109 proof failed with
 * "no repo-bound room on the deck". A proof cannot depend on live production
 * state, so the review sign-in now seeds its own: an invite-only Room the
 * reviewer is the only member of, holding one never-started scratch corner.
 *
 * Invisible to everyone else (invite-only, so no public-Room projection ever
 * joins another member), invisible to every daemon (the corner has no agent
 * members, so no helper lists or works it), and idempotent: fixed ids and
 * ON CONFLICT DO NOTHING make re-running the sign-in a no-op.
 */

/** Reserved fixed ids; the `bee11e00-…` range is Beeline's own. */
export const REVIEW_WORKSPACE_ID = 'bee11e00-0000-4000-8000-000000000105';
export const REVIEW_WORKSPACE_NAME = 'Beeline Review';
export const REVIEW_PROOF_ROOM_ID = 'bee11e00-0000-4000-8000-000000000103';
export const REVIEW_PROOF_ROOM_NAME = 'proof';
export const REVIEW_PROOF_CORNER_ID = 'bee11e00-0000-4000-8000-000000000104';
export const REVIEW_PROOF_CORNER_NAME = 'release proof';
export const REVIEW_PROOF_OBJECTIVE =
  'Hold the corner surface open so the release proof can open it.';

/**
 * The reviewer's own Workspace: it owns it, it has the `#general` every new
 * Workspace gets, and it holds the proof fixture. Idempotent, and a
 * membership the reviewer ended is never resurrected.
 */
export async function ensureReviewWorkspace(
  database: SqlDatabase,
  reviewerId: string,
): Promise<void> {
  await database.query(
    `INSERT INTO workspaces(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`,
    [REVIEW_WORKSPACE_ID, REVIEW_WORKSPACE_NAME],
  );
  const joined = await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     VALUES($1,NULL,$2,'owner')
     ON CONFLICT (workspace_id,identity_id) WHERE room_id IS NULL DO NOTHING`,
    [REVIEW_WORKSPACE_ID, reviewerId],
  );
  // A reviewer restored after account deletion rejoins the Rooms still there.
  if (joined.rowCount)
    await joinRooms(database, {
      workspaceId: REVIEW_WORKSPACE_ID,
      identityId: reviewerId,
      rooms: { type: 'all-live-top-level' },
      workspaceJoined: true,
    });
  await ensureFirstRoom(database, REVIEW_WORKSPACE_ID, reviewerId);
  await ensureReviewProofFixture(database, reviewerId, REVIEW_WORKSPACE_ID);
}

export async function ensureReviewProofFixture(
  database: SqlDatabase,
  reviewerId: string,
  workspaceId: string,
): Promise<void> {
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,visibility,repository_resolution)
     VALUES($1,$2,$3,$4,'invite-only','none')
     ON CONFLICT(id) DO NOTHING`,
    [REVIEW_PROOF_ROOM_ID, workspaceId, reviewerId, REVIEW_PROOF_ROOM_NAME],
  );
  // A fixture seeded before the review Workspace existed still lives in its
  // original Workspace; memberships follow the Room's own workspace_id.
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     SELECT workspace_id,id,$2,'member' FROM rooms WHERE id=$1
     ON CONFLICT (room_id,identity_id) WHERE room_id IS NOT NULL DO NOTHING`,
    [REVIEW_PROOF_ROOM_ID, reviewerId],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name,about,visibility,repository_resolution)
     SELECT $1,workspace_id,id,$3,$4,$5,'invite-only','none' FROM rooms WHERE id=$2
     ON CONFLICT(id) DO NOTHING`,
    [
      REVIEW_PROOF_CORNER_ID,
      REVIEW_PROOF_ROOM_ID,
      reviewerId,
      REVIEW_PROOF_CORNER_NAME,
      REVIEW_PROOF_OBJECTIVE,
    ],
  );
  await database.query(
    // No commissioner: a server-seeded fixture is nobody's commission, and an
    // identity FK here would block deleteAccount's identity row removal.
    `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by,objective)
     VALUES($1,NULL,NULL,$2)
     ON CONFLICT(corner_id) DO NOTHING`,
    [REVIEW_PROOF_CORNER_ID, REVIEW_PROOF_OBJECTIVE],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     SELECT workspace_id,id,$2,'member' FROM rooms WHERE id=$1
     ON CONFLICT (room_id,identity_id) WHERE room_id IS NOT NULL DO NOTHING`,
    [REVIEW_PROOF_CORNER_ID, reviewerId],
  );
}
