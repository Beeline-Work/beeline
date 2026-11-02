import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimAgentCommand, createAgentCommand } from './agent-command.js';
import { readArchitectureApproval } from './architecture-approvals.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { OPERATOR_OWNER_ID as OWNER } from './operator-system-dm.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';

const AGENT = 'c'.repeat(64), OTHER = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const REPOSITORY = 'Beeline-Work/beeline';
let db: PgliteDatabase, daemon: DaemonService;
let seq = 0;

beforeEach(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Operator','lunchboxfortwo'),($2,'agent','Worker','worker'),($3,'human','Other','other')`, [OWNER, AGENT, OTHER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Test')`, [WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Test')`, [ROOM, WORKSPACE, OWNER]);
  for (const id of [OWNER, AGENT, OTHER]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [WORKSPACE, id, ROOM]);
  daemon = new DaemonService(db, new LiveHub());
});
afterEach(async () => { await db.close(); });

async function message(author: string, text: string, replyTo?: string) {
  const id = (++seq).toString(16).padStart(64, '0');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id) VALUES($1,$2,$3,$4,$5)`,
    [id, ROOM, author, text, replyTo ?? null]);
  return id;
}
async function turn(sourceMessageId: string) {
  const requestId = `request-${seq}`, generationId = `generation-${seq}`;
  const command = await createAgentCommand(db, { roomId: ROOM, agentId: AGENT, sourceMessageId, reason: 'human_tag', turnRequestId: requestId });
  await claimAgentCommand(db, ROOM, AGENT, command!.id, generationId);
  return { agentId: AGENT, roomId: ROOM, requestId, generationId };
}
const approve = async (source: string, headSha = HEAD) => daemon.execute('approveArchitectureRelax',
  { ...await turn(source), repository: REPOSITORY, pullRequest: 3264, headSha }, AGENT);
const read = (head = HEAD, pullRequest = '3264') => readArchitectureApproval(db,
  new URLSearchParams({ repository: REPOSITORY, pullRequest, head }));

describe('architecture relax approvals', () => {
  it('records the owner\'s yes to an ask naming the PR and head, for that exact head only', async () => {
    const ask = await message(AGENT, `Relax corner.state-writes? https://github.com/${REPOSITORY}/pull/3264 head ${HEAD.slice(0, 7)}`);
    expect(await read()).toEqual({ approved: false });
    await approve(await message(OWNER, '@worker yes', ask));
    expect(await read()).toEqual({ approved: true });
    expect(await read('f'.repeat(40))).toEqual({ approved: false });
    expect(await read(HEAD, '3265')).toEqual({ approved: false });
    expect(await read('not-a-sha')).toEqual({ approved: false });
  });

  it('refuses another person\'s command, a message naming no head, and a different head', async () => {
    await expect(approve(await message(OTHER, `yes to #3264 at ${HEAD}`))).rejects.toThrow(/owner's own message/);
    await expect(approve(await message(OWNER, 'yes to #3264'))).rejects.toThrow(/must name PR #3264/);
    await expect(approve(await message(OWNER, `yes to #32640 at ${HEAD}`))).rejects.toThrow(/must name PR #3264/);
    await expect(approve(await message(OWNER, `yes to #3264 at ${HEAD}`), 'f'.repeat(40))).rejects.toThrow(/must name PR #3264/);
    expect(await read()).toEqual({ approved: false });
  });
});
