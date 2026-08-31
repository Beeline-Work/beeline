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
  createThoughtStreamer,
  compactActivityUpdate,
  AGENT_DRAFT_FLUSH_MS,
  AGENT_MESSAGE_TAG,
  buildAgentMessage,
  postAgentMessage,
  postAgentTurnStatus,
  postCornerSessionStatus,
  retractAgentDraft,
  retractAgentPresence,
  postSteerQueuedNotice,
  STEER_QUEUED_TAG,
} from './activity.js';
import {
  KIND_AGENT_DRAFT,
  KIND_AGENT_PRESENCE,
  TAG_AGENT_DRAFT,
  TAG_AGENT_THOUGHT,
} from '@beeline/buzz-client';

const published = mocks.published;

describe('daemon lifecycle receipts', () => {
  it('publishes turn and corner state as empty typed records, never filler prose', async () => {
    const owner = newIdentity('agent');
    published.length = 0;

    await postAgentTurnStatus('room', owner, 'request', 'session', 'working');
    await postCornerSessionStatus('corner', owner, 'session', 'live', 1);

    expect(published.map((event) => event.content)).toEqual(['', '']);
    expect(published[0]?.tags).toContainEqual(['t', 'agent-turn']);
    expect(published[1]?.tags).toContainEqual(['t', 'corner-session']);
  });
});

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
    const unsubscribe = projectActivity(
      client as unknown as AcpClient,
      channelId,
      owner,
      sessionId,
    );

    // Reasoning / planning noise, including the bare ACP names sent by some agents.
    emit({ sessionUpdate: 'agent_thought_chunk', content: 'Let me think about this…' });
    emit({ sessionUpdate: 'reasoning', content: 'I should inspect the codegraph first.' });
    emit({ sessionUpdate: 'plan', entries: [{ content: 'inspect the repo' }] });

    // MCP and raw shell calls/results must remain private implementation detail.
    emit(
      toolCall('codegraph-1', {
        kind: 'execute',
        title: 'mcp.codegraph.codegraph_context',
        rawInput: {
          server: 'codegraph',
          tool: 'codegraph_context',
          arguments: { query: 'activity' },
        },
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
    emit(
      toolCallUpdate('shell-2', {
        status: 'completed',
        output: 'apps/body/src/activity.ts:activity_batch',
      }),
    );

    // The one load-bearing edit.
    emit(
      toolCall('edit-1', {
        kind: 'edit',
        title: 'str_replace',
        rawInput: { path: 'src/activity.ts' },
      }),
    );
    emit(toolCallUpdate('edit-1', { status: 'completed' }));

    await vi.advanceTimersByTimeAsync(5_000);
    unsubscribe();

    expect(published).toHaveLength(1);
    const content = JSON.parse(published[0]!.content) as {
      update: { updates: Array<Record<string, unknown>> };
    };
    const updates = content.update.updates;

    // Only an inspectable edit milestone plus a synthesized summary line —
    // the non-major search/shell calls never earn their own tool_activity
    // event (that's still the noise-control fold), but the surviving edit's
    // own detail (files, redacted input) is present so the corner drill-down
    // can inspect it.
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
    // The folded search/shell calls now ride a compact receipt on the summary
    // event — target + a short taste of output — so the review sheet has
    // something real to show instead of just their tally.
    const observed = (updates[1] as { observed: Array<Record<string, unknown>> }).observed;
    expect(observed).toEqual([
      { verb: 'searched', target: 'grep for TODO' },
      {
        verb: 'ran',
        target: "sed -n '1,140p' apps/body/src/activity.ts",
        result: 'const rawOutput = true;',
      },
      {
        verb: 'ran',
        target: 'rg -n "activity_batch" apps/body/src',
        result: 'apps/body/src/activity.ts:activity_batch',
      },
    ]);
    const projection = JSON.stringify(content);
    // MCP internals and raw reasoning content stay implementation detail even
    // in the drill-down — MCP calls never get a compact receipt at all
    // (verb 'queried' is skipped), and reasoning is dropped before it ever
    // reaches the batch.
    for (const leaked of ['mcp.codegraph', 'reasoning', 'str_replace']) {
      expect(projection).not.toContain(leaked);
    }
  });

  it('surfaces a failed test suite as an inspectable blocker with its command and output', async () => {
    const unsubscribe = projectActivity(
      client as unknown as AcpClient,
      channelId,
      owner,
      sessionId,
    );

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

  it("carries the agent's plan out on the receipt event it already publishes", async () => {
    // The plan is the only source for the corner's pinned objective panel, and
    // it reaches the wire on the `activity_summary` event that a batch already
    // sends — never on a wire of its own. ACP's own `plan` update shape.
    const unsubscribe = projectActivity(
      client as unknown as AcpClient,
      channelId,
      owner,
      sessionId,
    );

    emit({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Find the renderer', status: 'completed' },
        { content: 'Wire the highlighter', status: 'in_progress' },
        { content: 'Add a test', status: 'pending' },
      ],
    });

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
        plan: {
          items: [
            { step: 'Find the renderer', status: 'completed' },
            { step: 'Wire the highlighter', status: 'in_progress' },
            { step: 'Add a test', status: 'pending' },
          ],
        },
      },
    ]);
  });

  it('publishes the objective with one honest working state when the harness never plans', async () => {
    const projection = projectActivity(client as unknown as AcpClient, channelId, owner, sessionId);

    // This is the first agent-activity event of the corner turn. No ACP plan
    // update is emitted anywhere in this proof: it models claude/deepseek
    // adapters that do not volunteer one.
    await projection.startPlan(
      `  **Fix** the corner checklist\nwithout echoing ${'x'.repeat(300)}  `,
    );

    emit(toolCall('search-plan', { kind: 'search', title: 'search_text' }));
    emit(toolCallUpdate('search-plan', { status: 'completed' }));
    await vi.advanceTimersByTimeAsync(5_000);

    emit(
      toolCall('test-plan', {
        kind: 'execute',
        title: 'shell',
        rawInput: { command: 'npm test -- --run' },
      }),
    );
    emit(toolCallUpdate('test-plan', { status: 'completed', output: '12 passed' }));
    await vi.advanceTimersByTimeAsync(5_000);
    await projection.completePlan();
    projection();

    const plans = published.flatMap((event) => {
      const content = JSON.parse(event.content) as {
        update: { updates: Array<{ plan?: Record<string, unknown> }> };
      };
      return content.update.updates.flatMap((update) => (update.plan ? [update.plan] : []));
    }) as Array<{ objective?: string; items: Array<{ step: string; status: string }> }>;

    expect(plans.map((plan) => plan.items)).toEqual([
      [{ step: 'Working…', status: 'in_progress' }],
      [{ step: 'Working…', status: 'completed' }],
    ]);
    expect(plans[0]!.objective).not.toContain('\n');
    expect(plans[0]!.objective).not.toContain('**');
    expect(plans[0]!.objective!.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(plans)).not.toContain('Inspect the relevant code');
    expect(JSON.stringify(plans)).not.toContain('Implement the change');
    expect(JSON.stringify(plans)).not.toContain('Verify and summarize the result');
  });

  it('keeps the opening objective write-once across later turns and plan updates', async () => {
    const projection = projectActivity(client as unknown as AcpClient, channelId, owner, sessionId);

    await projection.startPlan('Publish the mockup through a Cloudflare tunnel.');
    await projection.startPlan('@codex u alive?');
    emit({
      sessionUpdate: 'plan',
      objective: 'Replace the objective with this follow-up',
      entries: [{ content: 'Answer the follow-up', status: 'in_progress' }],
    });
    await vi.advanceTimersByTimeAsync(5_000);
    projection();

    const plans = published.flatMap((event) => {
      const content = JSON.parse(event.content) as {
        update: { updates: Array<{ plan?: { objective?: string } }> };
      };
      return content.update.updates.flatMap((update) => (update.plan ? [update.plan] : []));
    });
    expect(plans).toHaveLength(3);
    expect(plans.map((plan) => plan.objective)).toEqual([
      'Publish the mockup through a Cloudflare tunnel.',
      'Publish the mockup through a Cloudflare tunnel.',
      'Publish the mockup through a Cloudflare tunnel.',
    ]);
  });

  it('publishes different task-authored plans for two different corner transcripts', async () => {
    const authProjection = projectActivity(
      client as unknown as AcpClient,
      'auth-corner',
      owner,
      sessionId,
    );
    await authProjection.startPlan('Move registration onto usebeeline.app.', {
      items: [
        { step: 'Trace the registration URL selection', status: 'in_progress' },
        { step: 'Point registration at usebeeline.app', status: 'pending' },
        { step: 'Cover the production host in tests', status: 'pending' },
      ],
    });
    authProjection();

    const archiveClient = new EventEmitter();
    const archiveProjection = projectActivity(
      archiveClient as unknown as AcpClient,
      'archive-corner',
      owner,
      'session-2',
    );
    await archiveProjection.startPlan('Stop retrying archived Rooms.', {
      items: [
        { step: 'Classify archived-channel refusals', status: 'in_progress' },
        { step: 'Park archived Rooms for this process', status: 'pending' },
        { step: 'Prove quarantine does not retry them', status: 'pending' },
      ],
    });
    archiveProjection();

    const plans = published.map((event) => {
      const content = JSON.parse(event.content) as {
        update: { updates: Array<{ plan?: Record<string, unknown> }> };
      };
      return content.update.updates[0]!.plan;
    });

    expect(plans).toEqual([
      {
        objective: 'Move registration onto usebeeline.app.',
        items: [
          { step: 'Trace the registration URL selection', status: 'in_progress' },
          { step: 'Point registration at usebeeline.app', status: 'pending' },
          { step: 'Cover the production host in tests', status: 'pending' },
        ],
      },
      {
        objective: 'Stop retrying archived Rooms.',
        items: [
          { step: 'Classify archived-channel refusals', status: 'in_progress' },
          { step: 'Park archived Rooms for this process', status: 'pending' },
          { step: 'Prove quarantine does not retry them', status: 'pending' },
        ],
      },
    ]);
  });

  it('re-sends the plan only when it actually changed', async () => {
    // A ten-step checklist re-sent on every 5s batch is exactly the kind of
    // per-pubkey relay-quota pressure the activity fold exists to avoid.
    const unsubscribe = projectActivity(
      client as unknown as AcpClient,
      channelId,
      owner,
      sessionId,
    );

    emit({ sessionUpdate: 'plan', entries: [{ content: 'Step one', status: 'in_progress' }] });
    await vi.advanceTimersByTimeAsync(5_000);

    // Same plan, plus real work: the batch publishes, but without the plan.
    emit({ sessionUpdate: 'plan', entries: [{ content: 'Step one', status: 'in_progress' }] });
    emit(toolCall('edit-1', { kind: 'edit', title: 'str_replace', rawInput: { path: 'a.ts' } }));
    emit(toolCallUpdate('edit-1', { status: 'completed' }));
    await vi.advanceTimersByTimeAsync(5_000);

    // Progress: the plan changed, so it rides along again.
    emit({ sessionUpdate: 'plan', entries: [{ content: 'Step one', status: 'completed' }] });
    await vi.advanceTimersByTimeAsync(5_000);
    unsubscribe();

    const plans = published.map((event) => {
      const content = JSON.parse(event.content) as {
        update: { updates: Array<Record<string, unknown>> };
      };
      return content.update.updates.at(-1)!.plan;
    });
    expect(plans).toEqual([
      { items: [{ step: 'Step one', status: 'in_progress' }] },
      undefined,
      { items: [{ step: 'Step one', status: 'completed' }] },
    ]);
  });

  it('reads a plan modelled as an update_plan tool call, which is never load-bearing work', async () => {
    // Not every harness sends ACP's `plan` update — some model the same thing
    // as a tool call, which `isMajorUpdate` correctly refuses to project as a
    // milestone. The plan still has to reach the objective panel.
    const unsubscribe = projectActivity(
      client as unknown as AcpClient,
      channelId,
      owner,
      sessionId,
    );

    emit(
      toolCall('plan-1', {
        kind: 'other',
        title: 'update_plan',
        rawInput: {
          plan: [
            { step: 'Trace the projection', status: 'completed' },
            { step: 'Pin the objective', status: 'in_progress' },
          ],
        },
      }),
    );
    emit(toolCallUpdate('plan-1', { status: 'completed' }));

    await vi.advanceTimersByTimeAsync(5_000);
    unsubscribe();

    expect(published).toHaveLength(1);
    const content = JSON.parse(published[0]!.content) as {
      update: { updates: Array<Record<string, unknown>> };
    };
    const summary = content.update.updates.at(-1)!;
    expect(summary.sessionUpdate).toBe('activity_summary');
    expect(summary.plan).toEqual({
      items: [
        { step: 'Trace the projection', status: 'completed' },
        { step: 'Pin the objective', status: 'in_progress' },
      ],
    });
    // The plan tool call itself is still not a milestone.
    expect(content.update.updates.filter((u) => u.sessionUpdate === 'tool_activity')).toHaveLength(
      0,
    );
  });

  it('publishes a bare tally, not silence, when a batch only observed', async () => {
    const unsubscribe = projectActivity(
      client as unknown as AcpClient,
      channelId,
      owner,
      sessionId,
    );

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
        observed: [{ verb: 'searched', target: 'search_text' }],
      },
    ]);
    // Reasoning is still never counted, and never projected.
    expect(JSON.stringify(content)).not.toContain('inspecting the code');
  });

  it('keeps reasoning entirely out of durable activity, including elapsed receipts', async () => {
    const unsubscribe = projectActivity(
      client as unknown as AcpClient,
      channelId,
      owner,
      sessionId,
    );

    // The replaceable thought lane owns live reasoning. Durable activity gets
    // neither its text nor a historical "Thought for …" receipt.
    emit({
      sessionUpdate: 'agent_thought_chunk',
      content: 'the median bug is the even-length case',
    });
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
        observed: [{ verb: 'read', target: 'read_file' }],
      },
    ]);
    expect(JSON.stringify(content)).not.toContain('divides by zero');
  });

  it('publishes no reasoning residue even when thought spans several batches', async () => {
    const unsubscribe = projectActivity(
      client as unknown as AcpClient,
      channelId,
      owner,
      sessionId,
    );

    // A long thought stays on the replaceable lane and never creates a
    // duration receipt in the durable activity batch.
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

    expect(published).toHaveLength(1);
    const content = JSON.parse(published[0]!.content) as {
      update: { updates: Array<Record<string, unknown>> };
    };
    expect(content.update.updates.at(-1)).toMatchObject({ sessionUpdate: 'activity_summary' });
    expect(content.update.updates.at(-1)!.thoughtMs).toBeUndefined();
  });

  it('omits the receipt for a think too short to be worth reporting', async () => {
    const unsubscribe = projectActivity(
      client as unknown as AcpClient,
      channelId,
      owner,
      sessionId,
    );

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
    const unsubscribe = projectActivity(
      client as unknown as AcpClient,
      channelId,
      owner,
      sessionId,
    );

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
    expect(summary.observed).toBeUndefined();
  });

  it('attaches a compact per-call receipt for folded calls, not just their tally', async () => {
    const unsubscribe = projectActivity(
      client as unknown as AcpClient,
      channelId,
      owner,
      sessionId,
    );

    emit(
      toolCall('read-detail', {
        kind: 'read',
        title: 'read_file',
        rawInput: { path: 'src/foo.ts' },
      }),
    );
    emit(
      toolCallUpdate('read-detail', { status: 'completed', output: 'export function foo() {}' }),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    unsubscribe();

    const content = JSON.parse(published[0]!.content) as {
      update: { updates: Array<Record<string, unknown>> };
    };
    const summary = content.update.updates.at(-1) as {
      rollup: Record<string, number>;
      observed: Array<{ verb: string; target?: string; result?: string }>;
    };
    expect(summary.rollup).toEqual({ read: 1 });
    // The client can now show what was read and a taste of what it found,
    // not merely that a read happened.
    expect(summary.observed).toEqual([
      { verb: 'read', target: 'src/foo.ts', result: 'export function foo() {}' },
    ]);
  });

  it('truncates a folded call receipt and caps how many a batch carries', async () => {
    const unsubscribe = projectActivity(
      client as unknown as AcpClient,
      channelId,
      owner,
      sessionId,
    );

    // A receipt long enough to need truncation.
    emit(
      toolCall('read-long', {
        kind: 'read',
        title: 'read_file',
        rawInput: { path: 'src/long.ts' },
      }),
    );
    emit(toolCallUpdate('read-long', { status: 'completed', output: 'x'.repeat(500) }));

    // More folded calls than the per-batch cap.
    for (let i = 0; i < 25; i++) {
      emit(toolCall(`search-${i}`, { kind: 'search', title: `search_${i}` }));
      emit(toolCallUpdate(`search-${i}`, { status: 'completed' }));
    }

    await vi.advanceTimersByTimeAsync(5_000);
    unsubscribe();

    const content = JSON.parse(published[0]!.content) as {
      update: { updates: Array<Record<string, unknown>> };
    };
    const summary = content.update.updates.at(-1) as {
      rollup: Record<string, number>;
      observed: Array<{ verb: string; target?: string; result?: string }>;
    };
    // The tally is exact even when the receipts are capped.
    expect(summary.rollup).toEqual({ read: 1, searched: 25 });
    expect(summary.observed.length).toBeLessThanOrEqual(20);
    const readReceipt = summary.observed.find((entry) => entry.verb === 'read')!;
    // Truncated well short of the raw 500-char output — "a line or two", not a dump.
    expect(readReceipt.result!.length).toBeLessThan(250);
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
    expect(published).toHaveLength(3);
    expect(published[1]!.content).toBe('Hello world');
    expect(published[2]).toMatchObject({ kind: KIND_AGENT_DRAFT, content: '' });
    expect(published[2]!.tags).toContainEqual(['status', 'closed']);
  });

  it('finish() flushes trailing text even before the coalescing window elapses', async () => {
    const streamer = createDraftStreamer(channelId, owner, sessionId, requestId);
    streamer.onChunk('done');
    await streamer.finish();
    expect(published).toHaveLength(2);
    expect(published[0]!.content).toBe('done');
    expect(published[1]!.tags).toContainEqual(['status', 'closed']);
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
    expect(published).toHaveLength(2);
    expect(published[1]!.tags).toContainEqual(['status', 'closed']);
  });

  it('publishes each queued snapshot once when a slow relay write overlaps later flushes', async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(publishEvent).mockImplementationOnce(async (event: NostrEvent) => {
      await firstHeld;
      published.push(event);
      return { ok: true } as never;
    });
    const streamer = createDraftStreamer(channelId, owner, sessionId, requestId);

    streamer.onChunk('First');
    await vi.advanceTimersByTimeAsync(AGENT_DRAFT_FLUSH_MS);
    streamer.onChunk('First second');
    await vi.advanceTimersByTimeAsync(AGENT_DRAFT_FLUSH_MS);
    streamer.onChunk('First second third');
    await vi.advanceTimersByTimeAsync(AGENT_DRAFT_FLUSH_MS);

    const finished = streamer.finish();
    releaseFirst();
    await finished;

    expect(published.map((event) => event.content)).toEqual([
      'First',
      'First second',
      'First second third',
      '',
    ]);
    expect(published.at(-1)!.tags).toContainEqual(['status', 'closed']);
  });

  const PI_COLD_SESSION_BANNER = [
    'pi v0.83.0',
    '---',
    '',
    '## Context',
    '- /home/lunchbox/proj-buzzy/AGENTS.md',
    '',
    '## Skills',
    '- /home/lunchbox/.pi/agent/skills/trusty-squire/SKILL.md',
    '- /home/lunchbox/.pi/agent/skills/no-mistakes/SKILL.md',
    '- /home/lunchbox/.pi/agent/skills/find-skills/SKILL.md',
    '- /home/lunchbox/.pi/agent/skills/create-payment-credential/SKILL.md',
    '',
    '---',
    'New version available: v0.84.2 (installed v0.83.0). Run: `npm i -g @earendil-works/pi-coding-agent`',
    '',
  ].join('\n');

  it('never publishes a cold session harness startup banner as a live draft', async () => {
    const streamer = createDraftStreamer(channelId, owner, sessionId, requestId);

    // The banner streams in first, exactly as pi-acp emits it before any real
    // reply text — a turn interrupted right here (e.g. a daemon restart)
    // must leave nothing published, not the raw banner.
    streamer.onChunk(PI_COLD_SESSION_BANNER);
    await vi.advanceTimersByTimeAsync(AGENT_DRAFT_FLUSH_MS);
    expect(published).toHaveLength(0);

    await streamer.finish();
    expect(published).toHaveLength(0);
  });

  it('publishes only the real answer once it streams in after the banner', async () => {
    const streamer = createDraftStreamer(channelId, owner, sessionId, requestId);

    streamer.onChunk(PI_COLD_SESSION_BANNER);
    await vi.advanceTimersByTimeAsync(AGENT_DRAFT_FLUSH_MS);
    expect(published).toHaveLength(0);

    streamer.onChunk(`${PI_COLD_SESSION_BANNER}\nThe answer is 42.`);
    await streamer.finish();

    expect(published).toHaveLength(2);
    expect(published[0]!.content).toBe('The answer is 42.');
    expect(published[0]!.content).not.toContain('pi v0.83.0');
    expect(published[0]!.content).not.toContain('New version available');
    expect(published[1]!.tags).toContainEqual(['status', 'closed']);
  });
});

describe('createThoughtStreamer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    published.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('replaces the rolling thought lane and closes it without a durable message', async () => {
    const owner = newIdentity('thought-stream-owner');
    const streamer = createThoughtStreamer('room-thought', owner, 'session-thought');
    streamer.onChunk('first line');
    await vi.advanceTimersByTimeAsync(AGENT_DRAFT_FLUSH_MS);
    streamer.onChunk('replacement line');
    await vi.advanceTimersByTimeAsync(AGENT_DRAFT_FLUSH_MS);
    await streamer.finish();

    const thoughts = published.filter((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === TAG_AGENT_THOUGHT),
    );
    expect(thoughts.map((event) => event.content)).toEqual(['first line', 'replacement line', '']);
    expect(thoughts.at(-1)?.tags).toContainEqual(['status', 'closed']);
    expect(thoughts.every((event) => event.kind === KIND_AGENT_DRAFT)).toBe(true);
  });
});

describe('terminal corner activity replacements', () => {
  beforeEach(() => {
    published.length = 0;
  });

  it('overwrites draft and presence on their one existing d-key in a live parent scope', async () => {
    const owner = newIdentity('terminal-activity-agent');
    await retractAgentDraft('dead-corner', 'parent-room', owner, 101);
    await retractAgentPresence('dead-corner', 'parent-room', owner, 102);

    expect(published).toHaveLength(2);
    expect(published[0]).toMatchObject({ kind: KIND_AGENT_DRAFT, created_at: 101, content: '' });
    expect(published[0]!.tags).toEqual(
      expect.arrayContaining([
        ['d', 'agent-draft:dead-corner'],
        ['h', 'parent-room'],
        ['status', 'closed'],
        ['corner', 'dead-corner'],
      ]),
    );
    expect(published[1]).toMatchObject({ kind: KIND_AGENT_PRESENCE, created_at: 102 });
    expect(published[1]!.tags).toEqual(
      expect.arrayContaining([
        ['d', 'agent-presence:dead-corner'],
        ['h', 'parent-room'],
        ['status', 'offline'],
        ['terminal', 'closed'],
        ['corner', 'dead-corner'],
      ]),
    );
  });
});

describe('postSteerQueuedNotice', () => {
  beforeEach(() => {
    published.length = 0;
  });

  it('does not publish queue implementation state into the transcript', async () => {
    const owner = newIdentity('steer-ack-agent');
    await postSteerQueuedNotice('corner-9', owner, 'request-9');
    expect(published).toEqual([]);
  });
});
