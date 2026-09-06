import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_ID,
  WELCOME_ROOM_ABOUT,
  WELCOME_ROOM_ID,
} from '@beeline/api-contract/phone';
import { migrate } from './database.js';
import { seedDefaultWorkspace } from './default-workspace.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth } from './auth.js';
import { PhoneService } from './phone-service.js';

const CAPTAIN = 'a'.repeat(64);
const CREW = 'b'.repeat(64);
const LEAVER = 'c'.repeat(64);
const AGENT = 'd'.repeat(64);

describe('default Workspace seed', () => {
  let db: PgliteDatabase;
  beforeEach(async () => {
    db = new PgliteDatabase();
    await migrate(db);
  });
  afterEach(() => db.close());

  it('seeds Beeline Welcome and #welcome once, keeping a later about edit', async () => {
    const rooms = () =>
      db.query<{ id: string; name: string; about: string; created_by: string | null }>(
        `SELECT id,name,about,created_by FROM rooms WHERE workspace_id=$1`,
        [DEFAULT_WORKSPACE_ID],
      );
    expect((await rooms()).rows).toEqual([
      { id: WELCOME_ROOM_ID, name: 'welcome', about: WELCOME_ROOM_ABOUT, created_by: null },
    ]);
    await db.query(`UPDATE rooms SET about='Ask anything.' WHERE id=$1`, [WELCOME_ROOM_ID]);
    await migrate(db);
    await seedDefaultWorkspace(db);
    expect((await rooms()).rows).toEqual([
      { id: WELCOME_ROOM_ID, name: 'welcome', about: 'Ask anything.', created_by: null },
    ]);
    expect((await db.query(`SELECT 1 FROM workspaces`)).rowCount).toBe(1);
  });

  it('backfills every human silently, respects a leave, and never adds an agent', async () => {
    await db.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Captain'),($2,'human','Crew'),($3,'human','Leaver'),($4,'agent','Bee')`,
      [CAPTAIN, CREW, LEAVER, AGENT],
    );
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`,
      [DEFAULT_WORKSPACE_ID, CAPTAIN],
    );
    await seedDefaultWorkspace(db);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
      WELCOME_ROOM_ID,
      LEAVER,
    ]);
    await seedDefaultWorkspace(db);

    const members = await db.query<{ identity_id: string; role: string; removed: boolean }>(
      `SELECT identity_id,role,removed_at IS NOT NULL removed FROM memberships
       WHERE room_id=$1 ORDER BY identity_id`,
      [WELCOME_ROOM_ID],
    );
    expect(members.rows).toEqual([
      { identity_id: CAPTAIN, role: 'owner', removed: false },
      { identity_id: CREW, role: 'member', removed: false },
      { identity_id: LEAVER, role: 'member', removed: true },
    ]);
    const workspaceMembers = await db.query<{ identity_id: string; role: string }>(
      `SELECT identity_id,role FROM memberships
       WHERE workspace_id=$1 AND room_id IS NULL AND removed_at IS NULL ORDER BY identity_id`,
      [DEFAULT_WORKSPACE_ID],
    );
    expect(workspaceMembers.rows).toEqual([
      { identity_id: CAPTAIN, role: 'owner' },
      { identity_id: CREW, role: 'member' },
      { identity_id: LEAVER, role: 'member' },
    ]);
    expect(
      (await db.query(`SELECT created_by FROM rooms WHERE id=$1`, [WELCOME_ROOM_ID])).rows,
    ).toEqual([{ created_by: CAPTAIN }]);
    expect((await db.query(`SELECT 1 FROM messages`)).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM workspace_join_notifications`)).rowCount).toBe(0);
  });

  it('never backfills a hidden_from_roster identity into the Workspace or #welcome', async () => {
    const HIDDEN = 'e'.repeat(64);
    await db.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Captain')`,
      [CAPTAIN],
    );
    await db.query(
      `INSERT INTO identities(id,kind,name,hidden_from_roster) VALUES($1,'human','System',true)`,
      [HIDDEN],
    );
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`,
      [DEFAULT_WORKSPACE_ID, CAPTAIN],
    );
    await seedDefaultWorkspace(db);
    const workspaceMembership = await db.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,
      [DEFAULT_WORKSPACE_ID, HIDDEN],
    );
    const roomMembership = await db.query(
      `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2`,
      [WELCOME_ROOM_ID, HIDDEN],
    );
    expect(workspaceMembership.rowCount).toBe(0);
    expect(roomMembership.rowCount).toBe(0);
  });

  it('joins a new sign-in to the Workspace and #welcome with the ordinary joined line', async () => {
    const auth = new TokenAuth(db, async () => ({ subject: 'new', login: 'newbie', name: 'New' }));
    const tokens = await auth.exchangeGitHubOidc('proof');
    const memberships = await db.query<{ room_id: string | null; role: string }>(
      `SELECT room_id,role FROM memberships WHERE identity_id=$1 AND removed_at IS NULL
       ORDER BY room_id NULLS FIRST`,
      [tokens.identityId],
    );
    expect(memberships.rows).toEqual([
      { room_id: null, role: 'member' },
      { room_id: WELCOME_ROOM_ID, role: 'member' },
    ]);
    const lines = await db.query<{ text: string; presentation: string }>(
      `SELECT text,presentation FROM messages WHERE room_id=$1`,
      [WELCOME_ROOM_ID],
    );
    expect(lines.rows).toEqual([{ text: 'newbie joined', presentation: 'system' }]);
  });

  it('lets a person leave #welcome like any Room, and the deck lists Beeline Welcome', async () => {
    const auth = new TokenAuth(db, async () => ({ subject: 'crew', login: 'crew', name: 'Crew' }));
    const tokens = await auth.exchangeGitHubOidc('proof');
    const phone = new PhoneService(db, 'http://placeholder');
    await phone.execute('leaveRoom', { roomId: WELCOME_ROOM_ID }, tokens.identityId);
    expect(
      (
        await db.query(
          `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
          [WELCOME_ROOM_ID, tokens.identityId],
        )
      ).rowCount,
    ).toBe(0);
    await seedDefaultWorkspace(db);
    expect((await phone.readChats(DEFAULT_WORKSPACE_ID, tokens.identityId))?.chats).toEqual([]);
    expect(
      (await phone.readWorkspaces(tokens.identityId)).workspaces.map((workspace) => workspace.name),
    ).toEqual(['Beeline Welcome']);
  });
});
