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
