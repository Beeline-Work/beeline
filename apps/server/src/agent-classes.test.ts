import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { systemLine } from './system-line.js';
import {
  loadAgentClasses,
  refreshModelRegistryIfDue,
  sweepClassAssignmentTimeouts,
} from './agent-classes.js';

const H = 'a'.repeat(64); // Workspace owner (admin)
const M = 'd'.repeat(64); // plain member
const NIGLET = '1'.repeat(64); // heavy (opus alias)
const SOL = '2'.repeat(64); // heavy (codex, gpt-6.1-sol)
const BABY = '3'.repeat(64); // god (fable)
const SPEEDY = '4'.repeat(64); // light (haiku)
const W = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

let db: PgliteDatabase;
let phone: PhoneService;
let daemon: DaemonService;

const opusCatalog = JSON.stringify([
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: 'opus',
    options: [
      { id: 'opus', name: 'Opus 5.5' },
      { id: 'haiku', name: 'Haiku 4.5' },
    ],
  },
]);

async function online(agentId: string) {
  await db.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')
     ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
    [R, agentId],
  );
}

async function pending(agentId: string, roomId = R): Promise<AgentCommand[]> {
  return (await daemon.execute('getAgentCommands', { roomId }, agentId)).commands;
}

async function failTurn(command: AgentCommand, reasonKind: string, reason: string) {
  await daemon.execute(
    'claimAgentCommand',
    { roomId: command.roomId, commandId: command.id, generationId: 'g1' },
    command.agentId,
  );
  await daemon.execute(
    'postAgentTurnReceipt',
    {
      roomId: command.roomId,
      agentId: command.agentId,
      requestId: command.turnRequestId,
      generationId: 'g1',
      status: 'working',
    },
    command.agentId,
  );
  await daemon.execute(
    'postAgentTurnReceipt',
    {
      roomId: command.roomId,
      agentId: command.agentId,
      requestId: command.turnRequestId,
      generationId: 'g1',
      status: 'failed',
      reason,
      reasonKind,
    } as never,
    command.agentId,
  );
}

async function systemTexts(roomId = R): Promise<string[]> {
  return (
    await db.query<{ text: string }>(
      `SELECT text FROM messages WHERE room_id=$1 AND presentation IN ('system','card')
       ORDER BY created_at,id`,
      [roomId],
    )
  ).rows.map((row) => row.text);
}

beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Lunchbox','lunchbox'),($2,'human','Member','member'),
      ($3,'agent','Niglet','niglet'),($4,'agent','Sol','sol'),
      ($5,'agent','Baby','baby'),($6,'agent','Speedy','speedy')`,
    [H, M, NIGLET, SOL, BABY, SPEEDY],
  );
  await db.query(
    `INSERT INTO agents(agent_id,owner_id,harness,selected_model,model_catalog) VALUES
      ($1,$5,'claude','opus',$6::jsonb),
      ($2,$5,'codex','gpt-6.1-sol','[]'::jsonb),
      ($3,$5,'claude','claude-fable-5-1','[]'::jsonb),
      ($4,$5,'claude','haiku',$6::jsonb)`,
    [NIGLET, SOL, BABY, SPEEDY, H, opusCatalog],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'room'),($2,$3,'corner')`, [
    R,
    C,
    W,
  ]);
  await db.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [R, C]);
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle) VALUES($1,$2,'Do work','{"checks":"unknown"}')`,
    [C, SPEEDY],
  );
  for (const who of [H, NIGLET, SOL, BABY, SPEEDY])
    for (const room of [null, R, C])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,
        [W, room, who, who === H ? 'owner' : 'member'],
      );
  for (const room of [null, R])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [W, room, M],
    );
  // The registry as models.dev lists it today (subset).
  const body = {
    anthropic: {
      models: {
        'claude-fable-5-1': { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', family: 'claude-fable', cost: { output: 50 } },
        'claude-opus-5-5': { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', family: 'claude-opus', cost: { output: 20 } },
        'claude-haiku-4-5': { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (latest)', family: 'claude-haiku', cost: { output: 5 } },
        'claude-haiku-3': { id: 'claude-haiku-3', name: 'Claude Haiku 3', family: 'claude-haiku', cost: { output: 1.25 } },
      },
    },
    openai: {
      models: {
        'gpt-6.1-sol': { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', family: 'gpt-sol', cost: { output: 10 } },
      },
    },
  };
  const refreshed = await refreshModelRegistryIfDue(db, {
    fetcher: async () => new Response(JSON.stringify(body), { status: 200 }),
  });
  expect(refreshed).toBe('refreshed');
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
}, 30_000);

afterAll(async () => db?.close());

beforeEach(async () => {
  await db.query(`DELETE FROM class_assignments`);
  await db.query(`DELETE FROM room_choice_votes`);
  await db.query(`DELETE FROM room_choices`);
  await db.query(`DELETE FROM agent_commands`);
  await db.query(`DELETE FROM agent_turns`);
  await db.query(`DELETE FROM agent_health_flags`);
  await db.query(`DELETE FROM messages`);
  await db.query(`DELETE FROM agent_custom_tags`);
  await db.query(`DELETE FROM model_tier_overrides`);
  await db.query(`UPDATE agents SET model_unavailable=NULL,access_policy='{"type":"everyone"}'::jsonb`);
  await db.query(`UPDATE rooms SET reviewer_agent_id=NULL,reviewer_class=NULL`);
  await db.query(`UPDATE corner_facts SET lifecycle='{"checks":"unknown"}'::jsonb,command_check_state=NULL`);
  await db.query(`UPDATE memberships SET event_subscriptions='[]'::jsonb`);
  await db.query(`DELETE FROM live_outputs`);
  for (const agent of [NIGLET, SOL, BABY, SPEEDY]) await online(agent);
});

describe('tags and tiers', () => {
  it('derives automatic tags from the registry, the harness and aliases', async () => {
    const classes = await loadAgentClasses(db, W);
    expect(classes.get(NIGLET)?.classes.tags.map((tag) => tag.tag)).toEqual([
      'heavy',
      'opus',
      'claude-code',
      'anthropic',
    ]);
    expect(classes.get(SOL)?.classes).toMatchObject({ tier: 'heavy', provider: 'openai' });
    expect(classes.get(BABY)?.classes.tier).toBe('god');
    expect(classes.get(SPEEDY)?.classes).toMatchObject({ tier: 'heavy', modelId: 'claude-haiku-4-5' });
  });

  it('lets only admins edit custom tags and overrides, and an override wins', async () => {
    await expect(
      phone.execute('setAgentCustomTag', { workspaceId: W, agentId: SOL, tag: 'reviewer', present: true }, M),
    ).rejects.toThrow();
    await expect(
      phone.execute('setModelTierOverride', { workspaceId: W, scope: 'family', key: 'haiku', tier: 'light' }, M),
    ).rejects.toThrow();
    await phone.execute('setAgentCustomTag', { workspaceId: W, agentId: SOL, tag: 'Reviewer', present: true }, H);
    await expect(
      phone.execute('setAgentCustomTag', { workspaceId: W, agentId: SOL, tag: 'heavy', present: true }, H),
    ).rejects.toThrow(/reserved/);
    await phone.execute('setModelTierOverride', { workspaceId: W, scope: 'family', key: 'haiku', tier: 'light' }, H);
    const detail = await phone.readAgent(W, SOL, H);
    expect(detail?.classes?.tags).toContainEqual({ tag: 'reviewer', kind: 'custom', removable: true });
    expect(detail?.canManageClasses).toBe(true);
    expect((await phone.readAgent(W, SOL, M))?.canManageClasses).toBe(false);
    const view = await phone.execute('readWorkspaceAgentClasses', { workspaceId: W }, H);
    expect(view.agents.find((agent) => agent.agentId === SPEEDY)?.classes).toMatchObject({
      tier: 'light',
      source: 'family-override',
    });
    expect(view.overrides).toEqual([{ scope: 'family', key: 'haiku', tier: 'light' }]);
    await expect(phone.execute('readWorkspaceAgentClasses', { workspaceId: W }, M)).rejects.toThrow();
  });

  it('marks an unlisted model light and unclassified until an admin pins it', async () => {
    await db.query(`UPDATE agents SET selected_model='gemma-4-31b-it-fabled',harness='goose',provider='openrouter' WHERE agent_id=$1`, [BABY]);
    try {
      let view = await phone.execute('readWorkspaceAgentClasses', { workspaceId: W }, H);
      expect(view.agents.find((agent) => agent.agentId === BABY)?.classes.tags.map((t) => t.tag)).toEqual([
        'light',
        'unclassified',
        'goose',
        'openrouter',
      ]);
      expect(view.unclassified).toEqual([
        { key: 'openrouter/gemma-4-31b-it-fabled', agentNames: ['Baby'] },
      ]);
      await phone.execute(
        'setModelTierOverride',
        { workspaceId: W, scope: 'model', key: 'openrouter/gemma-4-31b-it-fabled', tier: 'heavy' },
        H,
      );
      view = await phone.execute('readWorkspaceAgentClasses', { workspaceId: W }, H);
      expect(view.unclassified).toEqual([]);
      expect(view.agents.find((agent) => agent.agentId === BABY)?.classes.tier).toBe('heavy');
    } finally {
      await db.query(`UPDATE agents SET selected_model='claude-fable-5-1',harness='claude',provider=NULL WHERE agent_id=$1`, [BABY]);
    }
  });

  it('keeps the cached registry when a refresh fails', async () => {
    const result = await refreshModelRegistryIfDue(db, {
      force: true,
      fetcher: async () => new Response('nope', { status: 503 }),
    });
    expect(result).toBe('failed');
    expect((await loadAgentClasses(db, W)).get(NIGLET)?.classes.tier).toBe('heavy');
  });
});

describe('workflow step by class', () => {
  it('fails over to the next heavy agent on an instant failure, then asks a human', async () => {
    // Speedy is pinned light so the heavy class is exactly Niglet and Sol.
    await phone.execute('setModelTierOverride', { workspaceId: W, scope: 'family', key: 'haiku', tier: 'light' }, H);
    const result = await phone.execute(
      'dispatchClassStep',
      { roomId: R, agentClass: 'heavy', role: 'review', prompt: 'Review PR #1', runKey: 'run-1' },
      H,
    );
    expect([NIGLET, SOL]).toContain(result.agentId);
    const first = result.agentId!;
    const second = first === NIGLET ? SOL : NIGLET;
    const [firstCommand] = await pending(first);
    expect(firstCommand?.sourceMessageId).toBe(result.messageId);
    expect(await pending(second)).toEqual([]);

    await failTurn(firstCommand!, 'model-selection-unavailable', 'model selection unavailable');
    const [secondCommand] = await pending(second);
    expect(secondCommand?.sourceMessageId).toBe(result.messageId);
    expect((await systemTexts()).join('\n')).toMatch(/could not take step review · model unavailable · handed to/);

    await failTurn(secondCommand!, 'allowance-spent', 'You need more credits');
    const choice = (
      await db.query<{ prompt: string; status: string; constraint_text: string }>(
        `SELECT prompt,status,constraint_text FROM room_choices WHERE room_id=$1`,
        [R],
      )
    ).rows[0];
    expect(choice?.status).toBe('open');
    expect(choice?.prompt).toMatch(/No healthy heavy agent took step "review"/);
    expect(choice?.constraint_text).toMatch(/model unavailable/);
    expect(choice?.constraint_text).toMatch(/out of credits/);
    const assignment = (
      await db.query<{ status: string }>(`SELECT status FROM class_assignments WHERE run_key='run-1'`)
    ).rows[0];
    expect(assignment?.status).toBe('exhausted');
  });

  it('skips unhealthy candidates and keeps a sticky agent for the run', async () => {
    await phone.execute('setModelTierOverride', { workspaceId: W, scope: 'family', key: 'haiku', tier: 'light' }, H);
    await db.query(`DELETE FROM live_outputs WHERE agent_id=$1`, [NIGLET]); // offline
    const first = await phone.execute(
      'dispatchClassStep',
      { roomId: R, agentClass: 'heavy', role: 'build', prompt: 'Step one', runKey: 'run-2' },
      H,
    );
    expect(first.agentId).toBe(SOL);
    await online(NIGLET);
    for (let step = 0; step < 4; step += 1) {
      const next = await phone.execute(
        'dispatchClassStep',
        { roomId: R, agentClass: 'heavy', role: 'build', prompt: `Step ${step + 2}`, runKey: 'run-2' },
        H,
      );
      expect(next.agentId).toBe(SOL);
    }
  });

  it('applies the agent access policy exactly as a mention does', async () => {
    await phone.execute('setModelTierOverride', { workspaceId: W, scope: 'family', key: 'haiku', tier: 'light' }, H);
    await db.query(`UPDATE agents SET access_policy='{"type":"creator"}'::jsonb WHERE agent_id=$1`, [SOL]);
    const result = await phone.execute(
      'dispatchClassStep',
      { roomId: R, agentClass: 'heavy', role: 'review', prompt: 'Hi', runKey: 'run-3' },
      M,
    );
    expect(result.agentId).toBe(NIGLET);
  });

  it('moves on after silence past the step timeout', async () => {
    await phone.execute('setModelTierOverride', { workspaceId: W, scope: 'family', key: 'haiku', tier: 'light' }, H);
    const result = await phone.execute(
      'dispatchClassStep',
      { roomId: R, agentClass: 'heavy', role: 'review', prompt: 'Hi', runKey: 'run-4', timeoutSeconds: 30 },
      H,
    );
    const first = result.agentId!;
    await db.query(
      `UPDATE class_assignments SET attempt_started_at=now()-interval '31 seconds' WHERE run_key='run-4'`,
    );
    expect(await sweepClassAssignmentTimeouts(db)).toBe(1);
    const second = first === NIGLET ? SOL : NIGLET;
    expect((await pending(second)).length).toBe(1);
    expect((await systemTexts()).join('\n')).toMatch(/no reply before the step timeout · handed to/);
  });

  it('lets a human retry reach an agent whose failure window has not expired', async () => {
    await phone.execute('setModelTierOverride', { workspaceId: W, scope: 'family', key: 'haiku', tier: 'light' }, H);
    const result = await phone.execute(
      'dispatchClassStep',
      { roomId: R, agentClass: 'heavy', role: 'review', prompt: 'Hi', runKey: 'run-6' },
      H,
    );
    const first = result.agentId!;
    const second = first === NIGLET ? SOL : NIGLET;
    await failTurn((await pending(first))[0]!, 'allowance-spent', 'You need more credits');
    await failTurn((await pending(second))[0]!, 'allowance-spent', 'You need more credits');
    const choice = (
      await db.query<{ id: string; options: { optionId: string }[] }>(
        `SELECT id,options FROM room_choices WHERE room_id=$1 AND status='open'`,
        [R],
      )
    ).rows[0]!;
    await db.query(`DELETE FROM agent_commands`);
    await phone.execute('answerChoice', { choiceId: choice.id, optionId: choice.options[0]!.optionId }, H);
    expect((await pending(first)).length + (await pending(second)).length).toBe(1);
  });

  it('retries the class when a human answers the exhausted question', async () => {
    await db.query(`UPDATE agents SET model_unavailable='model' WHERE agent_id IN ($1,$2,$3)`, [
      NIGLET,
      SOL,
      SPEEDY,
    ]);
    const result = await phone.execute(
      'dispatchClassStep',
      { roomId: R, agentClass: 'heavy', role: 'review', prompt: 'Hi', runKey: 'run-5' },
      H,
    );
    expect(result.agentId).toBeUndefined();
    const choice = (
      await db.query<{ id: string; options: { optionId: string }[] }>(
        `SELECT id,options FROM room_choices WHERE room_id=$1 AND status='open'`,
        [R],
      )
    ).rows[0]!;
    await db.query(`UPDATE agents SET model_unavailable=NULL WHERE agent_id=$1`, [SOL]);
    await phone.execute('answerChoice', { choiceId: choice.id, optionId: choice.options[0]!.optionId }, H);
    expect((await pending(SOL)).length).toBe(1);
  });
});

describe('corner reviewer by class', () => {
  async function greenHead(headSha: string) {
    await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`, [
      C,
      JSON.stringify({
        checks: 'passing',
        lifecycle: 'in-review',
        pr: { number: 7, url: 'https://github.com/acme/repo/pull/7', headSha },
      }),
    ]);
    return systemLine(db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      kind: 'check-passed',
      object: { text: 'aggregate checks', headSha },
    });
  }

  it('still reviews when the first pick is unavailable', async () => {
    await phone.execute('setModelTierOverride', { workspaceId: W, scope: 'family', key: 'haiku', tier: 'light' }, H);
    await phone.execute('updateRoom', { roomId: R, reviewerClass: 'heavy' }, H);
    const picked = (
      await db.query<{ reviewer_agent_id: string; reviewer_class: string }>(
        `SELECT reviewer_agent_id,reviewer_class FROM rooms WHERE id=$1`,
        [R],
      )
    ).rows[0]!;
    expect(picked.reviewer_class).toBe('heavy');
    expect([NIGLET, SOL]).toContain(picked.reviewer_agent_id);
    const first = picked.reviewer_agent_id;
    const second = first === NIGLET ? SOL : NIGLET;

    const source = await greenHead('abc123');
    const [review] = await pending(first, C);
    expect(review?.sourceMessageId).toBe(source.id);

    await failTurn(review!, 'model-selection-unavailable', 'model selection unavailable');
    const [handed] = await pending(second, C);
    expect(handed?.sourceMessageId).toBe(source.id);
    const room = (
      await db.query<{ reviewer_agent_id: string }>(`SELECT reviewer_agent_id FROM rooms WHERE id=$1`, [R])
    ).rows[0]!;
    expect(room.reviewer_agent_id).toBe(second);
    expect((await systemTexts(C)).join('\n')).toMatch(/could not take the review · model unavailable · handed to/);
  });

  it('skips an unavailable pick before dispatch and asks a human when none is left', async () => {
    await phone.execute('setModelTierOverride', { workspaceId: W, scope: 'family', key: 'haiku', tier: 'light' }, H);
    await phone.execute('updateRoom', { roomId: R, reviewerClass: 'heavy' }, H);
    await db.query(`UPDATE agents SET model_unavailable='model' WHERE agent_id=$1`, [NIGLET]);
    await db.query(`DELETE FROM live_outputs WHERE agent_id=$1`, [SOL]);
    await greenHead('def456');
    expect(await pending(NIGLET, C)).toEqual([]);
    expect(await pending(SOL, C)).toEqual([]);
    const choice = (
      await db.query<{ prompt: string; constraint_text: string }>(
        `SELECT prompt,constraint_text FROM room_choices WHERE room_id=$1`,
        [C],
      )
    ).rows[0];
    expect(choice?.prompt).toMatch(/No healthy heavy agent took the review/);
    expect(choice?.constraint_text).toMatch(/Niglet: model unavailable \(skipped\)/);
    expect(choice?.constraint_text).toMatch(/Sol: offline \(skipped\)/);
  });
});
