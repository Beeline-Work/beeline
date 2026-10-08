import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import { claimAgentCommand, createAgentCommand } from './agent-command.js';
import { TokenAuth } from './auth.js';
import { DaemonService } from './daemon-service.js';
import { migrate } from './database.js';
import { GitHubOperations } from './github-operations.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { wakeLateCornerWatcher } from './system-line.js';
import { PgliteDatabase } from './test-support.js';

// Reproduction 2026-10-08: save_memory on a turn woken by a child corner's
// report answered "503: institutional memory requester authority is
// unavailable". Writes took the requester from the turn's root message author
// and required a person, so every corner-event, merge-watch, and agent-message
// wake refused, and the server's catch-all turned the refusal into a 503.

const WORKSPACE = '10000000-0000-4000-8000-0000000c0e11';
const ROOM = '20000000-0000-4000-8000-0000000c0e11';
const CORNER = '30000000-0000-4000-8000-0000000c0e11';
const WATCHED = '40000000-0000-4000-8000-0000000c0e11';
const UNLINKED = '50000000-0000-4000-8000-0000000c0e11';
const CAPTAIN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const REPORTER = 'c'.repeat(64);
const ROOM_REQUEST = '1'.repeat(64);
const CORNER_ASK = '2'.repeat(64);
const CHILD_REPORT = '3'.repeat(64);
const MERGED_LINE = '4'.repeat(64);
const ROOM_CHATTER = '5'.repeat(64);
const UNLINKED_REPORT = '6'.repeat(64);

describe('save_memory requester authority on corner wakes', () => {
  let database: PgliteDatabase;
  let server: ReturnType<typeof createBeelineServer>;
  let origin: string;
  let agentToken: string;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await new AuthStore(database as unknown as TransactionalDatabase).migrate();
    await database.query(
      `INSERT INTO identities(id,kind,name,handle,github_subject) VALUES
         ($1,'human','Captain','captain','captain'),($2,'agent','Ruby','ruby',NULL),
         ($3,'agent','Reporter','reporter',NULL),($4,'human','@system',NULL,NULL)`,
      [CAPTAIN, AGENT, REPORTER, SYSTEM_IDENTITY_ID],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2),($3,$2)`, [
      AGENT,
      CAPTAIN,
      REPORTER,
    ]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES
         ($1,$4,$5,'notification-tap-hang-audit'),($2,$4,$5,'transcript-scrubber-store'),
         ($3,$4,$5,'unlinked')`,
      [CORNER, WATCHED, UNLINKED, WORKSPACE, ROOM],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       SELECT $1,room_id,identity_id,'member'
       FROM unnest($2::uuid[]) room_id CROSS JOIN unnest($3::text[]) identity_id`,
      [WORKSPACE, [ROOM, CORNER, WATCHED, UNLINKED], [CAPTAIN, AGENT, REPORTER]],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member')`,
      [WORKSPACE, CAPTAIN, AGENT, REPORTER],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES
         ($1,$2,$3,'@ruby audit the notification tap stack'),
         ($4,$5,$3,'@ruby does the notification tap still hang?'),
         ($6,$5,$7,'Step 3 found the same notification tap hang.'),
         ($8,$2,$7,'Watching the transcript-scrubber-store merge.'),
         ($9,$10,$7,'Unlinked corner report.')`,
      [
        ROOM_REQUEST,
        ROOM,
        CAPTAIN,
        CORNER_ASK,
        CORNER,
        CHILD_REPORT,
        REPORTER,
        ROOM_CHATTER,
        UNLINKED_REPORT,
        UNLINKED,
      ],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,system_event)
       VALUES($1,$2,$3,'merged transcript-scrubber-store','system','{"kind":"merged"}'::jsonb)`,
      [MERGED_LINE, WATCHED, SYSTEM_IDENTITY_ID],
    );
    // CORNER keeps its commissioned requester. WATCHED was opened by an
    // agent turn, so its requester link is missing and only its brief
    // approval names the person. UNLINKED has neither.
    await database.query(
      `INSERT INTO corner_facts(corner_id,commissioned_by,objective,kind,lifecycle)
       VALUES($1,$2,'Audit taps','agent','{"lifecycle":"working","checks":"unknown"}'),
             ($3,NULL,'Store step','agent','{"lifecycle":"merged","checks":"passing"}'),
             ($4,NULL,'Unlinked','agent','{"lifecycle":"working","checks":"unknown"}')`,
      [CORNER, CAPTAIN, WATCHED, UNLINKED],
    );
    await database.query(
      `INSERT INTO corner_brief_revisions(corner_id,revision,spec,author_id,source_room_id,
         source_message_id,approval_basis)
       VALUES($1,1,'Move the scrubber onto the store.',$2,$3,$4,$5::jsonb)`,
      [
        WATCHED,
        AGENT,
        ROOM,
        ROOM_REQUEST,
        JSON.stringify({
          kind: 'explicit-human-answer',
          sourceMessageId: ROOM_REQUEST,
          snapshot: '@ruby audit the notification tap stack',
          approvedBy: CAPTAIN,
          briefHash: 'hash',
        }),
      ],
    );
    await database.query(
      `UPDATE institutional_memory_workspace_rollouts SET stage='live' WHERE workspace_id=$1`,
      [WORKSPACE],
    );
    const auth = new TokenAuth(database, async (proof) => ({
      subject: proof,
      login: proof,
      name: proof,
    }));
    const live = new LiveHub();
    const phone = new PhoneService(
      database,
      'http://placeholder',
      new GitHubOperations(
        database,
        {} as unknown as GitHubOAuthClient,
        {} as unknown as GitHubAppClient,
        'github-client-secret',
      ),
    );
    const daemon = new DaemonService(
      database,
      live,
      undefined,
      undefined,
      false,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { enabled: true, live: true },
    );
    server = createBeelineServer({ database, auth, phone, daemon, live });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    agentToken = (await auth.exchangeDaemonToken(
      (await auth.createDaemonExchange(AGENT)).exchangeToken,
    ))!.daemonToken;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (database) await database.close();
  });

  type Turn = { roomId: string; requestId: string; generationId: string };

  async function wake(roomId: string, sourceMessageId: string, reason: string): Promise<Turn> {
    const command = await createAgentCommand(database, {
      roomId,
      agentId: AGENT,
      sourceMessageId,
      reason,
    });
    return claim(roomId, command!.id, command!.turn_request_id);
  }

  async function claim(roomId: string, commandId: string, requestId: string): Promise<Turn> {
    const generationId = `generation-${commandId.slice(0, 8)}`;
    await claimAgentCommand(database, roomId, AGENT, commandId, generationId);
    return { roomId, requestId, generationId };
  }

  async function operation(name: string, turn: Turn, payload: object = {}) {
    const response = await fetch(`${origin}/v1/daemon/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, ...turn, agentId: AGENT }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const fact = (key: string, body: string, sourceMessageIds: string[]) => ({
    memoryKind: 'workspace_fact',
    canonicalKey: key,
    body,
    keywords: ['notification', 'tap', key.split('.')[1]!],
    sourceMessageIds,
    personAsked: false,
    confidence: 0.9,
  });

  async function savedFacts() {
    return (
      await database.query<{ canonical_key: string; source_room_id: string }>(
        `SELECT canonical_key,source_room_id FROM institutional_memory_items ORDER BY canonical_key`,
      )
    ).rows;
  }

  it('saves and loads on a human-triggered corner turn', async () => {
    const turn = await wake(CORNER, CORNER_ASK, 'human_tag');
    const saved = await operation(
      'saveInstitutionalMemory',
      turn,
      fact('taps.human', 'A notification tap on an open Room can hang the page.', [CORNER_ASK]),
    );
    expect(saved.status).toBe(200);
    const context = await operation('getInstitutionalContext', turn);
    expect(context.status).toBe(200);
    expect(context.body.text).toContain('can hang the page');
  });

  it('saves a workspace fact on a child-corner-report turn for the corner requester', async () => {
    const turn = await wake(CORNER, CHILD_REPORT, 'message');
    const saved = await operation(
      'saveInstitutionalMemory',
      turn,
      fact('taps.child', 'A tap after the Room already opened in the session hangs too.', [
        CHILD_REPORT,
      ]),
    );
    expect(saved).toMatchObject({ status: 200, body: { version: 1 } });
    expect(await savedFacts()).toEqual([{ canonical_key: 'taps.child', source_room_id: CORNER }]);
    const context = await operation('getInstitutionalContext', turn);
    expect(context.status).toBe(200);
    expect(context.body.text).toContain('already opened in the session');
    // The requester did not start this turn, so their private profile stays shut.
    const profile = await operation('saveInstitutionalMemory', turn, {
      ...fact('taps.profile', 'Captain prefers web proof.', [CHILD_REPORT]),
      memoryKind: 'human_profile_fact',
    });
    expect(profile.status).toBe(403);
    expect(profile.body.error).toMatch(/profile facts need a turn the requester started/);
  });

  it('saves a workspace fact on a merge-watch wake whose corner lost its requester link', async () => {
    expect(await wakeLateCornerWatcher(database, ROOM, AGENT, WATCHED)).toBe(true);
    const command = (
      await database.query<{ id: string; turn_request_id: string }>(
        `SELECT id,turn_request_id FROM agent_commands WHERE room_id=$1 AND source_message_id=$2`,
        [ROOM, MERGED_LINE],
      )
    ).rows[0]!;
    const turn = await claim(ROOM, command.id, command.turn_request_id);
    const saved = await operation(
      'saveInstitutionalMemory',
      turn,
      fact('taps.merge', 'The transcript scrubber now reads from the Room message store.', [
        ROOM_CHATTER,
      ]),
    );
    expect(saved.status).toBe(200);
    expect(await savedFacts()).toEqual([{ canonical_key: 'taps.merge', source_room_id: ROOM }]);
    const context = await operation('getInstitutionalContext', turn);
    expect(context.status).toBe(200);
  });

  it('refuses with a 403 that names the missing link when no requester resolves', async () => {
    const turn = await wake(UNLINKED, UNLINKED_REPORT, 'message');
    const saved = await operation(
      'saveInstitutionalMemory',
      turn,
      fact('taps.none', 'Nobody asked for this fact.', [UNLINKED_REPORT]),
    );
    expect(saved.status).toBe(403);
    expect(saved.body.error).toBe(
      `institutional memory requester authority is unavailable: this turn's root message ${UNLINKED_REPORT} in Room ${UNLINKED} is not from a person, and Room ${UNLINKED} is not a corner with a recorded requester`,
    );
    expect(await savedFacts()).toEqual([]);
  });

  it('answers a body that is not one sentence with a 400, not a 503', async () => {
    const turn = await wake(CORNER, CORNER_ASK, 'human_tag');
    const saved = await operation(
      'saveInstitutionalMemory',
      turn,
      fact('taps.semicolon', 'The tap hangs; the store fixes it.', [CORNER_ASK]),
    );
    expect(saved).toEqual({
      status: 400,
      body: { error: 'institutional memory body must be one sentence' },
    });
  });
});
