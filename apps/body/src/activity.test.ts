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

import { projectActivity } from './activity.js';

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

  it('projects only the major action and a summary out of a noisy tool-call batch', async () => {
    const unsubscribe = projectActivity(client as unknown as AcpClient, channelId, owner, sessionId);

    // Reasoning / planning noise.
    emit({ sessionUpdate: 'agent_thought_chunk', content: 'Let me think about this…' });
    emit({ sessionUpdate: 'plan', entries: [{ content: 'inspect the repo' }] });

    // A handful of reads/searches — grep, file reads — that should stay background.
    emit(toolCall('search-1', { kind: 'search', title: 'grep for TODO' }));
    emit(toolCallUpdate('search-1', { status: 'completed', kind: 'search' }));
    emit(toolCall('read-1', { kind: 'read', title: 'Read package.json' }));
    emit(toolCallUpdate('read-1', { status: 'completed' }));
    emit(
      toolCall('shell-1', {
        kind: 'execute',
        title: 'shell: grep -rn TODO src',
        rawInput: { command: 'grep -rn TODO src' },
      }),
    );
    emit(toolCallUpdate('shell-1', { status: 'completed' }));

    // The one load-bearing edit.
    emit(toolCall('edit-1', { kind: 'edit', title: 'Edit src/activity.ts' }));
    emit(toolCallUpdate('edit-1', { status: 'completed' }));

    await vi.advanceTimersByTimeAsync(5_000);
    unsubscribe();

    expect(published).toHaveLength(1);
    const content = JSON.parse(published[0]!.content) as {
      update: { updates: Array<Record<string, unknown>> };
    };
    const updates = content.update.updates;

    // Only the completed edit plus a synthesized summary line — nothing per
    // grep/read/thought/plan step.
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-1' });
    expect(updates[1]).toMatchObject({ sessionUpdate: 'activity_summary' });
    const summaryText = (updates[1] as { content: { text: string } }).content.text;
    expect(summaryText).toContain('Edit src/activity.ts');
    expect(summaryText).not.toContain('grep');
  });

  it('surfaces a failed tool call as a load-bearing blocker even when read-only', async () => {
    const unsubscribe = projectActivity(client as unknown as AcpClient, channelId, owner, sessionId);

    emit(toolCall('read-err', { kind: 'read', title: 'Read missing.txt' }));
    emit(toolCallUpdate('read-err', { status: 'failed' }));

    await vi.advanceTimersByTimeAsync(5_000);
    unsubscribe();

    expect(published).toHaveLength(1);
    const content = JSON.parse(published[0]!.content) as {
      update: { updates: Array<Record<string, unknown>> };
    };
    expect(content.update.updates).toHaveLength(2);
    expect(content.update.updates[0]).toMatchObject({ toolCallId: 'read-err', status: 'failed' });
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
