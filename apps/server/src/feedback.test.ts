import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { claimAgentCommand, createAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { migrate } from './database.js';
import {
  assertFeedbackRedaction,
  FeedbackRedactionError,
  feedbackConfigFromEnv,
  processFeedbackIssueEvent,
  type FeedbackConfig,
  type FeedbackIssueHost,
} from './feedback.js';
import { GitHubOperations } from './github-operations.js';
import { LiveHub } from './live.js';
import { hasSystemReportMention, taggedIdentityIdsSql } from './message-mentions.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase } from './test-support.js';

const PERSON = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const TRIAGE = 'd'.repeat(64);
const OUTSIDER = 'e'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';
const TRIAGE_CORNER = '44444444-4444-4444-8444-444444444444';
const REPOSITORY = 'Beeline-Work/beeline';
const CONFIG: FeedbackConfig = { repository: REPOSITORY };

let database: PgliteDatabase;
let sequence = 0;

function hex(): string {
  sequence += 1;
  return sequence.toString(16).padStart(64, 'f');
}

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Priya Raman','priya'),($2,'human','Other Person','other'),
      ($3,'agent','Worker','worker'),($4,'agent','Sweeper','sweeper'),($5,'agent','Outsider','outsider')`,
    [PERSON, OTHER, AGENT, TRIAGE, OUTSIDER],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,github_events_enabled)
     VALUES($1,$2,$3,'Moonbase Launch',false)`,
    [ROOM, WORKSPACE, PERSON],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Fix it')`,
    [CORNER, WORKSPACE, ROOM, PERSON],
  );
  // The Issues triage corner: a no-code corner a Room admin turned Feedback
  // triage on for. CORNER is an ordinary corner with it off.
  await database.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Issues triage')`,
    [TRIAGE_CORNER, WORKSPACE, ROOM, PERSON],
  );
  await database.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,lane,feedback_triage) VALUES
      ($1,$3,'no_code',false),($2,$3,'no_code',true)`,
    [CORNER, TRIAGE_CORNER, TRIAGE],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id) VALUES($1,$2),($3,$2),($4,$2)`,
    [AGENT, PERSON, TRIAGE, OUTSIDER],
  );
  for (const id of [PERSON, OTHER, AGENT, TRIAGE, OUTSIDER])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
        ($1,NULL,$2,'member'),($1,$3,$2,'member'),($1,$4,$2,'member')`,
      [WORKSPACE, id, ROOM, CORNER],
    );
  for (const id of [PERSON, TRIAGE])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, TRIAGE_CORNER, id],
    );
});

afterEach(async () => {
  await database.close();
});

async function message(text: string, authorId = PERSON, roomId = ROOM): Promise<string> {
  const id = hex();
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,created_at)
     VALUES($1,$2,$3,$4,now()-interval '1 hour'+($5::int * interval '1 millisecond'))`,
    [id, roomId, authorId, text, sequence],
  );
  return id;
}

async function openTurn(sourceMessageId: string, roomId = ROOM, agentId = AGENT) {
  const requestId = `request-${hex().slice(-8)}`;
  const generationId = `${requestId}-generation`;
  const command = await createAgentCommand(database, {
    roomId,
    agentId,
    sourceMessageId,
    reason: 'human_tag',
    turnRequestId: requestId,
  });
  await claimAgentCommand(database, roomId, agentId, command!.id, generationId);
  return { roomId, requestId, generationId };
}

function daemon(host?: FeedbackIssueHost, config = CONFIG): DaemonService {
  return new DaemonService(
    database,
    new LiveHub(),
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    { enabled: false },
    undefined,
    undefined,
    undefined,
    { config, ...(host ? { host } : {}) },
  );
}

async function report(
  input: Record<string, unknown>,
  roomId = ROOM,
  agentId = AGENT,
): Promise<{ itemId: string; duplicate: boolean }> {
  const trigger = await message(`@worker please do the thing ${hex()}`, PERSON, roomId);
  const turn = await openTurn(trigger, roomId, agentId);
  return daemon().execute(
    'reportFeedback',
    { ...turn, category: 'bug', summary: 'x', ...input } as never,
    agentId,
  ) as Promise<{ itemId: string; duplicate: boolean }>;
}

/** One turn of the triage agent in the Issues triage corner. */
async function triageTurn(roomId = TRIAGE_CORNER, agentId = TRIAGE) {
  const handle = agentId === TRIAGE ? 'sweeper' : 'outsider';
  return openTurn(await message(`@${handle} sweep`, PERSON, roomId), roomId, agentId);
}

class FakeGitHub implements FeedbackIssueHost {
  issues = new Map<number, { title: string; body: string; labels: string[]; state: string }>();
  comments = new Map<number, { issue: number; body: string }>();
  fail?: string;
  next = 100;
  async createIssue(_repository: string, issue: { title: string; body: string; labels: readonly string[] }) {
    if (this.fail) throw new Error(this.fail);
    const number = this.next++;
    this.issues.set(number, { ...issue, labels: [...issue.labels], state: 'open' });
    return { number, url: `https://github.com/${REPOSITORY}/issues/${number}` };
  }
  async readIssue(_repository: string, number: number) {
    const issue = this.issues.get(number);
    if (!issue) throw new Error('GitHub issues failed: HTTP 404: Not Found');
    return {
      number,
      title: issue.title,
      url: `https://github.com/${REPOSITORY}/issues/${number}`,
      labels: issue.labels,
      state: issue.state,
      pullRequest: false,
    };
  }
  async listOpenIssues() {
    return [...this.issues.entries()].map(([number, issue]) => ({
      number,
      title: issue.title,
      url: `https://github.com/${REPOSITORY}/issues/${number}`,
      labels: issue.labels,
    }));
  }
  async createComment(_repository: string, issue: number, body: string) {
    if (this.fail) throw new Error(this.fail);
    const id = this.next++;
    this.comments.set(id, { issue, body });
    return { id };
  }
  async updateComment(_repository: string, commentId: number, body: string) {
    const comment = this.comments.get(commentId);
    if (!comment) return false;
    comment.body = body;
    return true;
  }
}

async function items() {
  return (
    await database.query<{
      id: string;
      status: string;
      issue_number: number | null;
      triage_reason: string | null;
      source_kind: string;
      room_id: string;
      trigger_message_id: string;
      request_id: string | null;
      prompt_section_ids: string[];
      message_ids: string[];
    }>(`SELECT * FROM feedback_items ORDER BY created_at,id`)
  ).rows;
}

describe('report_feedback (agent path)', () => {
  it('stores the item with room, trigger, request and prompt sections, in a Room and a corner', async () => {
    await message('earlier context');
    const inRoom = await report({
      category: 'tooling_gap',
      summary: 'No tool lists open corners by lane',
      tool_name: 'inspect_corner',
      promptSectionIds: ['core.identity', 'room.place'],
    });
    const inCorner = await report({ category: 'contradiction', summary: 'Rules disagree' }, CORNER);
    expect(inRoom).toMatchObject({ duplicate: false, itemId: expect.stringMatching(/^fb_/) });
    expect(inCorner.itemId).toMatch(/^fb_/);
    const stored = await items();
    expect(stored[0]).toMatchObject({
      source_kind: 'agent',
      room_id: ROOM,
      request_id: expect.stringMatching(/^request-/),
      prompt_section_ids: ['core.identity', 'room.place'],
    });
    expect(stored[0]!.message_ids[0]).toBe(stored[0]!.trigger_message_id);
    expect(stored[0]!.message_ids).toHaveLength(2);
    expect(stored[1]).toMatchObject({ room_id: CORNER });
  });

  it('answers a duplicate with the existing id and caps new items at ten per UTC day', async () => {
    const first = await report({ summary: 'The grant card never resolves.' });
    const again = await report({ summary: '  the GRANT card never resolves ' });
    expect(again).toEqual({ itemId: first.itemId, duplicate: true });
    for (let index = 1; index < 10; index++) await report({ summary: `distinct problem ${index}` });
    await expect(report({ summary: 'eleventh' })).rejects.toThrow('feedback cap reached');
    // A duplicate still answers at the cap.
    await expect(report({ summary: 'the grant card never resolves' })).resolves.toEqual({
      itemId: first.itemId,
      duplicate: true,
    });
  });

  it('rejects secret-shaped values and unknown categories', async () => {
    await expect(
      report({ summary: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123' }),
    ).rejects.toThrow('secret-shaped');
    await expect(report({ category: 'human_report' })).rejects.toThrow('category must be one of');
    expect(await items()).toEqual([]);
  });
});

describe('@system and Report issue (human path)', () => {
  it('files a report for a standalone @system, never for code or quoted lines', () => {
    expect(hasSystemReportMention('@system the send button froze')).toBe(true);
    expect(hasSystemReportMention('this froze @System')).toBe(true);
    expect(hasSystemReportMention('run `@system` here')).toBe(false);
    expect(hasSystemReportMention('```\n@system\n```')).toBe(false);
    expect(hasSystemReportMention('> @system said so')).toBe(false);
    expect(hasSystemReportMention('mail me@system.test')).toBe(false);
  });

  it('turns an @system message into one human_report without membership, wake, or push', async () => {
    const phone = new PhoneService(database, 'http://local.test');
    for (let index = 0; index < 22; index++) await message(`context ${index}`, OTHER);
    const sent = await phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: '@system the send button froze' },
      PERSON,
    );
    const [item] = await items();
    expect(item).toMatchObject({
      source_kind: 'human',
      trigger_message_id: sent.messageId,
      room_id: ROOM,
    });
    expect(item!.message_ids).toHaveLength(21);
    // Pushes go to the identities a message tags; @system tags nobody.
    const side = await database.query<{ members: number; commands: number; tagged: string[] }>(
      `SELECT (SELECT count(*)::int FROM memberships WHERE identity_id=$1 AND room_id=$2) members,
              (SELECT count(*)::int FROM agent_commands WHERE source_message_id=$3) commands,
              ${taggedIdentityIdsSql('m')} tagged
       FROM messages m WHERE m.id=$3`,
      [SYSTEM_IDENTITY_ID, ROOM, sent.messageId],
    );
    expect(side.rows[0]).toEqual({ members: 0, commands: 0, tagged: [] });
    const view = await phone.readRoom(ROOM, OTHER);
    expect(view?.messages.find((row) => row.id === sent.messageId)?.feedbackReported).toBe(true);
    await phone.execute('sendRoomMessage', { roomId: ROOM, text: 'see `@system`' }, PERSON);
    expect(await items()).toHaveLength(1);
  });

  it('does not wake the agent of a DM when the message only reports to @system', async () => {
    const phone = new PhoneService(database, 'http://local.test');
    const dm = await phone.execute(
      'resolveDirectMessage',
      { workspaceId: WORKSPACE, participantId: AGENT },
      PERSON,
    );
    const reported = await phone.execute(
      'sendRoomMessage',
      { roomId: dm.id, text: '@system your tools keep timing out' },
      PERSON,
    );
    const commands = await database.query(
      `SELECT 1 FROM agent_commands WHERE source_message_id=$1`,
      [reported.messageId],
    );
    expect(commands.rowCount).toBe(0);
    expect((await items())[0]).toMatchObject({ trigger_message_id: reported.messageId });
  });

  it('files Report issue once per message with an optional note, refusing secrets', async () => {
    const phone = new PhoneService(database, 'http://local.test');
    const target = await message('the agent posted a broken card', AGENT);
    const first = await phone.execute(
      'reportMessageIssue',
      { roomId: ROOM, messageId: target, note: 'Card never rendered' },
      OTHER,
    );
    expect(first).toMatchObject({ duplicate: false, itemId: expect.stringMatching(/^fb_/) });
    await expect(
      phone.execute('reportMessageIssue', { roomId: ROOM, messageId: target }, PERSON),
    ).resolves.toEqual({ itemId: first.itemId, duplicate: true });
    const other = await message('another');
    await expect(
      phone.execute(
        'reportMessageIssue',
        { roomId: ROOM, messageId: other, note: 'AKIAABCDEFGHIJKLMNOP' },
        OTHER,
      ),
    ).rejects.toThrow('secret-shaped');
    const view = await phone.readRoom(ROOM, PERSON);
    expect(view?.messages.find((row) => row.id === target)?.feedbackReported).toBe(true);
    expect(view?.messages.find((row) => row.id === other)?.feedbackReported).toBeUndefined();
  });
});

describe('triage tools', () => {
  const TRIAGE_OPERATIONS = [
    ['listFeedback', {}],
    ['getFeedback', { itemIds: ['fb_x'] }],
    ['listFeedbackIssues', {}],
    ['fileFeedbackIssue', { itemIds: ['fb_x'], title: 't', body: 'b', categoryLabel: 'bug' }],
    ['attachFeedbackToIssue', { itemIds: ['fb_x'], issueNumber: 1 }],
    ['dismissFeedback', { itemIds: ['fb_x'], reason: 'r' }],
  ] as const;

  it('refuses every triage operation outside a turn in a Feedback triage corner', async () => {
    const service = daemon(new FakeGitHub());
    // A turn in the top-level Room, a turn in a corner with the setting off,
    // and the same agent in its triage corner with no turn at all.
    const roomTurn = await triageTurn(ROOM);
    const plainCornerTurn = await triageTurn(CORNER);
    for (const [name, input] of TRIAGE_OPERATIONS) {
      for (const turn of [roomTurn, plainCornerTurn])
        await expect(
          service.execute(name, { ...turn, ...input } as never, TRIAGE),
        ).rejects.toThrow('feedback triage access denied');
      await expect(
        service.execute(name, { roomId: TRIAGE_CORNER, ...input } as never, TRIAGE),
      ).rejects.toThrow();
      await expect(service.execute(name, input as never, TRIAGE)).rejects.toThrow(
        'feedback triage access denied',
      );
    }
  });

  it('turns the setting on and off when a Room admin asks the corner agent, and for no one else', async () => {
    const service = daemon(new FakeGitHub());
    const setting = async (corner: string) =>
      (
        await database.query<{ feedback_triage: boolean }>(
          `SELECT feedback_triage FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0]!.feedback_triage;
    const turn = await triageTurn();
    await expect(service.execute('listFeedback', turn as never, TRIAGE)).resolves.toEqual({
      items: [],
    });
    // A member who is not a Room admin asks: refused, the setting stays on.
    await expect(
      service.execute('setCornerFeedbackTriage', { ...(await triageTurn()), enabled: false } as never, TRIAGE),
    ).rejects.toThrow('feedback triage change access denied');
    expect(await setting(TRIAGE_CORNER)).toBe(true);
    // Another agent's request is refused even when its owner is an admin.
    await database.query(
      `UPDATE memberships SET role='admin' WHERE identity_id=$1 AND room_id IS NULL`,
      [PERSON],
    );
    const agentAsked = await openTurn(
      await message('@sweeper turn triage off', AGENT, TRIAGE_CORNER),
      TRIAGE_CORNER,
      TRIAGE,
    );
    await expect(
      service.execute('setCornerFeedbackTriage', { ...agentAsked, enabled: false } as never, TRIAGE),
    ).rejects.toThrow('feedback triage change access denied');
    // The Room admin asks: off, and the next triage call is refused.
    await expect(
      service.execute('setCornerFeedbackTriage', { ...(await triageTurn()), enabled: false } as never, TRIAGE),
    ).resolves.toEqual({ cornerId: TRIAGE_CORNER, enabled: false });
    expect(await setting(TRIAGE_CORNER)).toBe(false);
    await expect(service.execute('listFeedback', turn as never, TRIAGE)).rejects.toThrow(
      'feedback triage access denied',
    );
    // On in an ordinary corner; never on a top-level Room or with no turn.
    await service.execute(
      'setCornerFeedbackTriage',
      { ...(await triageTurn(CORNER)), enabled: true } as never,
      TRIAGE,
    );
    expect(await setting(CORNER)).toBe(true);
    await expect(
      service.execute('setCornerFeedbackTriage', { ...(await triageTurn(ROOM)), enabled: true } as never, TRIAGE),
    ).rejects.toThrow('feedback triage change access denied');
    await expect(
      service.execute('setCornerFeedbackTriage', { roomId: CORNER, enabled: false } as never, TRIAGE),
    ).rejects.toThrow('command output authority rejected');
    expect(await setting(CORNER)).toBe(true);
  });

  it('lists new items with human reports first, then by cluster size', async () => {
    const lone = await report({ category: 'bug', summary: 'lone bug' });
    const clustered = await report({ category: 'context_gap', summary: 'memory lost the brief' });
    await report({ category: 'context_gap', summary: 'Memory lost the brief!' }, ROOM, OUTSIDER);
    const human = await new PhoneService(database, 'http://local.test').execute(
      'reportMessageIssue',
      { roomId: ROOM, messageId: await message('odd') },
      PERSON,
    );
    const turn = await triageTurn();
    const listed = (await daemon().execute('listFeedback', turn as never, TRIAGE)) as {
      items: { id: string; clusterSize: number; sourceKind: string }[];
    };
    expect(listed.items.map((item) => item.id)).toEqual([
      human.itemId,
      clustered.itemId,
      expect.any(String),
      lone.itemId,
    ]);
    expect(listed.items[1]!.clusterSize).toBe(2);
    const detail = (await daemon().execute(
      'getFeedback',
      { ...turn, itemIds: [human.itemId] } as never,
      TRIAGE,
    )) as { items: { evidence: { text: string }[] }[] };
    expect(detail.items[0]!.evidence[0]!.text).toBe('odd');
  });

  it('files a labelled issue with the server footer, attaches with one count comment, and dismisses', async () => {
    const github = new FakeGitHub();
    const service = daemon(github);
    const agentItem = await report({ category: 'bug', summary: 'grant card stuck' });
    const humanItem = await new PhoneService(database, 'http://local.test').execute(
      'reportMessageIssue',
      { roomId: ROOM, messageId: await message('stuck again') },
      OTHER,
    );
    const turn = await triageTurn();
    const filed = (await service.execute(
      'fileFeedbackIssue',
      {
        ...turn,
        itemIds: [agentItem.itemId, humanItem.itemId],
        title: 'Grant approval card does not resolve',
        body: 'After approving, the card stays pending until reload.',
        categoryLabel: 'bug',
      } as never,
      TRIAGE,
    )) as { issueNumber: number };
    const issue = github.issues.get(filed.issueNumber)!;
    expect(issue.labels).toEqual(['beeline-feedback', 'bug']);
    expect(issue.body).toContain(`Beeline feedback: ${agentItem.itemId} · 2 reports (1 human, 1 agent)`);
    expect((await items()).map((item) => item.status)).toEqual(['filed', 'filed']);

    const later = await report({ category: 'bug', summary: 'grant card stuck again' });
    const other = await report({ category: 'bug', summary: 'one more' });
    await service.execute(
      'attachFeedbackToIssue',
      { ...turn, itemIds: [later.itemId], issueNumber: filed.issueNumber } as never,
      TRIAGE,
    );
    await service.execute(
      'attachFeedbackToIssue',
      { ...turn, itemIds: [other.itemId], issueNumber: filed.issueNumber } as never,
      TRIAGE,
    );
    expect([...github.comments.values()]).toEqual([
      { issue: filed.issueNumber, body: 'Beeline feedback: 4 reports (1 human, 3 agent)' },
    ]);

    const noise = await report({ category: 'simpler_path', summary: 'noise' });
    await service.execute(
      'dismissFeedback',
      { ...turn, itemIds: [noise.itemId], reason: 'Working as intended' } as never,
      TRIAGE,
    );
    const statuses = await items();
    expect(statuses.find((item) => item.id === later.itemId)?.status).toBe('attached');
    expect(statuses.find((item) => item.id === noise.itemId)).toMatchObject({
      status: 'dismissed',
      triage_reason: 'Working as intended',
    });
  });

  it("leaves items new and returns GitHub's reason when GitHub refuses", async () => {
    const github = new FakeGitHub();
    github.fail = 'GitHub issues failed: HTTP 410: Issues are disabled for this repo';
    const item = await report({ summary: 'something broke' });
    const turn = await triageTurn();
    await expect(
      daemon(github).execute(
        'fileFeedbackIssue',
        { ...turn, itemIds: [item.itemId], title: 'T', body: 'B', categoryLabel: 'bug' } as never,
        TRIAGE,
      ),
    ).rejects.toThrow('Issues are disabled for this repo');
    expect((await items())[0]!.status).toBe('new');
  });

  it('counts the server footer against the 4000-character body limit', async () => {
    const github = new FakeGitHub();
    const item = await report({ summary: 'long body' });
    const turn = await triageTurn();
    const footer = `\n\n---\nBeeline feedback: ${item.itemId} · 1 report (0 human, 1 agent)`;
    const file = (body: string) =>
      daemon(github).execute(
        'fileFeedbackIssue',
        { ...turn, itemIds: [item.itemId], title: 'Long', body, categoryLabel: 'bug' } as never,
        TRIAGE,
      );
    // A body at the limit on its own is too long once the footer is added.
    await expect(file('x'.repeat(4000))).rejects.toThrow(
      'redaction rule body-length',
    );
    await expect(file('x'.repeat(4000 - footer.length + 1))).rejects.toThrow(
      `write at most ${4000 - footer.length}`,
    );
    expect(github.issues.size).toBe(0);
    expect((await items())[0]!.status).toBe('new');

    const filed = (await file('x'.repeat(4000 - footer.length))) as { issueNumber: number };
    const sent = github.issues.get(filed.issueNumber)!.body;
    expect(sent.length).toBe(4000);
    expect(sent.endsWith(footer)).toBe(true);
  });

  it('refuses a redacted write, naming the rule, and writes nothing', async () => {
    const github = new FakeGitHub();
    await message('The deploy to staging failed because the database password rotated overnight');
    const item = await report({ summary: 'deploy failed' });
    const turn = await triageTurn();
    await expect(
      daemon(github).execute(
        'fileFeedbackIssue',
        {
          ...turn,
          itemIds: [item.itemId],
          title: 'Deploy failure',
          body: 'User said: the database password rotated overnight and nothing noticed',
          categoryLabel: 'bug',
        } as never,
        TRIAGE,
      ),
    ).rejects.toThrow('redaction rule evidence-quote');
    expect(github.issues.size).toBe(0);
    expect((await items())[0]!.status).toBe('new');
  });
});

describe('redaction rules', () => {
  const context = {
    evidence: ['Please never show this exact private sentence to anyone else ok'],
    personNames: ['Priya Raman', 'priya'],
    roomNames: ['Moonbase Launch'],
  };
  const cases: [string, { title?: string; body: string }][] = [
    ['title-length', { title: 'x'.repeat(121), body: 'fine' }],
    ['body-length', { body: 'x'.repeat(4001) }],
    ['evidence-quote', { body: 'Quote: never show this exact private sentence to anyone' }],
    ['email', { body: 'Reach them at someone@example.com' }],
    ['secret', { body: 'key sk-abcdefghijklmnopqrstuvwxyz' }],
    ['person-name', { body: 'Reported by @priya yesterday' }],
    ['person-name', { body: 'priya raman saw it' }],
    ['room-name', { body: 'Happens in moonbase launch only' }],
  ];
  for (const [rule, write] of cases)
    it(`rejects ${rule}`, () => {
      let caught: unknown;
      try {
        assertFeedbackRedaction(write, context);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FeedbackRedactionError);
      expect((caught as FeedbackRedactionError).rule).toBe(rule);
    });

  it('accepts a description in the triager’s own words', () => {
    expect(() =>
      assertFeedbackRedaction(
        { title: 'Card stays pending', body: 'The approval card does not update after a decision.' },
        context,
      ),
    ).not.toThrow();
  });
});

describe('issue webhook (close the loop)', () => {
  async function filed(): Promise<{ agentItem: string; humanItem: string; number: number }> {
    const github = new FakeGitHub();
    const agentItem = (await report({ summary: 'timeout' })).itemId;
    const humanItem = (
      await new PhoneService(database, 'http://local.test').execute(
        'reportMessageIssue',
        { roomId: ROOM, messageId: await message('slow') },
        OTHER,
      )
    ).itemId;
    const turn = await triageTurn();
    const result = (await daemon(github).execute(
      'fileFeedbackIssue',
      { ...turn, itemIds: [agentItem, humanItem], title: 'Slow', body: 'Tools time out.', categoryLabel: 'bug' } as never,
      TRIAGE,
    )) as { issueNumber: number };
    return { agentItem, humanItem, number: result.issueNumber };
  }

  function event(action: string, number: number, stateReason?: string) {
    return {
      action,
      installation: { id: 42 },
      repository: { full_name: REPOSITORY },
      issue: {
        number,
        title: 'Slow tools',
        html_url: `https://github.com/${REPOSITORY}/issues/${number}`,
        ...(stateReason ? { state_reason: stateReason } : {}),
      },
    };
  }

  async function fixedDms() {
    return (
      await database.query<{ text: string; participants: string[] }>(
        `SELECT message.text,room.direct_participants participants FROM messages message
         JOIN rooms room ON room.id=message.room_id
         WHERE message.author_id=$1 AND message.text LIKE 'Fixed:%'`,
        [SYSTEM_IDENTITY_ID],
      )
    ).rows;
  }

  it('resolves on a completed close and DMs each human reporter and agent owner exactly once, whatever the Room GitHub setting', async () => {
    const { number } = await filed();
    const github = new GitHubOperations(
      database,
      {} as GitHubOAuthClient,
      {} as GitHubAppClient,
      's',
      undefined,
      undefined,
      { enabled: false },
      CONFIG,
    );
    await github.processWebhook('issues', event('closed', number, 'completed'));
    await github.processWebhook('issues', event('closed', number, 'completed'));
    expect((await items()).map((item) => item.status)).toEqual(['resolved', 'resolved']);
    const dms = await fixedDms();
    expect(dms.map((dm) => dm.text)).toEqual([
      `Fixed: Slow tools (#${number}) https://github.com/${REPOSITORY}/issues/${number}`,
      `Fixed: Slow tools (#${number}) https://github.com/${REPOSITORY}/issues/${number}`,
    ]);
    expect(dms.flatMap((dm) => dm.participants).filter((id) => id !== SYSTEM_IDENTITY_ID).sort()).toEqual(
      [PERSON, OTHER].sort(),
    );
    // Reopen returns items to filed; closing again sends no second DM.
    await github.processWebhook('issues', event('reopened', number));
    expect((await items()).map((item) => item.status)).toEqual(['filed', 'filed']);
    await github.processWebhook('issues', event('closed', number, 'completed'));
    expect(await fixedDms()).toHaveLength(2);
  });

  it('closes without a DM when not planned, and ignores other repositories', async () => {
    const { number } = await filed();
    await processFeedbackIssueEvent(database, CONFIG, {
      ...event('closed', number, 'completed'),
      repository: { full_name: 'someone/else' },
    });
    expect((await items()).map((item) => item.status)).toEqual(['filed', 'filed']);
    await processFeedbackIssueEvent(database, CONFIG, event('closed', number, 'not_planned'));
    expect((await items()).map((item) => item.status)).toEqual(['closed', 'closed']);
    expect(await fixedDms()).toEqual([]);
  });

  it('skips the DM for a reporter with no Workspace left', async () => {
    const { number } = await filed();
    await database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [OTHER]);
    const result = await processFeedbackIssueEvent(database, CONFIG, event('closed', number, 'completed'));
    expect(result).toEqual({ changed: 2, notified: 1 });
  });
});

describe('feedback config', () => {
  it('defaults the repository and has no agent allowlist', () => {
    expect(feedbackConfigFromEnv({})).toEqual({ repository: 'Beeline-Work/beeline' });
    expect(
      feedbackConfigFromEnv({
        BEELINE_FEEDBACK_REPOSITORY: 'o/r',
        BEELINE_FEEDBACK_TRIAGE_AGENT_IDS: TRIAGE,
      }),
    ).toEqual({ repository: 'o/r' });
  });
});

describe('triage corner: sibling fix corners and its sweep schedule', () => {
  it('opens a fix corner from the triage corner as a sibling in the parent Room, issue number in its brief', async () => {
    const turn = await triageTurn();
    const trigger = (
      await database.query<{ source_message_id: string }>(
        `SELECT source_message_id FROM agent_commands WHERE turn_request_id=$1`,
        [turn.requestId],
      )
    ).rows[0]!.source_message_id;
    const intent = { sourceMessageId: trigger, snapshot: '@sweeper sweep' };
    const { cornerId } = (await daemon().execute(
      'createCorner',
      {
        ...turn,
        idempotencyKey: `fix-${turn.requestId}`,
        name: 'Fix grant card',
        objective: 'Fix beeline-feedback issue #123',
        lane: 'no_code',
        brief: {
          buildSpec: 'Fix GitHub issue Beeline-Work/beeline#123: the grant card stays pending.',
          intentVerbatim: [intent],
          criteria: [{ id: 'AC-1', text: 'Issue #123 no longer reproduces' }],
          references: [],
          approvalBasis: { kind: 'initiating-command', ...intent },
        },
      } as never,
      TRIAGE,
    )) as { cornerId: string };
    const created = (
      await database.query<{ parent_id: string }>(`SELECT parent_id FROM rooms WHERE id=$1`, [
        cornerId,
      ])
    ).rows[0]!;
    expect(created.parent_id).toBe(ROOM);
    const brief = (
      await database.query<{ build_spec: string }>(
        `SELECT build_spec FROM corner_brief_revisions WHERE corner_id=$1 AND revision=1`,
        [cornerId],
      )
    ).rows[0]!;
    expect(brief.build_spec).toContain('#123');
    // The open card lands in the parent Room, where the sibling is listed.
    const card = await database.query(
      `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='daemon-fact' AND card->>'cornerId'=$2`,
      [ROOM, cornerId],
    );
    expect(card.rowCount).toBe(1);
  });

  it('runs a sweep schedule created inside the triage corner in that corner', async () => {
    const turn = await triageTurn();
    const { scheduleId } = (await daemon().execute(
      'createAgentSchedule',
      {
        ...turn,
        prompt: 'Sweep new Beeline feedback.',
        cadence: { kind: 'interval', everyMinutes: 60 * 24 * 3 },
      } as never,
      TRIAGE,
    )) as { scheduleId: string };
    await database.query(`UPDATE agent_schedules SET next_run_at=now()-interval '1 minute' WHERE id=$1`, [
      scheduleId,
    ]);
    const { AgentScheduleLoop } = await import('./agent-schedules.js');
    expect(await new AgentScheduleLoop(database).runOnce()).toBe(1);
    const fired = await database.query<{ room_id: string; reason: string }>(
      `SELECT room_id,reason FROM agent_commands WHERE agent_id=$1 AND reason='schedule'`,
      [TRIAGE],
    );
    expect(fired.rows).toEqual([{ room_id: TRIAGE_CORNER, reason: 'schedule' }]);
  });
});
