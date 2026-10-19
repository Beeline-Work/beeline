import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Check } from 'typebox/value';
import { agentToolsFor, callAgentTool } from './read-only-mcp.js';
import { harnessNeedsSilentReceipt } from './harness-capabilities.js';
import {
  beelineReviewSkillMarkdown,
  beelineSpecSkillMarkdown,
  beelineTriageSkillMarkdown,
  usingBeelineSkillMarkdown,
} from './beeline-skill.js';
import { SESSION_SECTIONS, TURN_SECTIONS } from './prompt-assembly.js';

const names = [
  'read',
  'search',
  'remember',
  'open_corner',
  'revise_corner',
  'order',
  'report',
  'report_feedback',
  'notify_feedback_fixed',
  'approve_merge',
  'merge_corner',
  'record_merge_yes',
  'set_corner_hold',
  'close_corner',
  'close_corner_pr',
  'post',
  'post_artifact',
  'request_grant',
  'connect',
  'app_tool',
  'wake',
  'react_to_message',
];
const calls: { operation: string; input: Record<string, unknown> }[] = [];
beforeEach(() => {
  calls.length = 0;
  const context = join(mkdtempSync(join(tmpdir(), 'minimal-tools-')), 'context.json');
  writeFileSync(
    context,
    JSON.stringify({ roomId: 'corner', requestId: 'request', generationId: 'generation' }),
  );
  for (const [key, value] of Object.entries({
    BEELINE_DAEMON_ROOM_ID: 'parent',
    BEELINE_DAEMON_CORNER_ID: 'corner',
    BEELINE_DAEMON_AGENT_ID: 'self',
    BEELINE_DAEMON_BASE_URL: 'http://localhost',
    BEELINE_DAEMON_TOKEN: 'test',
    BEELINE_TURN_CONTEXT_FILE: context,
  }))
    vi.stubEnv(key, value);
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    calls.push({ operation: url.pathname.split('/').pop()!, input: JSON.parse(String(init.body)) });
    return Response.json(
      url.pathname.endsWith('/watchCorner')
        ? { kinds: ['opened', 'merged'], state: 'active', snapshot: {} }
        : { ok: true, name: 'renamed' },
    );
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('minimal agent surface', () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('has one stable vocabulary for DM=%s corner=%s', (dm, corner) => {
    expect(
      agentToolsFor(true, dm, corner, corner, false, true, false, true).map((tool) => tool.name),
    ).toEqual(names);
  });
  it('mounts only meaningful runner/receipt tools and one bounded repository fallback', () => {
    expect(
      agentToolsFor(true, false, false, false, true, true, false, true).map((tool) => tool.name),
    ).toEqual([...names, 'run_granted_command']);
    expect(
      agentToolsFor(true, false, false, false, false, true, true, true).map((tool) => tool.name),
    ).toEqual([...names, 'no_reply_needed']);
    expect(agentToolsFor(false, false).map((tool) => tool.name)).toEqual(['repository_io']);
    expect(harnessNeedsSilentReceipt('claude-agent-acp')).toBe(true);
    expect(harnessNeedsSilentReceipt('pi-acp')).toBe(false);
    expect(harnessNeedsSilentReceipt('codex-acp')).toBe(false);
  });
  it('routes approval, landing, human yes, holds and both close modes separately', async () => {
    await callAgentTool('approve_merge', { address: 'target', headSha: 'a'.repeat(40) }, 'a');
    await callAgentTool('merge_corner', { address: 'target' }, 'b');
    await callAgentTool('record_merge_yes', { address: 'target' }, 'c');
    await callAgentTool('set_corner_hold', { address: 'target', releaseHoldId: '11111111-1111-4111-8111-111111111111' }, 'd');
    await callAgentTool('close_corner_pr', { address: 'target' }, 'e');
    await callAgentTool('close_corner', { address: 'target' }, 'f');
    expect(calls.map((call) => call.operation)).toEqual([
      'approveCornerMerge',
      'mergeCorner',
      'orderCornerMerge',
      'setCornerHold',
      'closeCornerPullRequest',
      'archiveCorner',
    ]);
    expect(calls.every((call) => call.input.cornerId === 'target')).toBe(true);
    expect(calls[3]!.input.releaseHoldId).toBe('11111111-1111-4111-8111-111111111111');
  });
  it('keeps commander reports, feedback and fixed notices on their own handlers', async () => {
    await callAgentTool(
      'report',
      { status: 'blocked', text: 'blocked: need a decision' },
      'r',
    );
    await callAgentTool(
      'report_feedback',
      { category: 'bug', summary: 'Broken attachment' },
      'f',
    );
    await callAgentTool(
      'notify_feedback_fixed',
      {
        item_ids: ['item'],
        title: 'Fixed attachment',
        pr_url: 'https://github.com/a/b/pull/1',
      },
      'x',
    );
    expect(calls.map((call) => call.operation)).toEqual([
      'report',
      'reportFeedback',
      'notifyFeedbackFixed',
    ]);
    expect(calls[0]!.input).not.toHaveProperty('address');
    expect(calls[0]!.input.roomId).toBe('corner');
  });
  it('R1 accepts the nested brief its schema advertises for revise_corner(action:brief)', async () => {
    const tool = agentToolsFor(true, false, true).find((value) => value.name === 'revise_corner')!;
    const input = {
      action: 'brief',
      address: 'target',
      expectedRevision: 3,
      change: 'Synthetic correction',
      brief: { spec: 'Synthetic spec', approval: { sourceMessageId: 'synthetic-message' } },
    };
    expect(Check(tool.inputSchema, input)).toBe(true);
    expect(JSON.parse(await callAgentTool('revise_corner', input, 'R1'))).toEqual({
      ok: true,
      name: 'renamed',
    });
    expect(calls.at(-1)).toEqual({
      operation: 'reviseCornerBrief',
      input: expect.objectContaining({
        cornerId: 'target',
        expectedRevision: 3,
        brief: expect.objectContaining({
          spec: 'Synthetic spec',
          approval: { sourceMessageId: 'synthetic-message' },
          change: 'Synthetic correction',
        }),
      }),
    });
  });

  it('posts a public note without dispatching any wake/order/report', async () => {
    await callAgentTool('post', { address: 'target', text: 'Public note' }, 'note');
    expect(calls.map((call) => call.operation)).toEqual(['postCornerMessage']);
  });
  it('defaults post to the active corner', async () => {
    await callAgentTool('post', { text: 'Active corner note' }, 'default');
    expect(calls[0]).toMatchObject({ operation: 'postCornerMessage', input: { cornerId: 'corner' } });
  });
  it('requires explicit targets and rejects legacy aliases before side effects', async () => {
    for (const [name, args] of [
      ['post', { cornerId: 'target', text: 'note' }],
      ['approve_merge', { address: 'target', head: 'a'.repeat(40) }],
      ['read', { address: 'target' }],
      ['read', { facet: 'brief', resource: 'target' }],
      ['list_rooms', {}],
      ['post_to_corner', { address: 'target', text: 'note' }],
    ] as const) await expect(callAgentTool(name, args, 'invalid')).rejects.toThrow();
    expect(calls).toEqual([]);
  });
  it('R1/R2 exposes complete flat read/search arguments to schema consumers', async () => {
    const tools = agentToolsFor(true, false);
    for (const name of ['read', 'search']) {
      const schema = tools.find(tool => tool.name === name)!.inputSchema;
      expect(schema.anyOf).toBeUndefined();
      expect(Check(schema, name === 'read'
        ? { facet: 'messages', cursor: { before: `123,${'a'.repeat(64)}` } }
        : { scope: 'history', query: 'synthetic query' })).toBe(true);
    }
    for (const [facet, field] of [['message', 'messageId'], ['attachment', 'attachmentId'], ['procedure', 'slug']]) {
      await expect(callAgentTool('read', { facet }, 'missing')).rejects.toThrow(`${field} is required`);
    }
    await expect(callAgentTool('read', { facet: 'messages', cursor: '123' }, 'bad')).rejects.toThrow('pass the returned next object unchanged');
    expect(calls).toEqual([]);
  });
  it('routes searches and sourced memory writes without changing privacy/version/used inputs', async () => {
    await callAgentTool('search', { scope: 'history', query: 'prior decision', limit: 3 }, 'h');
    await callAgentTool('search', { scope: 'memory', query: 'preference' }, 'm');
    await callAgentTool(
      'remember',
      {
        kind: 'fact',
        action: 'update',
        item_id: 'fact',
        version: 2,
        body: 'Corrected fact',
        source_message_ids: ['source'],
        person_asked: true,
      },
      'u',
    );
    await callAgentTool(
      'remember',
      { kind: 'fact', action: 'used', item_ids: ['fact'], snapshot_items: [1] },
      'used',
    );
    expect(calls.map((call) => call.operation)).toEqual([
      'searchInstitutionalHistory',
      'searchInstitutionalMemory',
      'updateInstitutionalMemory',
      'reportInstitutionalMemoryUsed',
    ]);
    expect(calls[2]!.input).toMatchObject({
      itemId: 'fact',
      version: 2,
      sourceMessageIds: ['source'],
      personAsked: true,
    });
    expect(calls[3]!.input).toMatchObject({ itemIds: ['fact'], snapshotItems: [1] });
  });
  it('reads exact messages, revisions, procedures and bounded transcripts through existing authorities', async () => {
    await callAgentTool(
      'read',
      { facet: 'message', messageId: 'message', cursor: { offset: 4000 } },
      'm',
    );
    await callAgentTool(
      'read',
      { facet: 'brief', address: 'target', cursor: { beforeRevision: 3 } },
      'b',
    );
    await callAgentTool('read', { facet: 'procedure', slug: 'workspace-core' }, 'p');
    expect(calls.map((call) => call.operation)).toEqual([
      'getRoomMessage',
      'listCornerBriefRevisions',
      'loadWorkspaceSkill',
    ]);
    expect(calls[0]!.input).toMatchObject({ messageId: 'message', offset: 4000 });
    expect(calls[1]!.input).toMatchObject({ cornerId: 'target', beforeRevision: 3 });
  });
  it.each(['status', 'ensure', 'discover'])('built-in connect %s never calls external setup', async mode => {
    for (const service of ['beeline:corner_app', 'beeline:workflow', 'beeline:browser_share',
      'beeline corner app', 'beelinecornerapp', 'corner_app']) {
      expect(JSON.parse(await callAgentTool('connect', { mode, service, reason: 'Use built-in app', continuation: 'Use its tools.' }, 'builtin')))
        .toMatchObject({ status: 'ready', next: expect.stringContaining('app_tool') });
    }
    expect(calls).toEqual([]);
  });

  it('wraps formatted connection readiness and advertises optional capabilities without connecting', async () => {
    const status = JSON.parse(await callAgentTool('connect', { mode: 'status' }, 'status'));
    expect(typeof status.readiness).toBe('string');
    expect(status.capabilities).toEqual(
      expect.arrayContaining(['beeline:workflow', 'beeline:wallet', 'beeline:browser_share']),
    );
    expect(calls.every((call) => call.operation === 'readAgentWorkbench')).toBe(true);
    const before = calls.length;
    const discovery = JSON.parse(await callAgentTool('connect', { mode: 'discover' }, 'discover'));
    expect(discovery.capabilities).toContain('beeline:workflow');
    expect(calls).toHaveLength(before);
  });

  it('discovers optional schemas locally and scopes an existing workflow wake to its corner', async () => {
    const catalog = JSON.parse(
      await callAgentTool('app_tool', { app: 'beeline:workflow' }, 'discover'),
    );
    expect(catalog.tools.map((tool: { name: string }) => tool.name)).toContain('advance');
    expect(calls).toEqual([]);
    await callAgentTool(
      'app_tool',
      {
        app: 'beeline:workflow',
        tool: 'advance',
        args: { runId: 'live-run', outcome: 'done', contents: {}, attempt: 7 },
      },
      'step',
    );
    expect(calls).toEqual([
      {
        operation: 'handoff',
        input: expect.objectContaining({ roomId: 'corner', runId: 'live-run', attempt: 7 }),
      },
    ]);
  });
  it('does not expose corner apps outside corners or IO fallbacks with proven native access', async () => {
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', '');
    await expect(callAgentTool('app_tool', { app: 'beeline:corner_app' }, 'd')).rejects.toThrow(
      'unavailable',
    );
    vi.stubEnv('BEELINE_NATIVE_IO_PROVEN', '1');
    await expect(callAgentTool('scratch_io', { action: 'quota' }, 'd')).rejects.toThrow(
      'unavailable',
    );
  });
  it('wake cannot choose messaging operations or another agent', async () => {
    for (const forged of [
      { agent: 'other' },
      { agentId: 'other' },
      { operation: 'order' },
      { text: 'post this' },
    ]) {
      await expect(
        callAgentTool('wake', { action: 'create', trigger: 'schedule', ...forged }, 'w'),
      ).rejects.toThrow();
    }
    expect(calls).toEqual([]);
    await callAgentTool('wake', { action: 'create', trigger: 'lifecycle', address: 'child' }, 'w');
    expect(calls).toEqual([
      {
        operation: 'watchCorner',
        input: {
          roomId: 'corner',
          requestId: 'request',
          generationId: 'generation',
          cornerId: 'child',
          kinds: ['opened', 'merged'],
        },
      },
    ]);
  });
  it('forces self-only schedule management and rejects legacy calls', async () => {
    await callAgentTool('wake', { action:'update', trigger:'schedule', scheduleId:'mine', prompt:'Inspect my work' }, 'own');
    expect(calls[0]).toMatchObject({ operation:'updateAgentSchedule', input:{ roomId:'corner', selfOnly:true, scheduleId:'mine' } });
    await expect(callAgentTool('update_schedule', { scheduleId:'old', prompt:'Legacy' }, 'old')).rejects.toThrow('unknown');
  });
  it('no prompt section or built-in skill instructs a retired tool', () => {
    const retired = [
      'get_room_message',
      'download_attachment',
      'list_rooms',
      'inspect_corner',
      'list_corners',
      'list_room_members',
      'read_pull_request',
      'read_corner_brief',
      'pr_checks_status',
      'rename_corner',
      'revise_corner_brief',
      'order_corner_merge',
      'close_pull_request',
      'find_connectors',
      'connectors_status',
      'workbench_status',
      'list_app_tools',
      'execute_app_tool',
      'save_memory',
      'update_memory',
      'delete_memory',
      'report_memory_used',
      'search_memory',
      'search_history',
      'load_workspace_skill',
      'save_skill',
      'delete_skill',
      'save_workflow',
      'start_workflow',
      'get_workflow_run',
      'cancel_workflow_run',
      'handoff',
      'archive_workflow',
      'assign_workflow_role',
      'write_scratch_file',
      'fetch_image',
      'ask_choice',
      'open_poll',
      'emit_event',
      'create_schedule',
      'list_schedules',
      'update_schedule',
      'delete_schedule',
      'subscribe_events',
      'watch',
      'set_wake_delivery',
      'get_wake_delivery',
    ];
    const skillText = [
      usingBeelineSkillMarkdown('test'),
      beelineSpecSkillMarkdown('test'),
      beelineReviewSkillMarkdown('test'),
      beelineTriageSkillMarkdown('test'),
    ].join('\n');
    // Inspect section render functions as well as the assembled-variant snapshot/budget tests.
    const sections = [...SESSION_SECTIONS, ...TURN_SECTIONS]
      .map((section) => String(section.render))
      .join('\n');
    for (const retiredName of retired.filter((name) => name !== 'watch'))
      expect(skillText + sections).not.toMatch(new RegExp(`\\b${retiredName}\\b`));
  });
});
