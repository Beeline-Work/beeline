import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newIdentity } from '@beeline/gate';
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

  it('publishes nothing when a batch has no major action', async () => {
    const unsubscribe = projectActivity(client as unknown as AcpClient, channelId, owner, sessionId);

    emit({ sessionUpdate: 'agent_thought_chunk', content: 'inspecting the code' });
    emit(toolCall('search-only', { kind: 'search', title: 'search_text' }));
    emit(toolCallUpdate('search-only', { status: 'completed' }));

    await vi.advanceTimersByTimeAsync(5_000);
    unsubscribe();

    expect(published).toHaveLength(0);
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
