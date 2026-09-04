import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { TURN_RECEIPT_HEARTBEAT_MS, withTurnReceiptHeartbeat } from './turn-receipt-heartbeat.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('turn receipt heartbeat', () => {
  afterEach(() => vi.useRealTimers());

  it('refreshes a long-running turn and stops after the task settles', async () => {
    vi.useFakeTimers();
    const task = deferred<string>();
    const execute = vi.fn(async () => ({ id: 'receipt', createdAt: 1 }));
    const running = withTurnReceiptHeartbeat(
      { execute } as unknown as Pick<DaemonApiClient, 'execute'>,
      { agentId: 'agent', roomId: 'room', requestId: 'request', generationId: 'generation' },
      () => task.promise,
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledWith(
      'postAgentTurnReceipt',
      expect.objectContaining({ status: 'working' }),
    );
    expect(execute.mock.calls[0]?.[1]).not.toHaveProperty('heartbeat');

    await vi.advanceTimersByTimeAsync(TURN_RECEIPT_HEARTBEAT_MS * 3);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute).toHaveBeenLastCalledWith(
      'postAgentTurnReceipt',
      expect.objectContaining({ status: 'working', heartbeat: true }),
    );

    task.resolve('done');
    await expect(running).resolves.toBe('done');
    await vi.advanceTimersByTimeAsync(TURN_RECEIPT_HEARTBEAT_MS);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('drains an in-flight heartbeat before allowing a terminal receipt', async () => {
    vi.useFakeTimers();
    const task = deferred<void>();
    const heartbeat = deferred<{ id: string; createdAt: number }>();
    const execute = vi.fn(async (_name, input: { heartbeat?: boolean }) =>
      input.heartbeat ? heartbeat.promise : { id: 'initial', createdAt: 1 },
    );
    const running = withTurnReceiptHeartbeat(
      { execute } as unknown as Pick<DaemonApiClient, 'execute'>,
      { agentId: 'agent', roomId: 'room', requestId: 'request' },
      () => task.promise,
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(TURN_RECEIPT_HEARTBEAT_MS);
    task.resolve();
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    heartbeat.resolve({ id: 'heartbeat', createdAt: 2 });
    await running;
    expect(settled).toBe(true);
  });
});
