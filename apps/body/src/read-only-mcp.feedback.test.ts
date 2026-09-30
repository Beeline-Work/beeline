import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { agentToolsFor, callAgentTool, reportFeedback } from './read-only-mcp.js';
import { CommandExecutionContext } from './server-command-intake.js';

const TRIAGE_TOOLS = [
  'list_feedback',
  'get_feedback',
  'list_feedback_issues',
  'file_feedback_issue',
  'attach_feedback_to_issue',
  'dismiss_feedback',
];

describe('feedback tools', () => {
  it('offers report_feedback on every surface, memory rollout or not', () => {
    const surfaces = {
      room: agentToolsFor(true, false),
      dm: agentToolsFor(true, true),
      corner: agentToolsFor(true, false, true),
      reviewer: agentToolsFor(true, false, true, true),
      noCodeCorner: agentToolsFor(true, false, true, false, true, false, true, true),
      memoryOff: agentToolsFor(true, false, false, false, true, false, false),
    };
    for (const [surface, tools] of Object.entries(surfaces)) {
      const names = tools.map((tool) => tool.name);
      expect(names, surface).toContain('report_feedback');
      for (const name of TRIAGE_TOOLS) expect(names, surface).not.toContain(name);
    }
    const report = surfaces.room.find((tool) => tool.name === 'report_feedback')!;
    expect(report.inputSchema.properties).not.toHaveProperty('prompt_section_ids');
    expect((report.inputSchema.properties as Record<string, { enum?: string[] }>).category?.enum).toEqual([
      'simpler_path',
      'contradiction',
      'tooling_gap',
      'context_gap',
      'bug',
    ]);
  });

  it('mounts the triage tools only in a Feedback triage corner', () => {
    const triageCorner = agentToolsFor(true, false, true, false, true, false, true, false, true);
    const names = triageCorner.map((tool) => tool.name);
    for (const name of TRIAGE_TOOLS) expect(names).toContain(name);
    // Every corner opens sibling corners; the triage corner uses that for fixes.
    expect(names).toContain('open_corner');
    // The setting is a corner's; a Room or DM turn never gets triage tools from it.
    for (const tools of [
      agentToolsFor(true, false, false, false, true, false, true, false, true),
      agentToolsFor(true, true, false, false, true, false, true, false, true),
    ])
      for (const name of TRIAGE_TOOLS) expect(tools.map((tool) => tool.name)).not.toContain(name);
  });
});

describe('report_feedback', () => {
  let calls: { name: string; input: Record<string, unknown> }[];
  let answer: (name: string) => Response;
  let context: CommandExecutionContext;

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), 'feedback-'));
    context = new CommandExecutionContext(root);
    await context.enter({
      roomId: 'room-1',
      turnRequestId: 'request-1',
      rootCommandId: 'command-1',
    } as AgentCommand);
    for (const [key, value] of Object.entries({
      BEELINE_DAEMON_ROOM_ID: 'room-1',
      BEELINE_DAEMON_BASE_URL: 'http://localhost:1234',
      BEELINE_DAEMON_TOKEN: 'test-token',
      BEELINE_TURN_CONTEXT_FILE: context.path,
    }))
      vi.stubEnv(key, value);
    calls = [];
    answer = () => Response.json({ itemId: 'fb_1', duplicate: false });
    vi.stubGlobal('fetch', async (input: URL, init: RequestInit) => {
      const name = new URL(input).pathname.split('/').pop()!;
      calls.push({ name, input: JSON.parse(String(init.body)) });
      return answer(name);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("attaches the turn's assembled prompt sections and request, never agent-supplied ones", async () => {
    context.notePromptSections(['core.identity', 'core.feedback', 'room.task', 'core.identity']);
    const result = await reportFeedback({
      category: 'tooling_gap',
      summary: 'No way to list corners by lane',
      tool_name: 'inspect_corner',
      prompt_section_ids: ['forged'],
    });
    expect(JSON.parse(result)).toEqual({ itemId: 'fb_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'reportFeedback',
      input: {
        roomId: 'room-1',
        category: 'tooling_gap',
        toolName: 'inspect_corner',
        requestId: 'request-1',
        generationId: context.generationId,
        promptSectionIds: ['core.identity', 'core.feedback', 'room.task'],
      },
    });
    expect(JSON.parse(readFileSync(context.path, 'utf8')).promptSectionIds).toHaveLength(3);
  });

  it('sends every triage call, reads included, with the turn it runs in', async () => {
    answer = () => Response.json({ items: [], issues: [], repository: 'o/r' });
    for (const [tool, args] of [
      ['list_feedback', {}],
      ['get_feedback', { item_ids: ['fb_1'] }],
      ['list_feedback_issues', {}],
      ['dismiss_feedback', { item_ids: ['fb_1'], reason: 'noise' }],
    ] as const)
      await callAgentTool(tool, args as never, 'call-1');
    expect(calls.map((call) => call.name)).toEqual([
      'listFeedback',
      'getFeedback',
      'listFeedbackIssues',
      'dismissFeedback',
    ]);
    for (const call of calls)
      expect(call.input, call.name).toMatchObject({
        roomId: 'room-1',
        requestId: 'request-1',
        generationId: context.generationId,
      });
  });

  it('returns a refusal as a result instead of failing the turn', async () => {
    answer = () => Response.json({ error: 'feedback cap reached' }, { status: 400 });
    const result = JSON.parse(await reportFeedback({ category: 'bug', summary: 'again' }));
    expect(result).toEqual({
      reported: false,
      reason: 'daemon operation reportFeedback failed (400: feedback cap reached)',
    });
  });
});
