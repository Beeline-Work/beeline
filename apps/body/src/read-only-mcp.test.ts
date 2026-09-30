import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentToolsFor, cornerCallText } from './read-only-mcp.js';
import { assembleSessionPrompt, SEARCH_MEMORY_FIRST_RULE } from './prompt-assembly.js';

describe('direct message helper surface', () => {
  it('opens no corners from a direct message', () => {
    const tools = agentToolsFor(true, true);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('get_room_message');
    expect(names).toContain('post_artifact');
    expect(names).not.toContain('open_corner');
    expect(names).not.toContain('delegate_to_agent');

    // The read-only surface is untouched: it never carried daemon tools.
    const roomTools = agentToolsFor(false, true).map((tool) => tool.name);
    expect(roomTools).not.toContain('open_corner');
    expect(roomTools).not.toContain('post_artifact');

    // A top-level Room keeps the bounded daemon controls.
    expect(agentToolsFor(true, false).map((tool) => tool.name)).toContain('open_corner');
    expect(agentToolsFor(true, false).map((tool) => tool.name)).not.toContain('delegate_to_agent');
    expect(agentToolsFor(true, false, true).map((tool) => tool.name)).not.toContain(
      'approve_merge',
    );
    expect(agentToolsFor(true, false, true, true).map((tool) => tool.name)).toContain(
      'approve_merge',
    );
    expect(agentToolsFor(true, false, false, true).map((tool) => tool.name)).not.toContain(
      'approve_merge',
    );
  });

  it('advertises the memory tools by default and hides them only when explicitly disabled', () => {
    const byDefault = agentToolsFor(true, false).map((tool) => tool.name);
    expect(byDefault).toContain('propose_memory_item');
    expect(byDefault).toContain('search_history');
    expect(byDefault).toContain('search_memory');
    expect(byDefault).toContain('load_workspace_skill');
    expect(byDefault).toContain('save_skill');
    expect(byDefault).toContain('save_workflow');
    expect(byDefault).toContain('start_workflow');
    expect(byDefault).toContain('handoff');
    expect(byDefault).toContain('archive_workflow');
    expect(byDefault).toContain('assign_workflow_role');
    const disabled = agentToolsFor(true, false, false, false, true, false, false).map(
      (tool) => tool.name,
    );
    expect(disabled).not.toContain('propose_memory_item');
    expect(disabled).not.toContain('search_history');
    expect(disabled).not.toContain('search_memory');
    expect(disabled).not.toContain('load_workspace_skill');
    expect(disabled).not.toContain('save_skill');
    expect(disabled).not.toContain('save_workflow');
    expect(disabled).not.toContain('start_workflow');
    expect(disabled).not.toContain('handoff');
    expect(disabled).not.toContain('archive_workflow');
    expect(disabled).not.toContain('assign_workflow_role');
    const enabled = agentToolsFor(true, false, false, false, true, false, true).map(
      (tool) => tool.name,
    );
    expect(enabled).toContain('propose_memory_item');
    expect(enabled).toContain('search_history');
    expect(enabled).toContain('search_memory');
    expect(enabled).toContain('load_workspace_skill');
    expect(enabled).toContain('save_skill');
    expect(enabled).toContain('save_workflow');
    expect(enabled).toContain('start_workflow');
    expect(enabled).toContain('handoff');
    expect(enabled).toContain('archive_workflow');
    expect(enabled).toContain('assign_workflow_role');
    const proposal = agentToolsFor(true, false).find((tool) => tool.name === 'propose_memory_item');
    expect(proposal?.inputSchema.required).toContain('subject_is_requester');
    expect(proposal?.inputSchema.properties).not.toHaveProperty('memory_kind');
  });

  it('tells the agent to call search_memory before ever saying a fact was never saved', () => {
    const searchMemory = agentToolsFor(true, false).find((tool) => tool.name === 'search_memory');
    expect(searchMemory?.description).toContain(SEARCH_MEMORY_FIRST_RULE);
  });
});

describe('approve_merge surface', () => {
  const names = (cornerTurn: boolean, codeLane: boolean, institutionalMemory: boolean) =>
    agentToolsFor(true, false, cornerTurn, codeLane, true, cornerTurn, institutionalMemory).map(
      (tool) => tool.name,
    );

  it('mounts on every code-lane corner turn, whoever the session booted as', () => {
    // The Sol case: the configured reviewer's session did not boot as the
    // reviewer and institutional memory is off, yet it can still record PASS.
    expect(names(true, true, false)).toContain('approve_merge');
    expect(names(true, true, true)).toContain('approve_merge');
  });

  it('stays off no-code and research corners and outside corners', () => {
    // Only the code lane sets codeLane; no_code and research never do.
    for (const memory of [false, true]) {
      expect(names(true, false, memory)).not.toContain('approve_merge');
      expect(names(false, false, memory)).not.toContain('approve_merge');
      expect(names(false, true, memory)).not.toContain('approve_merge');
    }
    expect(agentToolsFor(true, true, false, true).map((tool) => tool.name)).not.toContain(
      'approve_merge',
    );
    expect(agentToolsFor(false, false, true, true).map((tool) => tool.name)).not.toContain(
      'approve_merge',
    );
  });

  it('says the server merges and rejects the wrong caller, head, or revision', () => {
    const tool = agentToolsFor(true, false, true, true).find(
      (entry) => entry.name === 'approve_merge',
    )!;
    expect(tool.description).toContain('exact pull-request head and brief revision');
    expect(tool.description).toContain('The server then squash-merges that head itself');
    expect(tool.description).toContain('not the parent Room’s configured reviewer');
    expect(tool.description).toContain('not the pull request’s current head');
    expect(tool.description).toContain('a stale brief revision');
    expect(tool.description).toContain('Do not tell the author to merge.');
    expect(tool.description).not.toContain('clearance to merge');
  });
});

describe('corner lifecycle tool surfaces', () => {
  it('advertises open and close only where each operation can succeed', () => {
    const room = agentToolsFor(true, false);
    const directMessage = agentToolsFor(true, true);
    const corner = agentToolsFor(true, false, true);
    const reviewerCorner = agentToolsFor(true, false, true, true);

    for (const tools of [room, directMessage]) {
      expect(tools.map((tool) => tool.name)).not.toContain('close_corner');
    }
    expect(room.map((tool) => tool.name)).toContain('open_corner');
    expect(directMessage.map((tool) => tool.name)).not.toContain('open_corner');

    for (const tools of [corner, reviewerCorner]) {
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('close_corner');
      expect(names).toContain('publish_corner_app');
      expect(names).toContain('open_corner_app');
      expect(names).toContain('rename_corner');
      expect(names).toContain('open_corner');
    }
    const noCodeCorner = agentToolsFor(true, false, true, false, true, false);
    expect(noCodeCorner.map((tool) => tool.name)).not.toContain('close_corner');
    expect(noCodeCorner.map((tool) => tool.name)).not.toContain('upgrade_corner_to_code');
    expect(noCodeCorner.map((tool) => tool.name)).toContain('post_artifact');
    const upgradeableCorner = agentToolsFor(true, false, true, false, true, false, false, true);
    expect(upgradeableCorner.map((tool) => tool.name)).toContain('upgrade_corner_to_code');
    expect(room.map((tool) => tool.name)).not.toContain('upgrade_corner_to_code');
    for (const tools of [room, directMessage]) {
      expect(tools.map((tool) => tool.name)).not.toContain('publish_corner_app');
      expect(tools.map((tool) => tool.name)).not.toContain('open_corner_app');
      expect(tools.map((tool) => tool.name)).not.toContain('rename_corner');
    }
  });
});

describe('open_corner arguments', () => {
  const openCorner = () => agentToolsFor(true, false).find((tool) => tool.name === 'open_corner')!;

  it('asks for a name and says the three-word limit plainly', () => {
    const schema = openCorner().inputSchema as {
      required: string[];
      properties: Record<string, { maxLength?: number; description?: string }>;
    };
    expect(schema.required).toEqual(['name', 'objective']);
    expect(openCorner().description).toContain('AT MOST THREE WORDS');
    expect(openCorner().description).toContain(
      'Supply a compact brief for a precise small fix or a complete brief and Room files for complex work.',
    );
    expect(openCorner().description).toContain('after any material unresolved choice is settled');
    expect(schema.properties.name?.description).toBe(
      "The corner's title: at most 3 words, no line breaks.",
    );
    const brief = schema.properties.brief as unknown as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(brief.required).toEqual([
      'intentVerbatim',
      'buildSpec',
      'criteria',
      'references',
      'approvalBasis',
    ]);
    expect(Object.keys(brief.properties)).not.toContain('content');
  });

  it('flattens an untidy call instead of refusing it', () => {
    // A grok-shaped call: the brief arrives with its line breaks intact.
    expect(
      cornerCallText({
        name: ' widget \n ledger ',
        objective: 'Ship the corner name parameter.\nMake grok able to open a corner.',
      }),
    ).toEqual({
      name: 'widget ledger',
      objective: 'Ship the corner name parameter. Make grok able to open a corner.',
    });
  });

  it('refuses only what is genuinely too long, in a sentence naming the count', () => {
    expect(() =>
      cornerCallText({
        name: 'far too many words here',
        objective: 'Ship the widget',
      }),
    ).toThrow('the name is 5 words; the limit is 3');
    expect(() =>
      cornerCallText({
        name: 'widget ledger',
        objective: Array.from({ length: 61 }, (_, index) => `word${index}`).join(' '),
      }),
    ).toThrow('the objective is 61 words; the limit is 24');
    expect(() => cornerCallText({ objective: 'Ship the widget' })).toThrow(
      'the name is required; give a title of at most 3 words',
    );
  });
});

it('advertises deliberate corner reads, steers, and questions only in Rooms', () => {
  expect(agentToolsFor(true, false).map((t) => t.name)).toContain('steer_corner');
  expect(agentToolsFor(true, false).map((t) => t.name)).toContain('ask_corner');
  expect(agentToolsFor(true, false).map((t) => t.name)).toContain('get_corner_ask');
  expect(agentToolsFor(true, false).map((t) => t.name)).toContain('inspect_corner');
  expect(agentToolsFor(true, false).map((t) => t.name)).not.toContain('report_to_room');
  expect(agentToolsFor(true, false, true).map((t) => t.name)).not.toContain('report_to_room');
  expect(agentToolsFor(true, false, true).map((t) => t.name)).not.toContain('steer_corner');
  expect(agentToolsFor(true, true).map((t) => t.name)).not.toContain('steer_corner');
  expect(agentToolsFor(true, false, true).map((t) => t.name)).not.toContain('ask_corner');
  expect(agentToolsFor(true, false, true).map((t) => t.name)).not.toContain('get_corner_ask');
  expect(agentToolsFor(true, true).map((t) => t.name)).not.toContain('inspect_corner');
  const room = assembleSessionPrompt({ surface: 'room', agentName: 'Bee' }).systemPrompt;
  expect(room).toContain('ask_corner for one answer');
  expect(room).toContain('steer_corner to pass Room input down');
  expect(room).toContain('inspect_corner for status');
  const dm = assembleSessionPrompt({ surface: 'dm', agentName: 'Bee' }).systemPrompt;
  expect(dm).not.toContain('ask_corner');
  expect(dm).not.toContain('steer_corner');
  for (const source of ['./monolith-corner-turn.ts', './prompt-assembly.ts']) {
    const cornerPrompt = readFileSync(new URL(source, import.meta.url), 'utf8');
    expect(cornerPrompt).not.toContain('report_to_room');
    expect(cornerPrompt).not.toContain('report the tool reason to the Room');
  }
});
