import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newIdentity, publishEvent } from '@beeline/gate';
import type { NostrEvent } from '@beeline/nostr';
import type { AcpClient, SessionUpdate } from './acp.js';

const mocks = vi.hoisted(() => ({
  published: [] as NostrEvent[],
}));

vi.mock('@beeline/gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@beeline/gate')>()),
  publishEvent: vi.fn(async (event: NostrEvent) => {
    mocks.published.push(event);
    return { ok: true };
  }),
}));

import {
  projectActivity,
  createDraftStreamer,
  compactActivityUpdate,
  AGENT_DRAFT_FLUSH_MS,
  nextNarrativeSegment,
  createNarrativeCommitter,
  NARRATIVE_SEGMENT_MAX_CHARS,
  AGENT_MESSAGE_TAG,
  postAgentMessage,
} from './activity.js';
import { KIND_AGENT_DRAFT, TAG_AGENT_DRAFT } from '@beeline/buzz-client';

const published = mocks.published;

function toolCall(
  toolCallId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { sessionUpdate: 'tool_call', toolCallId, status: 'pending', ...overrides };
}

function toolCallUpdate(
  toolCallId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { sessionUpdate: 'tool_call_update', toolCallId, ...overrides };
}

describe('projectActivity granularity', () => {
  const channelId = 'channel-1';
  const sessionId = 'session-1';
  let owner: ReturnType<typeof newIdentity>;
  let client: EventEmitter;

  beforeEach(() => {
    published.length = 0;
    owner = newIdentity('agent');
    client = new EventEmitter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function emit(update: Record<string, unknown>): void {
    client.emit('session/update', { sessionId, update } satisfies SessionUpdate);
  }

  it('suppresses MCP, shell output, and reasoning while projecting an inspectable edit milestone', async () => {
    const unsubscribe = projectActivity(client as unknown as AcpClient, channelId, owner, sessionId);

    // Reasoning / planning noise, including the bare ACP names sent by some agents.
    emit({ sessionUpdate: 'agent_thought_chunk', content: 'Let me think about this…' });
    emit({ sessionUpdate: 'reasoning', content: 'I should inspect the codegraph first.' });
    emit({ sessionUpdate: 'plan', entries: [{ content: 'inspect the repo' }] });

    // MCP and raw shell calls/results must remain private implementation detail.
    emit(
      toolCall('codegraph-1', {
        kind: 'execute',
        title: 'mcp.codegraph.codegraph_context',
        rawInput: { server: 'codegraph', tool: 'codegraph_context', arguments: { query: 'activity' } },
      }),
    );
    emit(
      toolCallUpdate('codegraph-1', {
        status: 'completed',
        output: 'mcp.codegraph.codegraph_explore raw graph output',
      }),
    );
    emit(toolCall('search-1', { kind: 'search', title: 'grep for TODO' }));
    emit(toolCallUpdate('search-1', { status: 'completed', kind: 'search' }));
    emit(
      toolCall('shell-1', {
        kind: 'execute',
        title: 'shell',
        rawInput: { command: "sed -n '1,140p' apps/body/src/activity.ts" },
      }),
    );
    emit(toolCallUpdate('shell-1', { status: 'completed', output: 'const rawOutput = true;' }));
    emit(
      toolCall('shell-2', {
        kind: 'execute',
        title: 'shell',
        rawInput: { command: 'rg -n "activity_batch" apps/body/src' },
      }),
    );
    emit(toolCallUpdate('shell-2', { status: 'completed', output: 'apps/body/src/activity.ts:activity_batch' }));

    // The one load-bearing edit.
    emit(toolCall('edit-1', { kind: 'edit', title: 'str_replace', rawInput: { path: 'src/activity.ts' } }));
    emit(toolCallUpdate('edit-1', { status: 'completed' }));

    await vi.advanceTimersByTimeAsync(5_000);
    unsubscribe();

    expect(published).toHaveLength(1);
    const content = JSON.parse(published[0]!.content) as {
      update: { updates: Array<Record<string, unknown>> };
    };
    const updates = content.update.updates;

    // Only an inspectable edit milestone plus a synthesized summary line —
    // the non-major MCP/search/shell noise above never reaches the wire, but
    // the surviving edit's own detail (files, redacted input) is present so
    // the corner drill-down can inspect it.
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({
      sessionUpdate: 'tool_activity',
      toolCallId: 'edit-1',
      title: 'Edited src/activity.ts',
      kind: 'edit',
      status: 'completed',
      input: expect.stringContaining('"path": "src/activity.ts"'),
      files: [{ path: 'src/activity.ts' }],
    });
    expect(updates[1]).toMatchObject({ sessionUpdate: 'activity_summary' });
    const summaryText = (updates[1] as { content: { text: string } }).content.text;
    expect(summaryText).toBe('Edited src/activity.ts');
    const projection = JSON.stringify(content);
    for (const leaked of [
      'mcp.codegraph',
      'sed -n',
      'rg -n',
      'rawOutput',
      'reasoning',
      'str_replace',
    ]) {
      expect(projection).not.toContain(leaked);
    }
  });

  it('surfaces a failed test suite as an inspectable blocker with its command and output', async () => {
    const unsubscribe = projectActivity(client as unknown as AcpClient, channelId, owner, sessionId);

    emit(
      toolCall('test-err', {
        kind: 'execute',
        title: 'shell',
        rawInput: { command: 'npm test -- --run activity.test.ts' },
      }),
    );
    emit(toolCallUpdate('test-err', { status: 'failed', output: 'raw test failure output' }));

    await vi.advanceTimersByTimeAsync(5_000);
    unsubscribe();

    expect(published).toHaveLength(1);
    const content = JSON.parse(published[0]!.content) as {
      update: { updates: Array<Record<string, unknown>> };
    };
    expect(content.update.updates).toEqual([
      {
        sessionUpdate: 'tool_activity',
        toolCallId: 'test-err',
        title: 'Ran the test suite failed',
        kind: 'execute',
        status: 'failed',
        command: 'npm test -- --run activity.test.ts',
        input: expect.stringContaining('"command": "npm test -- --run activity.test.ts"'),
        output: 'raw test failure output',
      },
      {
        sessionUpdate: 'activity_summary',
        content: { type: 'text', text: 'Ran the test suite failed' },
      },
    ]);
  });

  it('publishes a bare tally, not silence, when a batch only observed', async () => {
    const unsubscribe = projectActivity(client as unknown as AcpClient, channelId, owner, sessionId);

    emit({ sessionUpdate: 'agent_thought_chunk', content: 'inspecting the code' });
    emit(toolCall('search-only', { kind: 'search', title: 'search_text' }));
    emit(toolCallUpdate('search-only', { status: 'completed' }));

    await vi.advanceTimersByTimeAsync(5_000);
    unsubscribe();

    // Reads and searches still never get their own wire event — that is what
    // keeps a research-heavy turn under the per-pubkey relay quota. What they
    // now get is a count, on the one summary event, so a long research phase
    // reads as work in progress instead of as dead air. Exactly one event,
    // where a mixed batch already costs exactly one.
    expect(published).toHaveLength(1);
    const content = JSON.parse(published[0]!.content) as {
      update: { updates: Array<Record<string, unknown>> };
    };
    expect(content.update.updates).toEqual([
      {
        sessionUpdate: 'activity_summary',
        content: { type: 'text', text: '' },
        rollup: { searched: 1 },
      },
    ]);
    // Reasoning is still never counted, and never projected.
    expect(JSON.stringify(content)).not.toContain('inspecting the code');
  });

  it('collapses a reasoning stretch to a bare elapsed receipt, never its content', async () => {
    const unsubscribe = projectActivity(client as unknown as AcpClient, channelId, owner, sessionId);

    // grok Build shows a live `Thinking…` block for the whole stretch and then
    // collapses it to `Thought for 5.8s` the instant the answer lands. Only
    // the second half is affordable here: reasoning text is unbounded and
    // would blow the per-pubkey quota, so the span rides the summary event
    // that is published anyway and the content never leaves the daemon.
    emit({ sessionUpdate: 'agent_thought_chunk', content: 'the median bug is the even-length case' });
    await vi.advanceTimersByTimeAsync(2_000);
    emit({ sessionUpdate: 'agent_thought_chunk', content: 'and mean([]) divides by zero' });
    emit(toolCall('read-1', { kind: 'read', title: 'read_file' }));
    emit(toolCallUpdate('read-1', { status: 'completed' }));

    await vi.advanceTimersByTimeAsync(5_000);
    unsubscribe();

    expect(published).toHaveLength(1);
    const content = JSON.parse(published[0]!.content) as {
      update: { updates: Array<Record<string, unknown>> };
    };
    expect(content.update.updates).toEqual([
      {
        sessionUpdate: 'activity_summary',
        content: { type: 'text', text: '' },
        rollup: { read: 1 },
        thoughtMs: 2_000,
      },
    ]);
    expect(JSON.stringify(content)).not.toContain('divides by zero');
  });

  it('carries one reasoning span across batches instead of reporting it per window', async () => {
    const unsubscribe = projectActivity(client as unknown as AcpClient, channelId, owner, sessionId);

    // A think that outlasts the 5s batch window used to have no way to be
    // reported at all. It must not become one receipt per window either: the
    // span closes when work lands, which is the same trigger grok uses.
    emit({ sessionUpdate: 'agent_thought_chunk', content: 'still working it out' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(published).toHaveLength(0);

    emit({ sessionUpdate: 'agent_thought_chunk', content: 'got it' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(published).toHaveLength(0);

    emit(toolCall('read-2', { kind: 'read', title: 'read_file' }));
    emit(toolCallUpdate('read-2', { status: 'completed' }));
    await vi.advanceTimersByTimeAsync(5_000);
    unsubscribe();

    // One receipt, spanning first thought to last (0ms -> 6000ms) — not one
    // per 5s window, and not stretched to the flush that happened to carry it.
    expect(published).toHaveLength(1);
    const content = JSON.parse(published[0]!.content) as {
      update: { updates: Array<Record<string, unknown>> };
    };
    expect(content.update.updates.at(-1)).toMatchObject({
      sessionUpdate: 'activity_summary',
      thoughtMs: 6_000,
    });
  });

  it('omits the receipt for a think too short to be worth reporting', async () => {
    const unsubscribe = projectActivity(client as unknown as AcpClient, channelId, owner, sessionId);

    emit({ sessionUpdate: 'agent_thought_chunk', content: 'a' });
    await vi.advanceTimersByTimeAsync(100);
    emit({ sessionUpdate: 'agent_thought_chunk', content: 'b' });
    emit(toolCall('read-3', { kind: 'read', title: 'read_file' }));
    emit(toolCallUpdate('read-3', { status: 'completed' }));

    await vi.advanceTimersByTimeAsync(5_000);
    unsubscribe();

    const content = JSON.parse(published[0]!.content) as {
      update: { updates: Array<Record<string, unknown>> };
    };
    expect(content.update.updates.at(-1)!.thoughtMs).toBeUndefined();
  });

  it('never counts a published milestone as an anonymous observational call', async () => {
    const unsubscribe = projectActivity(client as unknown as AcpClient, channelId, owner, sessionId);

    // The major branch clears this call's tracked kind/command once it has been
    // published, so anything re-classifying the same event afterwards sees an
    // anonymous delta and tallies the milestone a second time.
    emit(
      toolCall('test-1', {
        kind: 'execute',
        title: 'shell',
        rawInput: { command: 'npm test -- --run' },
      }),
    );
    emit(toolCallUpdate('test-1', { status: 'completed', output: 'ok' }));

    await vi.advanceTimersByTimeAsync(5_000);
    unsubscribe();

    const content = JSON.parse(published[0]!.content) as {
      update: { updates: Array<Record<string, unknown>> };
    };
    const summary = content.update.updates.at(-1)!;
    expect(summary.sessionUpdate).toBe('activity_summary');
    expect(summary.rollup).toBeUndefined();
  });
});

describe('compactActivityUpdate', () => {
  it('drops reasoning and startup-only telemetry from the Room projection', () => {
    expect(
      compactActivityUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'private chain of thought' },
      }),
    ).toBeUndefined();
    expect(
      compactActivityUpdate({ sessionUpdate: 'session_info_update', model: 'codex' }),
    ).toBeUndefined();
  });

  it('projects commands, output, edited files, and plans without sensitive input', () => {
    expect(
      compactActivityUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Apply patch',
        kind: 'edit',
        status: 'completed',
        rawInput: {
          command: 'npm test',
          token: 'do-not-project-me',
          changes: [{ path: 'apps/mobile/chat.tsx', patch: 'diff --git a/chat b/chat' }],
          plan: [
            { step: 'Implement projection', status: 'completed' },
            { step: 'Run tests', status: 'in_progress' },
          ],
        },
        rawOutput: '12 tests passed',
      }),
    ).toEqual({
      sessionUpdate: 'tool_activity',
      toolCallId: 'call-1',
      title: 'Apply patch',
      kind: 'edit',
      status: 'completed',
      command: 'npm test',
      input: expect.stringContaining('"token": "[redacted]"'),
      output: '12 tests passed',
      files: [
        {
          path: 'apps/mobile/chat.tsx',
          diff: 'diff --git a/chat b/chat',
        },
      ],
      plan: {
        items: [
          { step: 'Implement projection', status: 'completed' },
          { step: 'Run tests', status: 'in_progress' },
        ],
      },
    });
  });

  it('keeps concise natural-language progress while stripping a leading harness notice', () => {
    expect(
      compactActivityUpdate({
        sessionUpdate: 'status_update',
        content:
          'Warning: tool descriptions exceed the context budget limit\n\nFound the rendering boundary.',
      }),
    ).toEqual({
      sessionUpdate: 'progress_update',
      text: 'Found the rendering boundary.',
    });
  });

  it('extracts real per-file patches from apply_patch input', () => {
    expect(
      compactActivityUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'patch-1',
        title: 'apply_patch',
        kind: 'edit',
        rawInput:
          '*** Begin Patch\n*** Update File: apps/mobile/chat.tsx\n@@\n-old\n+new\n*** End Patch',
      }),
    ).toMatchObject({
      files: [
        {
          path: 'apps/mobile/chat.tsx',
          status: 'modified',
          diff: expect.stringContaining('@@\n-old\n+new'),
        },
      ],
    });
  });
});

describe('createDraftStreamer', () => {
  const channelId = 'channel-1';
  const sessionId = 'session-1';
  const requestId = 'request-1';
  let owner: ReturnType<typeof newIdentity>;

  beforeEach(() => {
    published.length = 0;
    owner = newIdentity('agent');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces bursts of chunks into one replaceable publish per flush window', async () => {
    const streamer = createDraftStreamer(channelId, owner, sessionId, requestId);

    streamer.onChunk('Hel');
    streamer.onChunk('Hello');
    streamer.onChunk('Hello wor');
    await vi.advanceTimersByTimeAsync(AGENT_DRAFT_FLUSH_MS);

    expect(published).toHaveLength(1);
    const event = published[0]!;
    expect(event.kind).toBe(KIND_AGENT_DRAFT);
    expect(event.content).toBe('Hello wor');
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['d', `${TAG_AGENT_DRAFT}:${channelId}`],
        ['h', channelId],
        ['t', TAG_AGENT_DRAFT],
        ['session', sessionId],
        ['request', requestId],
      ]),
    );

    streamer.onChunk('Hello world');
    await streamer.finish();
    expect(published).toHaveLength(2);
    expect(published[1]!.content).toBe('Hello world');
  });

  it('finish() flushes trailing text even before the coalescing window elapses', async () => {
    const streamer = createDraftStreamer(channelId, owner, sessionId, requestId);
    streamer.onChunk('done');
    await streamer.finish();
    expect(published).toHaveLength(1);
    expect(published[0]!.content).toBe('done');
  });

  it('publishes nothing when no chunk ever arrives (non-streaming harness degrades silently)', async () => {
    const streamer = createDraftStreamer(channelId, owner, sessionId, requestId);
    await streamer.finish();
    expect(published).toHaveLength(0);
  });

  it('skips a flush when the text has not changed since the last publish', async () => {
    const streamer = createDraftStreamer(channelId, owner, sessionId, requestId);
    streamer.onChunk('same');
    await vi.advanceTimersByTimeAsync(AGENT_DRAFT_FLUSH_MS);
    expect(published).toHaveLength(1);

    streamer.onChunk('same');
    await streamer.finish();
    expect(published).toHaveLength(1);
  });
});

describe('nextNarrativeSegment', () => {
  it('returns undefined for an empty or already-fully-committed tail', () => {
    expect(nextNarrativeSegment('', 0)).toBeUndefined();
    expect(nextNarrativeSegment('done', 4)).toBeUndefined();
  });

  it('returns undefined while a short paragraph is still growing', () => {
    expect(nextNarrativeSegment('Looking at the failing test', 0)).toBeUndefined();
  });

  it('cuts at the last paragraph break, leaving the growing tail uncommitted', () => {
    const fullText = "I'll start by reproducing the bug.\n\nFound it in the parser, fixing now.";
    const segment = nextNarrativeSegment(fullText, 0);
    expect(segment?.text).toBe("I'll start by reproducing the bug.");
    expect(segment?.consumed).toBe(fullText.indexOf('Found it'));

    // The remaining tail has no paragraph break yet, so nothing new commits.
    expect(nextNarrativeSegment(fullText, segment!.consumed)).toBeUndefined();
  });

  it('advances from an already-committed offset as each new paragraph completes', () => {
    // Mirrors how text actually arrives: one paragraph break exists at a
    // time when nextNarrativeSegment is called against the growing text.
    const afterFirst = 'First paragraph.\n\nstill typing the second';
    const first = nextNarrativeSegment(afterFirst, 0)!;
    expect(first.text).toBe('First paragraph.');
    expect(nextNarrativeSegment(afterFirst, first.consumed)).toBeUndefined();

    const afterSecond = 'First paragraph.\n\nSecond paragraph.\n\nstill typing the third';
    const second = nextNarrativeSegment(afterSecond, first.consumed)!;
    expect(second.text).toBe('Second paragraph.');
    expect(nextNarrativeSegment(afterSecond, second.consumed)).toBeUndefined();
  });

  it('batches every already-complete paragraph when called against text that grew all at once', () => {
    // A single nextNarrativeSegment call cuts at the LAST paragraph break in
    // the uncommitted tail, so paragraphs that arrived together (rather than
    // being observed one at a time) land as one segment, not several.
    const fullText = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph is still typing';
    const segment = nextNarrativeSegment(fullText, 0)!;
    expect(segment.text).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('falls back to a sentence boundary once a single paragraph runs past the ceiling', () => {
    const sentence = 'This keeps going without a paragraph break. ';
    const fullText = sentence.repeat(Math.ceil((NARRATIVE_SEGMENT_MAX_CHARS + 20) / sentence.length));
    const segment = nextNarrativeSegment(fullText, 0);
    expect(segment).toBeDefined();
    expect(segment!.consumed).toBeLessThanOrEqual(NARRATIVE_SEGMENT_MAX_CHARS);
    expect(segment!.text.endsWith('.')).toBe(true);
    expect(segment!.text).not.toContain('\n');
  });
});

describe('createNarrativeCommitter', () => {
  const channelId = 'channel-1';
  let owner: ReturnType<typeof newIdentity>;

  beforeEach(() => {
    published.length = 0;
    owner = newIdentity('agent');
  });

  /** Flush every queued microtask (the inflight publish chain), not just one tick. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('durably commits each paragraph as its own message while the turn is still running', async () => {
    const narrator = createNarrativeCommitter(channelId, owner);

    narrator.onChunk("I'll start by reproducing the bug.");
    await flush();
    expect(published).toHaveLength(0); // still one growing paragraph, nothing to commit yet

    narrator.onChunk(
      "I'll start by reproducing the bug.\n\nFound it in the parser, fixing now.",
    );
    await flush();
    expect(published).toHaveLength(1);
    expect(published[0]!.content).toBe("I'll start by reproducing the bug.");
    expect(published[0]!.kind).toBe(9);
    expect(published[0]!.tags).toContainEqual(['t', AGENT_MESSAGE_TAG]);
    expect(published[0]!.tags.some((tag) => tag[0] === 'e')).toBe(false);

    narrator.onChunk(
      "I'll start by reproducing the bug.\n\nFound it in the parser, fixing now.\n\nFixed and tests pass.",
    );
    await flush();
    expect(published).toHaveLength(2);
    expect(published[1]!.content).toBe('Found it in the parser, fixing now.');

    await narrator.finish();
    expect(published).toHaveLength(3);
    expect(published[2]!.content).toBe('Fixed and tests pass.');
  });

  it('never publishes a leading harness/system boilerplate segment (Codex skill-budget warning)', async () => {
    const narrator = createNarrativeCommitter(channelId, owner);
    const warning =
      'Warning: Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill by reading its SKILL.md.';

    narrator.onChunk(`${warning}\n\n`);
    await flush();
    expect(published).toHaveLength(0); // pure boilerplate — never surfaces as narration

    narrator.onChunk(
      `${warning}\n\nI'm adding the requested one-line description, then I'll verify the build.`,
    );
    await narrator.finish();

    expect(published).toHaveLength(1);
    expect(published[0]!.content).toBe(
      "I'm adding the requested one-line description, then I'll verify the build.",
    );
    expect(published[0]!.content).not.toContain('skills context budget');
  });

  it('strips a leading boilerplate notice even when the first real paragraph lands in the same chunk', async () => {
    // The whole "boilerplate\n\nreal text" blob can arrive as one delta
    // rather than two separate onChunk calls — the filter must still only
    // remove the boilerplate line, not the real narration after it.
    const narrator = createNarrativeCommitter(channelId, owner);
    const warning = 'Notice: Tool descriptions were shortened because of the context budget limit.';
    narrator.onChunk(`${warning}\nCodex can still access every tool.\n\nReproducing the bug now.\n\n`);
    await narrator.finish();

    expect(published).toHaveLength(1);
    expect(published[0]!.content).toBe('Reproducing the bug now.');
  });

  it('never publishes pi-acp\'s quiet-mode version-update banner', async () => {
    const narrator = createNarrativeCommitter(channelId, owner);
    const banner =
      'New version available: v0.84.2 (installed v0.83.0). Run: `npm i -g @earendil-works/pi-coding-agent`';

    narrator.onChunk(`${banner}\n\nI'll start by reproducing the bug.\n\n`);
    await narrator.finish();

    expect(published).toHaveLength(1);
    expect(published[0]!.content).toBe("I'll start by reproducing the bug.");
  });

  it("never publishes pi-acp's full startup block (skill/context paths, version banner), and streams real narration progressively once boilerplate is skipped", async () => {
    // pi-acp emits the whole startup block (version line, Context/Skills/
    // Extensions path dumps, trailing update notice) as one atomic leading
    // agent_message_chunk. Its own internal blank lines create a paragraph
    // break inside the block, so a later segment can begin mid-block (e.g.
    // just `---\n<notice>`) rather than at the true start of the message.
    const narrator = createNarrativeCommitter(channelId, owner);
    const startup =
      [
        'pi v0.83.0',
        '---',
        '',
        '## Context',
        '- /home/lunchbox/repo/.git/beeline/worktrees/corner-42/AGENTS.md',
        '',
        '## Skills',
        '- ~/.agents/skills/investigate/SKILL.md',
        '- ~/.agents/skills/code-review/SKILL.md',
        '',
        '## Extensions',
        '- /home/lunchbox/.pi/agent/extensions/foo.ts',
        '',
        '---',
        'New version available: v0.84.2 (installed v0.83.0). Run: `npm i -g @earendil-works/pi-coding-agent`',
      ].join('\n') + '\n';

    // The whole startup block lands before any real narration exists —
    // nothing durable yet, even though the block contains its own paragraph
    // breaks.
    narrator.onChunk(startup);
    await flush();
    expect(published).toHaveLength(0);

    // Real narration streams in afterward across further onChunk calls,
    // exactly like the harness-agnostic committer already handles — this is
    // the "progressive segments commit as chunks arrive" contract.
    narrator.onChunk(`${startup}I'll start by reproducing the bug.`);
    await flush();
    expect(published).toHaveLength(0); // still one growing paragraph

    narrator.onChunk(`${startup}I'll start by reproducing the bug.\n\nFound it in the parser.`);
    await flush();
    expect(published).toHaveLength(1);
    expect(published[0]!.content).toBe("I'll start by reproducing the bug.");

    await narrator.finish();
    expect(published).toHaveLength(2);
    expect(published[1]!.content).toBe('Found it in the parser.');

    for (const event of published) {
      expect(event.content).not.toMatch(
        /\.git\/beeline|SKILL\.md|New version available|^pi v0\.83\.0/,
      );
    }
  });

  it('does not filter real narration that happens to open with a bulleted list', async () => {
    // The pi-boilerplate bullet filter only fires inside a recognized
    // Context/Skills/Prompts/Extensions section — a genuine narration bullet
    // list with no such header must pass through untouched.
    const narrator = createNarrativeCommitter(channelId, owner);
    narrator.onChunk(
      '- Investigated the auth flow\n- Found the bug in the token refresh path\n\nFixing now.\n\n',
    );
    await narrator.finish();

    expect(published.map((event) => event.content)).toEqual([
      '- Investigated the auth flow\n- Found the bug in the token refresh path\n\nFixing now.',
    ]);
  });

  it('does not double-publish a segment when finish() runs right after a boundary already committed it', async () => {
    const narrator = createNarrativeCommitter(channelId, owner);
    narrator.onChunk('Reproducing the bug now.\n\n');
    await flush();
    await narrator.finish();

    expect(published).toHaveLength(1);
    expect(published[0]!.content).toBe('Reproducing the bug now.');
  });

  it('does not re-publish a segment when the harness resends an already-committed delta', async () => {
    // Reproduces the on-device defect: two distinct kind:9 events carried
    // identical content at an identical created_at because the ACP layer
    // replayed the same agent_message_chunk delta, re-presenting an
    // already-committed paragraph as if it were new growth.
    const narrator = createNarrativeCommitter(channelId, owner);
    narrator.onChunk('Reproducing the bug now.\n\n');
    await flush();
    expect(published).toHaveLength(1);

    // The harness resent the same paragraph; the accumulated text now
    // contains it twice in a row.
    narrator.onChunk('Reproducing the bug now.\n\nReproducing the bug now.\n\n');
    await narrator.finish();

    expect(published).toHaveLength(1);
    expect(published[0]!.content).toBe('Reproducing the bug now.');
  });

  it('still publishes a legitimately repeated short line later in a long turn', async () => {
    // The dedup guard is adjacent-only — it must not suppress a real,
    // separately-written recurrence of the same short text later on.
    const narrator = createNarrativeCommitter(channelId, owner);
    narrator.onChunk('Done.\n\n');
    await flush();
    narrator.onChunk('Done.\n\nChecked the diff once more.\n\n');
    await flush();
    narrator.onChunk('Done.\n\nChecked the diff once more.\n\nDone.');
    await narrator.finish();

    expect(published.map((event) => event.content)).toEqual([
      'Done.',
      'Checked the diff once more.',
      'Done.',
    ]);
  });

  it('finish() flushes a still-growing tail even without a paragraph break', async () => {
    const narrator = createNarrativeCommitter(channelId, owner);
    narrator.onChunk('Wrapping up the change now.');
    await narrator.finish();
    expect(published).toHaveLength(1);
    expect(published[0]!.content).toBe('Wrapping up the change now.');
  });

  it('publishes nothing when the turn never produced narrative text', async () => {
    const narrator = createNarrativeCommitter(channelId, owner);
    await narrator.finish();
    expect(published).toHaveLength(0);
    expect(narrator.lastCreatedAt()).toBe(0);
  });

  it('publishes segments in order even when the first relay write is slow', async () => {
    // The in-order `inflight` chain (not raw promise resolution order)
    // must determine what lands where, mirroring createDraftStreamer.
    vi.mocked(publishEvent).mockImplementationOnce(async (event: NostrEvent) => {
      await new Promise((r) => setTimeout(r, 20));
      mocks.published.push(event);
      return { ok: true } as never;
    });

    const narrator = createNarrativeCommitter(channelId, owner);
    narrator.onChunk('First paragraph.\n\nstill typing');
    narrator.onChunk('First paragraph.\n\nSecond paragraph.\n\nstill typing');
    await narrator.finish();

    expect(published.map((event) => event.content)).toEqual([
      'First paragraph.',
      'Second paragraph.',
      'still typing',
    ]);
  });

  it('bumps created_at strictly past the prior segment even within the same wall-clock second', async () => {
    // Mobile's transcript sorts by created_at with an id-hash tie-break on an
    // exact tie — same-second segments must still land in written order.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const narrator = createNarrativeCommitter(channelId, owner);
      narrator.onChunk('First paragraph.\n\nstill typing');
      narrator.onChunk('First paragraph.\n\nSecond paragraph.\n\nstill typing');
      await narrator.finish();

      expect(published).toHaveLength(3);
      const timestamps = published.map((event) => event.created_at);
      expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
      expect(new Set(timestamps).size).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes lastCreatedAt() so a trailing publish (the corner end-of-turn summary) can be threaded strictly after the final segment, even in the same wall-clock second', async () => {
    // Reproduces the on-relay defect: a fast corner turn's narrative
    // segments and its separate trailing `publishAgentResult` summary landed
    // at the identical integer created_at (1786919814 in the field report),
    // so the completion line sorted before the intro line. The fix threads
    // the narrator's monotonic counter (lastCreatedAt(), read only after
    // finish() resolves) into the trailing publish's own createdAt, the same
    // technique used between narrative segments themselves.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const narrator = createNarrativeCommitter(channelId, owner);
      narrator.onChunk("I'll add the requested description.\n\nstill working");
      narrator.onChunk(
        "I'll add the requested description.\n\nRunning the build now.\n\nstill working",
      );
      await narrator.finish();

      expect(published.map((event) => event.content)).toEqual([
        "I'll add the requested description.",
        'Running the build now.',
        'still working',
      ]);
      const floor = narrator.lastCreatedAt();
      expect(floor).toBeGreaterThan(0);

      const trailingCreatedAt = Math.max(Math.floor(Date.now() / 1_000), floor + 1);
      await postAgentMessage(
        channelId,
        owner,
        'Completed: added the requested description.',
        undefined,
        [],
        [],
        undefined,
        trailingCreatedAt,
      );

      expect(published).toHaveLength(4);
      expect(published[3]!.content).toBe('Completed: added the requested description.');
      const timestamps = published.map((event) => event.created_at);
      expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
      expect(new Set(timestamps).size).toBe(4);
      expect(timestamps[3]).toBeGreaterThan(timestamps[2]!);
    } finally {
      vi.useRealTimers();
    }
  });
});
