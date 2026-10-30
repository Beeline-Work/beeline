import { describe, expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';

// Drive real ACP notification handling and prompt lifecycle without spawning a harness.
function harness() {
  const client = new AcpClient({ agentCommand: 'test-harness', agentEnv: {} });
  const wire = client as unknown as {
    handleMessage(message: Record<string, unknown>): void;
    request(method: string, params: unknown): Promise<unknown>;
  };
  const update = (sessionId: string, toolCallId: string, status: string) => wire.handleMessage({
    method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'tool_call_update', toolCallId, title: 'Run tests', status,
    } },
  });
  vi.spyOn(wire, 'request').mockImplementation(async () => {
    update('session', 'job', 'in_progress');
    return { stopReason: 'end_turn' };
  });
  return { client, wire, update };
}

describe('background tool completion', () => {
  it.each(['completed', 'failed'])('pushes %s once to the originating prompt after end_turn', async (status) => {
    const { client, update } = harness();
    const complete = vi.fn();
    await client.sessionPrompt('session', 'work', 5000, undefined, undefined, undefined, complete);
    expect(client.hasBackgroundTools).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    update('other-session', 'job', status);
    expect(complete).not.toHaveBeenCalled();
    update('session', 'job', status);
    update('session', 'job', status);
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ id: 'job', status }));
    expect(client.hasBackgroundTools).toBe(false);
  });

  it('does not wake again for tools completed during the prompt', async () => {
    const { client, wire, update } = harness();
    vi.mocked(wire.request).mockImplementation(async () => {
      update('session', 'job', 'in_progress');
      update('session', 'job', 'completed');
      return { stopReason: 'end_turn' };
    });
    const complete = vi.fn();
    await client.sessionPrompt('session', 'work', 5000, undefined, undefined, undefined, complete);
    update('session', 'job', 'completed');
    expect(complete).not.toHaveBeenCalled();
    expect(client.hasBackgroundTools).toBe(false);
  });

  it('keeps the original callback when another prompt is running', async () => {
    const { client, wire, update } = harness();
    const first = vi.fn(), next = vi.fn();
    await client.sessionPrompt('session', 'first', 5000, undefined, undefined, undefined, first);
    vi.mocked(wire.request).mockImplementation(async () => {
      update('session', 'job', 'completed');
      return { stopReason: 'end_turn' };
    });
    await client.sessionPrompt('session', 'next', 5000, undefined, undefined, undefined, next);
    expect(first).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });
});

describe('Claude ACP detached Bash jobs', () => {
  it.each(['completed', 'failed', 'stopped'])('wakes on async task %s after the Bash call and prompt completed', async (state) => {
    const { client, wire, update } = harness();
    const task = (fields: Record<string, unknown>, sessionId = 'session') => wire.handleMessage({
      method: 'session/update', params: { sessionId, update: { asyncTaskId: 'bash-job', ...fields } },
    });
    vi.mocked(wire.request).mockImplementation(async () => {
      update('session', 'bash-call', 'in_progress');
      task({ sessionUpdate: 'async_task_spawned', name: 'Build widget', toolCallId: 'bash-call', taskType: 'shell' });
      // The adapter explicitly completes Bash when it detaches. This does not finish its job.
      update('session', 'bash-call', 'completed');
      return { stopReason: 'end_turn' };
    });
    const complete = vi.fn();
    await client.sessionPrompt('session', 'build', 5000, undefined, undefined, undefined, complete);
    expect(client.hasBackgroundTools).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    task({ sessionUpdate: 'async_task_progress', description: 'Build widget', elapsedTimeMs: 2000 });
    task({ sessionUpdate: 'async_task_state_update', state }, 'other-session');
    expect(complete).not.toHaveBeenCalled();
    task({ sessionUpdate: 'async_task_state_update', state });
    task({ sessionUpdate: 'async_task_state_update', state });
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      id: 'async:bash-job', title: 'Build widget', status: state === 'stopped' ? 'failed' : state,
    }));
    expect(client.hasBackgroundTools).toBe(false);
  });

  it('does not wake for a background task that finishes within its originating prompt', async () => {
    const { client, wire } = harness();
    vi.mocked(wire.request).mockImplementation(async () => {
      for (const update of [
        { sessionUpdate: 'async_task_spawned', asyncTaskId: 'fast-job', name: 'Fast build' },
        { sessionUpdate: 'async_task_state_update', asyncTaskId: 'fast-job', state: 'completed' },
      ]) wire.handleMessage({ method: 'session/update', params: { sessionId: 'session', update } });
      return { stopReason: 'end_turn' };
    });
    const complete = vi.fn();
    await client.sessionPrompt('session', 'build', 5000, undefined, undefined, undefined, complete);
    expect(client.hasBackgroundTools).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });
});

it('uses the async job lifecycle once when the originating tool is also unfinished at end_turn', async () => {
  const { client, wire, update } = harness();
  const task = (sessionUpdate: string, state?: string) => wire.handleMessage({
    method: 'session/update', params: { sessionId: 'session', update: {
      sessionUpdate, asyncTaskId: 'job', toolCallId: 'bash-call', name: 'Run build', ...(state ? { state } : {}),
    } },
  });
  vi.mocked(wire.request).mockImplementation(async () => {
    update('session', 'bash-call', 'in_progress');
    task('async_task_spawned');
    return { stopReason: 'end_turn' };
  });
  const complete = vi.fn();
  await client.sessionPrompt('session', 'build', 5000, undefined, undefined, undefined, complete);
  update('session', 'bash-call', 'completed');
  expect(complete).not.toHaveBeenCalled();
  task('async_task_state_update', 'completed');
  expect(complete).toHaveBeenCalledOnce();
  expect(client.hasBackgroundTools).toBe(false);
});

it('keeps async job ownership when a later prompt sees progress before finishing', async () => {
  const { client, wire } = harness();
  const task = (sessionUpdate: string, state?: string) => wire.handleMessage({
    method: 'session/update', params: { sessionId: 'session', update: {
      sessionUpdate, asyncTaskId: 'long-job', name: 'Build', ...(state ? { state } : {}),
    } },
  });
  const first = vi.fn(), later = vi.fn();
  vi.mocked(wire.request).mockImplementation(async () => {
    task('async_task_spawned');
    return { stopReason: 'end_turn' };
  });
  await client.sessionPrompt('session', 'start', 5000, undefined, undefined, undefined, first);
  vi.mocked(wire.request).mockImplementation(async () => {
    task('async_task_progress');
    return { stopReason: 'end_turn' };
  });
  await client.sessionPrompt('session', 'other work', 5000, undefined, undefined, undefined, later);
  task('async_task_state_update', 'completed');
  expect(first).toHaveBeenCalledOnce();
  expect(later).not.toHaveBeenCalled();
});

it('terminal guards discard background wakes only for the terminated session', async () => {
  const { client, wire, update } = harness();
  const original = vi.fn(), terminated = vi.fn(), sibling = vi.fn();
  vi.spyOn(client, 'sessionCancel').mockImplementation(() => undefined);
  await client.sessionPrompt('session', 'start job', 5000, undefined, undefined, undefined, original);
  vi.mocked(wire.request).mockImplementation(async () => {
    update('sibling', 'sibling-job', 'in_progress');
    return { stopReason: 'end_turn' };
  });
  await client.sessionPrompt('sibling', 'other job', 5000, undefined, undefined, undefined, sibling);
  vi.mocked(wire.request).mockImplementation(async () => {
    wire.handleMessage({ method: 'session/update', params: { sessionId: 'session', update: {
      sessionUpdate: 'async_task_spawned', asyncTaskId: 'new-job', name: 'New build',
    } } });
    for (let index = 0; index < 5; index++) wire.handleMessage({
      method: 'session/update', params: { sessionId: 'session', update: {
        sessionUpdate: 'tool_call', toolCallId: `loop-${index}`, title: 'Loop',
        rawInput: { query: 'same' }, status: 'completed', rawOutput: 'unchanged',
      } },
    });
    return { stopReason: 'end_turn' };
  });
  const result = await client.sessionPrompt('session', 'loop', 5000, undefined, undefined, undefined, terminated);
  expect(result.stopReason).toBe('repeated-tool-call');
  update('session', 'job', 'completed');
  wire.handleMessage({ method: 'session/update', params: { sessionId: 'session', update: {
    sessionUpdate: 'async_task_state_update', asyncTaskId: 'new-job', state: 'completed',
  } } });
  expect(original).not.toHaveBeenCalled();
  expect(terminated).not.toHaveBeenCalled();
  update('sibling', 'sibling-job', 'completed');
  expect(sibling).toHaveBeenCalledOnce();
  expect(client.hasBackgroundTools).toBe(false);
});
