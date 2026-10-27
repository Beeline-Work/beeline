import { ARTIFACT_MIME_TYPES } from '@beeline/api-contract/daemon';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Check } from 'typebox/value';
import { agentToolsFor, callAgentTool } from './read-only-mcp.js';
import { beelineManagedSkills } from './beeline-skill.js';
import { SESSION_SECTIONS, TURN_SECTIONS } from './prompt-assembly.js';

const names = [
  'read',
  'search',
  'remember',
  'open_corner',
  'revise_corner',
  'order',
  'report',
  'dispatch_release',
  'report_feedback',
  'notify_feedback_fixed',
  'approve_merge',
  'merge_corner',
  'send_operator_system_dm',
  'read_operator_system_dm',
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
  it('advertises the retained fact-write rules before a save', () => {
    const description = agentToolsFor(true, false).find(tool => tool.name === 'remember')!.description;
    for (const rule of ['1-16', 'non-deleted', 'this Room', 'root source partition',
      'DM facts', 'Profile facts need a requester-started turn', '200 UTF-8 bytes',
      'person_asked must be a boolean', 'attaches this turn']) {
      expect(description).toContain(rule);
    }
  });

  it('advertises every shared artifact MIME, including runnable games', () => {
    const schema = agentToolsFor(true, false).find(tool => tool.name === 'post_artifact')!.inputSchema;
    const properties = schema.properties as Record<string, { enum: string[] }>;
    expect(properties.mime.enum).toEqual(ARTIFACT_MIME_TYPES);
    for (const mime of ARTIFACT_MIME_TYPES) {
      expect(Check(schema as never, { path: '.artifacts/voxel-island.html', mime })).toBe(true);
    }
  });

  it('posts a game path through the advertised tool and queues its runnable MIME', async () => {
    const root = mkdtempSync(join(tmpdir(), 'game-artifact-'));
    const path = join(root, 'voxel-island.html');
    const html = '<canvas></canvas><script>game()</script>';
    writeFileSync(path, html);
    vi.stubEnv('BEELINE_ATTACH_ROOT', root);
    const requests: { path: string; body: unknown; mime: string | null }[] = [];
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      const upload = url.pathname === '/v1/daemon/artifacts';
      requests.push({ path: url.pathname, body: upload ? init.body : JSON.parse(String(init.body)),
        mime: new Headers(init.headers).get('content-type') });
      return Response.json(upload ? { url: '/v1/media/game-proof' } : { ok: true });
    });
    await callAgentTool('post_artifact', { path, mime: 'application/vnd.beeline.game+html' });
    expect(requests).toEqual([
      { path: '/v1/daemon/artifacts', body: Buffer.from(html), mime: 'application/vnd.beeline.game+html' },
      { path: '/v1/daemon/operations/postAgentAttachment', mime: 'application/json', body: {
        roomId: 'corner', requestId: 'request', generationId: 'generation',
        attachment: { url: '/v1/media/game-proof', name: 'voxel-island.html',
          mimeType: 'application/vnd.beeline.game+html', size: Buffer.byteLength(html) },
      } },
    ]);
  });

  it('dispatches release recovery inputs with active corner authority and no grant runner', async () => {
    await callAgentTool('dispatch_release', { inputs: { release_version: 'v0.1.94' } });
    expect(calls).toEqual([{ operation: 'dispatchRoomWorkflow', input: {
      roomId: 'corner', requestId: 'request', generationId: 'generation', inputs: { release_version: 'v0.1.94' },
    } }]);
    const schema = agentToolsFor(true, false).find(tool => tool.name === 'dispatch_release')!.inputSchema;
    expect(Check(schema as never, { inputs: { dispatched_by: 'forged' } })).toBe(false);
    expect(Check(schema as never, { inputs: { retry_attempt: '2' } })).toBe(false);
    expect(Check(schema as never, { inputs: { release_version: 'v0.1.94' } })).toBe(true);
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('has one stable vocabulary for DM=%s corner=%s', (dm, corner) => {
    expect(
      agentToolsFor(true, dm, corner, corner, false, true, true).map((tool) => tool.name),
    ).toEqual([...names, 'no_reply_needed']);
  });
  it('mounts the silent receipt on every agent surface, harness included', () => {
    // no_reply_needed is the only silence path, so every agent surface mounts
    // it regardless of harness; the tool itself refuses human wakes.
    for (const tools of [
      agentToolsFor(true, false, false, false, false, true, true),
      agentToolsFor(true, false, false, false, true, true, true),
      agentToolsFor(true, true, true, true, true, true, true),
    ]) {
      expect(tools.map((tool) => tool.name)).toContain('no_reply_needed');
    }
    expect(
      agentToolsFor(true, false, false, false, true, true, true).map((tool) => tool.name),
    ).toEqual([...names, 'run_granted_command', 'no_reply_needed']);
    expect(
      agentToolsFor(true, false, false, false, false, true, true).map((tool) => tool.name),
    ).toEqual([...names, 'no_reply_needed']);
    expect(agentToolsFor(false, false).map((tool) => tool.name)).toEqual(['repository_io']);
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
  it('routes operator System DM sends and status reads with active command authority', async () => {
    await callAgentTool('send_operator_system_dm', { recipients: ['@recipient'], text: 'Fixed.' }, 'send');
    await callAgentTool('read_operator_system_dm', { sendId: '11111111-1111-4111-8111-111111111111' }, 'read');
    expect(calls[0]).toEqual({ operation: 'sendOperatorSystemDm', input: {
      roomId: 'corner', requestId: 'request', generationId: 'generation', agentId: 'self',
      recipients: ['@recipient'], text: 'Fixed.',
    } });
    expect(calls[1]!.operation).toBe('readOperatorSystemDm');
    expect(calls[1]!.input).toMatchObject({ roomId: 'corner', requestId: 'request', generationId: 'generation' });
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
    expect(tool.inputSchema.anyOf).toBeUndefined();
    expect(tool.inputSchema.properties).toHaveProperty('address');
    expect(tool.inputSchema.properties).toHaveProperty('brief');
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

  it('R-REVISE names an invalid nested field before side effects', async () => {
    await expect(callAgentTool('revise_corner', { action: 'brief', address: 'target',
      expectedRevision: 1, change: 'Correction', brief: { spec: 42 } }, 'invalid'))
      .rejects.toThrow('/brief/spec');
    expect(calls).toEqual([]);
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
  it('Reproduction search-refusal: names invalid fields and accepts advertised bounds', async () => {
    const schema = agentToolsFor(true, false).find(tool => tool.name === 'search')!.inputSchema;
    for (const [args, message] of [
      [{ scope: 'other', query: 'term' }, /scope.*history.*memory/i],
      [{ scope: 'history', query: '  ' }, /query/i],
      [{ scope: 'history', query: 'term', limit: 0 }, /limit.*1.*10/i],
      [{ scope: 'memory', query: '🙂'.repeat(126) }, /query.*500.*UTF-8 bytes/i],
    ] as const) {
      await expect(callAgentTool('search', args, 'invalid')).rejects.toThrow(message);
    }
    expect(calls).toEqual([]);

    const accepted = [
      { scope: 'history', query: '🙂'.repeat(500), limit: 10 },
      { scope: 'memory', query: '🙂'.repeat(125), limit: 1 },
      { scope: 'memory', query: 'x'.repeat(500), limit: 10 },
    ];
    for (const args of accepted) {
      expect(Check(schema, args)).toBe(true);
      await callAgentTool('search', args, 'valid');
    }
    expect(calls).toHaveLength(accepted.length);
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
    expect(calls.map(call => call.operation)).toEqual(['getRoomRepositoryState', 'readAgentWorkbench']);
    const before = calls.length;
    const discovery = JSON.parse(await callAgentTool('connect', { mode: 'discover' }, 'discover'));
    expect(discovery.capabilities).toContain('beeline:workflow');
    expect(calls).toHaveLength(before + 1);
    expect(calls.at(-1)?.operation).toBe('getRoomRepositoryState');
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
  it('requires creation names and event trigger words, and forwards them', async () => {
    const schema = agentToolsFor(true, false).find(tool => tool.name === 'wake')!.inputSchema;
    const schedule = { action: 'create', trigger: 'schedule', prompt: 'Check work',
      cadence: { kind: 'interval', everyMinutes: 60 } };
    const event = { action: 'create', trigger: 'event', source: 'room', event: 'check-failed',
      prompt: 'Fix checks', title: 'Fix failing checks' };
    expect(Check(schema as never, schedule)).toBe(false);
    expect(Check(schema as never, { ...schedule, title: 'Check work' })).toBe(true);
    expect(Check(schema as never, event)).toBe(false);
    expect(Check(schema as never, { ...event, when: 'On corner checks failing' })).toBe(true);
    await callAgentTool('wake', { ...event, when: 'On corner checks failing' }, 'w');
    expect(calls).toContainEqual(expect.objectContaining({
      operation: 'createAgentSubscription',
      input: expect.objectContaining({ title: event.title, when: 'On corner checks failing' }),
    }));
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
  it('R-WAKEDEL creates then deletes a schedule without trigger through the advertised tool', async () => {
    const schedules = new Set<string>();
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      const input = JSON.parse(String(init.body));
      const operation = url.pathname.split('/').pop()!;
      calls.push({ operation, input });
      if (operation === 'createAgentSchedule') {
        schedules.add('created');
        return Response.json({ scheduleId: 'created' });
      }
      if (operation === 'deleteAgentSchedule') {
        expect(schedules.delete(input.scheduleId)).toBe(true);
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected operation ${operation}`);
    });
    const created = await callAgentTool('wake', {
      action: 'create', trigger: 'schedule', title: 'Check work', prompt: 'Check work',
      cadence: { kind: 'interval', everyMinutes: 60 },
    }, 'create');
    expect(created).toContain('Schedule created created');
    expect(await callAgentTool('wake', { action: 'delete', scheduleId: 'created' }, 'delete'))
      .toBe('Schedule created deleted.');
    expect(schedules.size).toBe(0);
    expect(calls[1]).toMatchObject({ operation: 'deleteAgentSchedule', input: {
      roomId: 'corner', scheduleId: 'created', selfOnly: true,
    } });
  });
  it.each([
    [{ action: 'create' }, 'trigger'],
    [{ action: 'delete', trigger: 'schedule' }, 'scheduleId'],
    [{ action: 'delete', scheduleId: 42 }, 'scheduleId'],
    [{ action: 'delete', scheduleId: 'mine', trigger: 'bad' }, 'trigger'],
    [{ action: 'create', trigger: 'schedule', cadence: { kind: 'interval', everyMinutes: 'bad' } }, 'everyMinutes'],
    [{ action: 'replace_events' }, 'kinds'],
  ])('names the invalid or missing wake field for %j', async (args, field) => {
    await expect(callAgentTool('wake', args, 'invalid')).rejects.toThrow(field);
    expect(calls).toEqual([]);
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
    const skillText = beelineManagedSkills('test', { isReviewer: true })
      .map(({ content }) => content)
      .join('\n');
    // Inspect section render functions as well as the assembled-variant snapshot/budget tests.
    const sections = [...SESSION_SECTIONS, ...TURN_SECTIONS]
      .map((section) => String(section.render))
      .join('\n');
    for (const retiredName of retired.filter((name) => name !== 'watch'))
      expect(skillText + sections).not.toMatch(new RegExp(`\\b${retiredName}\\b`));
  });
});

it('OPEN-1: opening and commander revision approval are optional in the schema', () => {
  const tools = agentToolsFor(true, false, true);
  const opening = tools.find((tool) => tool.name === 'open_corner')!;
  expect(Check(opening.inputSchema, { room: '11111111-1111-4111-8111-111111111111', name: 'widget', objective: 'Build widget',
    implementer: 'worker', brief: { spec: 'Build widget' } })).toBe(true);
  const revision = tools.find((tool) => tool.name === 'revise_corner')!;
  expect(Check(revision.inputSchema, { action: 'brief', address: 'target', expectedRevision: 1,
    change: 'Adjust scope', brief: { spec: 'Adjust widget' } })).toBe(true);
});
