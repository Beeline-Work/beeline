import { describe, expect, it, vi } from 'vitest';
import {
  captureConnectionUsage,
  ConnectorUsageRecorder,
  squireUsageFromToolCall,
  type ConnectionTurn,
} from './connector-runner.js';
import type { ConnectionUsageRecord } from '@beeline/api-contract/daemon-operations';

const turn: ConnectionTurn = {
  requestId: 'req-1',
  agentId: 'agent-1',
  cornerId: 'corner-1',
};

const squireCall = {
  title: 'squire__use_credential',
  status: 'completed',
  rawInput: {
    reference: 'cred_1',
    service: 'openai',
    method: 'POST',
    url: 'https://api.openai.com/v1/chat',
    grant_id: 'g1',
  },
  content: { content: { status: 200, body: 'hello'.repeat(10) } },
};

const unrelatedCall = {
  title: 'bash',
  status: 'completed',
  rawInput: { command: 'ls' },
  content: {},
};

function mockedApi(fail = false) {
  const execute = vi.fn(async (_name: string, _input: unknown) => {
    if (fail) throw new Error('server unreachable');
    return { id: 'w1', createdAt: 1 };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { execute: execute as any, spy: execute };
}

describe('squireUsageFromToolCall', () => {
  it('recognises a Squire use_credential call with or without the server prefix', () => {
    expect(squireUsageFromToolCall(squireCall)).toMatchObject({
      ref: 'cred_1',
      service: 'openai',
      statusCode: 200,
      grantId: 'g1',
    });
    expect(
      squireUsageFromToolCall({ ...squireCall, title: 'use_credential' }),
    ).toBeDefined();
  });

  it('returns undefined for an unrelated tool call', () => {
    expect(squireUsageFromToolCall(unrelatedCall)).toBeUndefined();
  });

  it('measures the response bytes and fails closed to status 0 on a failed call', () => {
    const usage = squireUsageFromToolCall(squireCall)!;
    expect(usage.bytes).toBeGreaterThan(0);
    expect(usage.statusCode).toBe(200);
    const failed = squireUsageFromToolCall({
      ...squireCall,
      status: 'failed',
      content: {},
    })!;
    expect(failed.statusCode).toBe(0);
  });

  it('treats grant minting as usage', () => {
    expect(
      squireUsageFromToolCall({
        title: 'grant_app_access',
        status: 'ok',
        rawInput: { reference: 'cred_2', service: 'stripe' },
        content: {},
      }),
    ).toMatchObject({ ref: 'cred_2', service: 'stripe', operation: 'grant_app_access cred_2' });
  });
});

describe('ConnectorUsageRecorder', () => {
  it('batches several calls in one turn into ONE postConnectionUsage', async () => {
    const recorder = new ConnectorUsageRecorder();
    const api = mockedApi();
    captureConnectionUsage(recorder, turn, [squireCall, unrelatedCall, squireCall]);
    expect(recorder.pending('req-1')).toHaveLength(2);
    const published = await recorder.flush(api as never, 'req-1');
    expect(published).toBe(2);
    expect(api.spy).toHaveBeenCalledTimes(1);
    const [, input] = api.spy.mock.calls[0] as unknown as [
      string,
      { usage: ConnectionUsageRecord[] },
    ];
    expect(input.usage).toHaveLength(2);
    expect(api.spy.mock.calls[0]?.[0]).toBe('postConnectionUsage');
  });

  it('clears the batch after a flush, so a second flush publishes nothing', async () => {
    const recorder = new ConnectorUsageRecorder();
    const api = mockedApi();
    captureConnectionUsage(recorder, turn, [squireCall]);
    await recorder.flush(api as never, 'req-1');
    expect(await recorder.flush(api as never, 'req-1')).toBe(0);
    expect(api.spy).toHaveBeenCalledTimes(1);
  });

  it('keeps batches separate per request id', async () => {
    const recorder = new ConnectorUsageRecorder();
    const api = mockedApi();
    captureConnectionUsage(recorder, turn, [squireCall]);
    captureConnectionUsage(recorder, { ...turn, requestId: 'req-2' }, [squireCall]);
    expect(recorder.pending('req-1')).toHaveLength(1);
    expect(recorder.pending('req-2')).toHaveLength(1);
    await recorder.flush(api as never, 'req-2');
    expect(recorder.pending('req-1')).toHaveLength(1);
  });

  it('carries the room or corner the turn ran in', async () => {
    const recorder = new ConnectorUsageRecorder();
    const api = mockedApi();
    captureConnectionUsage(recorder, turn, [squireCall]);
    await recorder.flush(api as never, 'req-1');
    const [, input] = api.spy.mock.calls[0] as unknown as [
      string,
      { cornerId?: string; roomId?: string; agentId: string; requestId: string },
    ];
    expect(input.cornerId).toBe('corner-1');
    expect(input.requestId).toBe('req-1');
    expect(input.agentId).toBe('agent-1');
  });

  it('never fails the agent turn when the publish fails', async () => {
    const recorder = new ConnectorUsageRecorder();
    const api = mockedApi(true);
    captureConnectionUsage(recorder, turn, [squireCall]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(recorder.flush(api as never, 'req-1')).resolves.toBe(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('drops records with no connection reference', () => {
    const recorder = new ConnectorUsageRecorder();
    recorder.record(turn, {
      ref: '',
      service: null,
      operation: 'x',
      statusCode: 200,
      bytes: 0,
    });
    expect(recorder.pending('req-1')).toHaveLength(0);
  });
});
