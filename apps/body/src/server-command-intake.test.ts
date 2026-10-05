import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { DaemonApiClient, DaemonApiError, type DaemonWebSocketFactory } from './daemon-api-client.js';
import { CommandExecutionContext, runServerCommandIntake, validateServerCommand } from './server-command-intake.js';

const paths: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
const command = (id = 'c1', action: AgentCommand['action'] = 'input'): AgentCommand => ({
  id, roomId: 'room', agentId: 'agent', sourceMessageId: id, turnRequestId: 'turn',
  rootCommandId: 'root', rootSourceMessageId: 'human', agentDepth: 0, action,
  reason: 'human_tag',
  source: { id, authorId: 'human', body: 'Do it', createdAt: 1, type: 'message', attachments: [] },
});

it('delivers the private webhook URL only to the claimed requesting-agent resume', async () => {
  const abort = new AbortController(), ctx = await context();
  const resumed = { ...command('approval', 'resume'), source: { ...command().source,
    body: 'Webhook approved', systemEvent: { kind: 'webhook-request-decided' as const,
      subject: { kind: 'system' as const, name: 'Beeline' }, verb: 'approved' },
  } };
  const execute = vi.fn(async (name: string) => name === 'getAgentCommands'
    ? { commandProtocol: 1, commands: [resumed] }
    : name === 'claimAgentCommand'
      ? { id: 'claimed', webhookResult: { url: 'https://example.invalid/v1/hooks/private', signingSecret: 'explicitly-shared' } }
      : { id: 'ok' });
  const wire = socketApi(execute);
  let delivered: AgentCommand | undefined;
  await runServerCommandIntake({ api: wire.api, roomId: 'room', agentId: 'agent', context: ctx, signal: abort.signal,
    run: async (received) => { delivered = received; abort.abort(); }, stop: () => undefined });
  expect(delivered?.source.body).toContain('Approved webhook URL (shown once): https://example.invalid/v1/hooks/private');
  expect(delivered?.source.body).toContain('explicitly-shared');
  expect(resumed.source.body).toBe('Webhook approved');
});
async function context() {
  const dir = await mkdtemp(join(tmpdir(), 'command-test-'));
  paths.push(dir);
  return new CommandExecutionContext(dir);
}
function socketApi(execute: ReturnType<typeof vi.fn>) {
  let state: ((connected: boolean, capabilities?: { pushIntake: boolean; connectionPresence: boolean }) => void) | undefined;
  let commands: ((commands: readonly AgentCommand[]) => void) | undefined;
  const api = {
    execute,
    liveSubscribe: vi.fn((_roomId, _cursor, _items, onState, _presence, onCommands) => {
      state = onState;
      commands = onCommands;
      return vi.fn();
    }),
  } as unknown as DaemonApiClient;
  return { api, connected: () => state?.(true, { pushIntake: true, connectionPresence: true }),
    disconnected: () => state?.(false),
    unsupported: () => state?.(true, { pushIntake: false, connectionPresence: true }),
    push: (rows: AgentCommand[]) => commands?.(rows) };
}

describe('command intake mechanics', () => {
  it('demonstrates R2a–R2f: user messages receive answers over HTTP and live WebSocket after failures', async () => {
    const abort = new AbortController();
    const ctx = await context();
    // An actual disk error on the first entry; receipt handling repairs the directory.
    await rm(join(ctx.path, '..'), { recursive: true });
    await writeFile(join(ctx.path, '..'), 'blocked');
    const queued = new Map<string, AgentCommand>();
    const rows = new Map<string, AgentCommand>();
    const answers: string[] = [];
    const claims: string[] = [];
    let claimFailure = true;
    let requeued = false;
    let firstLeave = true;
    const errors: unknown[] = [];
    const push = () => {
      for (const socket of sockets.clients) socket.send(JSON.stringify({
        type: 'commands', roomId: 'room', agentId: 'agent', commandProtocol: 1,
        commands: [...queued.values()],
      }));
    };
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      res.setHeader('content-type', 'application/json');
      if (req.url === '/messages') {
        const row = { ...command(input.id), turnRequestId: input.id,
          source: { ...command(input.id).source, body: input.body } };
        rows.set(row.id, row);
        queued.set(row.id, row);
        push();
      } else if (req.url?.endsWith('/getAgentCommands')) {
        res.end(JSON.stringify({ commandProtocol: 1, commands: [...queued.values()] }));
        return;
      } else if (req.url?.endsWith('/claimAgentCommand')) {
        claims.push(input.commandId);
        if (claimFailure) {
          claimFailure = false;
          res.statusCode = 503;
          res.setHeader('retry-after', '0.3');
          res.end(JSON.stringify({ error: 'temporarily_unavailable' }));
          return;
        }
        queued.delete(input.commandId);
      } else if (req.url?.endsWith('/postAgentTurnReceipt') && input.status === 'failed') {
        expect(input.generationId).toBe(ctx.generationId);
        await rm(join(ctx.path, '..'));
        await mkdir(join(ctx.path, '..'));
        queued.set(input.requestId, rows.get(input.requestId)!);
        push();
      } else if (req.url?.endsWith('/postRoomMessage')) {
        expect(input.generationId).toBe(ctx.generationId);
        answers.push(input.text);
      }
      res.end(JSON.stringify({ id: 'ok' }));
    });
    const sockets = new WebSocketServer({ server });
    sockets.on('connection', (socket) => socket.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'register') socket.send(JSON.stringify({ type: 'registered', agentId: 'agent' }));
      if (frame.type === 'subscribe') {
        socket.send(JSON.stringify({ type: 'subscribed', roomId: 'room', agentId: 'agent',
          capabilities: { pushIntake: true, connectionPresence: true } }));
        push();
      }
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    const api = new DaemonApiClient(origin, 'test-token', 'agent');
    const offWatch = api.liveSubscribe('room');
    const onLeave = vi.fn(() => {
      if (firstLeave) { firstLeave = false; throw new Error('onLeave failure'); }
    });
    const leave = ctx.leave.bind(ctx);
    vi.spyOn(ctx, 'leave').mockImplementation(async () => {
      if (ctx.current) { await leave(); throw new Error('leave failure'); }
      await leave();
    });
    const running = runServerCommandIntake({ api, roomId: 'room', agentId: 'agent',
      context: ctx, signal: abort.signal, stop: vi.fn(), onLeave,
      onError: (error) => errors.push(error),
      run: async (row) => {
        if (!requeued) {
          requeued = true;
          queued.set(row.id, row);
          push();
          push();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await ctx.bind(api).execute('postRoomMessage', { roomId: 'room', text: `Answer: ${row.source.body}` });
      } });
    try {
      await vi.waitFor(() => expect(api.metrics().subscriptionsSent).toBeGreaterThanOrEqual(2));
      offWatch();
      for (const id of ['first', 'next']) {
        await fetch(`${origin}/messages`, { method: 'POST', body: JSON.stringify({ id, body: id }) });
        if (id === 'first') await vi.waitFor(() => expect(answers).toHaveLength(2), { timeout: 3000 });
      }
      await vi.waitFor(() => expect(answers).toHaveLength(3), { timeout: 3000 });
      expect(answers).toEqual(['Answer: first', 'Answer: first', 'Answer: next']);
      expect(claims.filter((id) => id === 'first')).toHaveLength(4);
      expect(errors.map((error) => String(error))).toEqual(expect.arrayContaining([
        expect.stringMatching(/EEXIST/), 'Error: onLeave failure', 'Error: leave failure',
      ]));
      console.log(`Demonstrated R2a–R2f: user sees ${answers.join(' | ')}; transient claim, disk entry, watch disposal, repeated requeue, and leave failures recovered.`);
    } finally {
      abort.abort();
      await running;
      api.closeLive();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(ctx.current).toBeUndefined();
  });

  it('R2c: reclaims a socket-delivered requeue with a real DaemonApiClient', async () => {
    class Socket {
      readyState = 0;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      send(value: string) {
        if (JSON.parse(value).type === 'register') this.message({ type: 'registered' });
      }
      message(value: Record<string, unknown>) {
        this.onmessage?.({ data: JSON.stringify({ ...value, agentId: 'agent' }) });
      }
      close() { this.readyState = 3; this.onclose?.(); }
      terminate() { this.close(); }
    }
    const socket = new Socket();
    const request = vi.fn<typeof fetch>(async () => Response.json({ commandProtocol: 1, commands: [] }));
    const api = new DaemonApiClient('http://127.0.0.1:43123', 'token', 'agent', request,
      (() => socket) as DaemonWebSocketFactory);
    const abort = new AbortController();
    let release = () => {};
    const run = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockImplementationOnce(async () => abort.abort());
    const running = runServerCommandIntake({ api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, run, stop: vi.fn() });
    await vi.waitFor(() => expect(socket.onopen).toBeDefined());
    socket.readyState = 1;
    socket.onopen?.();
    const frame = { type: 'commands', roomId: 'room', commandProtocol: 1, commands: [command()] };
    socket.message(frame);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    socket.message(frame);
    socket.message(frame);
    expect(run).toHaveBeenCalledOnce();
    release();
    const timeout = setTimeout(() => abort.abort(), 600);
    await running;
    clearTimeout(timeout);
    api.closeLive();
    expect(run).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([url]) => String(url).endsWith('/claimAgentCommand'))).toHaveLength(2);
  });

  it('R2d: retries a transient claim in the same generation and runs once', async () => {
    const abort = new AbortController();
    const ctx = await context();
    let claims = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [command()] };
      if (name === 'claimAgentCommand' && ++claims === 1) throw new DaemonApiError('x', 503, true);
      return { id: 'ok' };
    });
    const run = vi.fn(async () => abort.abort());
    const timeout = setTimeout(() => abort.abort(), 1000);
    await runServerCommandIntake({ api: socketApi(execute).api, roomId: 'room', agentId: 'agent',
      context: ctx, signal: abort.signal, run, stop: vi.fn() });
    clearTimeout(timeout);
    expect(run).toHaveBeenCalledOnce();
    const attempts = execute.mock.calls.filter(([name]) => name === 'claimAgentCommand');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
  });

  it.each([409, 403])('R2d: treats a %s claim refusal as final', async (status) => {
    const abort = new AbortController();
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [command()] };
      throw new DaemonApiError('refused', status, false);
    });
    const onClaimFailed = vi.fn(() => abort.abort());
    const run = vi.fn();
    await runServerCommandIntake({ api: socketApi(execute).api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, run, stop: vi.fn(), onClaimFailed });
    expect(execute.mock.calls.filter(([name]) => name === 'claimAgentCommand')).toHaveLength(1);
    expect(onClaimFailed).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it('R2d: honors Retry-After, bounds backoff, and throws exhaustion to the supervisor', async () => {
    vi.useFakeTimers();
    const ctx = await context();
    const error = new DaemonApiError('unavailable', 503, true, 'unavailable', 800);
    const times: number[] = [];
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [command()] };
      times.push(Date.now());
      throw error;
    });
    const onClaimFailed = vi.fn();
    const run = vi.fn();
    const failed = runServerCommandIntake({ api: socketApi(execute).api, roomId: 'room', agentId: 'agent',
      context: ctx, run, stop: vi.fn(), onClaimFailed }).catch((err) => err);
    await vi.advanceTimersByTimeAsync(0);
    expect(times).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(799);
    expect(times).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(800);
    expect(times).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await failed).toBe(error);
    expect(times.slice(1).map((time, i) => time - times[i]!)).toEqual([800, 800, 1000]);
    expect(onClaimFailed).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it('R2d: aborts a claim backoff without another attempt or a busy mark', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [command()] };
      throw new DaemonApiError('unavailable', 503, true, 'unavailable', 10_000);
    });
    const onClaimFailed = vi.fn();
    const running = runServerCommandIntake({ api: socketApi(execute).api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, run: vi.fn(), stop: vi.fn(), onClaimFailed });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await running;
    expect(execute.mock.calls.filter(([name]) => name === 'claimAgentCommand')).toHaveLength(1);
    expect(onClaimFailed).toHaveBeenCalledOnce();
  });

  it('R2d: retries a lost network response with the same claim identity', async () => {
    const abort = new AbortController();
    let claims = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [command()] };
      if (++claims === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      return { id: 'ok' };
    });
    const run = vi.fn(async () => abort.abort());
    await runServerCommandIntake({ api: socketApi(execute).api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, run, stop: vi.fn() });
    expect(run).toHaveBeenCalledOnce();
    const attempts = execute.mock.calls.filter(([name]) => name === 'claimAgentCommand');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
  });

  it('R2e: releases a failed context entry, posts failure, and runs the next input', async () => {
    const abort = new AbortController();
    const ctx = await context();
    const enter = ctx.enter.bind(ctx);
    const error = new Error('disk failure');
    vi.spyOn(ctx, 'enter').mockImplementationOnce(async (cmd) => { ctx.current = cmd; throw error; })
      .mockImplementation(enter);
    const execute = vi.fn(async (name: string) => name === 'getAgentCommands'
      ? { commandProtocol: 1, commands: [command('broken'), command('next')] } : { id: 'ok' });
    const onClaimFailed = vi.fn();
    const onError = vi.fn();
    const run = vi.fn(async () => abort.abort());
    let failure: unknown;
    await runServerCommandIntake({ api: socketApi(execute).api, roomId: 'room', agentId: 'agent',
      context: ctx, signal: abort.signal, run, stop: vi.fn(), onClaimFailed, onError })
      .catch((err) => { failure = err; });
    expect(failure).toBeUndefined();
    expect(onClaimFailed).toHaveBeenCalledWith(command('broken'));
    expect(ctx.current).toBeUndefined();
    expect(execute).toHaveBeenCalledWith('postAgentTurnReceipt', expect.objectContaining({
      roomId: 'room', requestId: 'turn', generationId: ctx.generationId, status: 'failed',
    }));
    expect(run).toHaveBeenCalledWith(command('next'));
    expect(onError).toHaveBeenCalledWith(error);
  });

  it.each(['onLeave', 'leave'])('R2f: runs the next input after %s fails', async (step) => {
    const abort = new AbortController();
    const ctx = await context();
    const error = new Error('release failure');
    const onLeave = vi.fn();
    if (step === 'onLeave') onLeave.mockImplementationOnce(() => { throw error; });
    else vi.spyOn(ctx, 'leave').mockRejectedValueOnce(error);
    const execute = vi.fn(async (name: string) => name === 'getAgentCommands'
      ? { commandProtocol: 1, commands: [command('first'), command('next')] } : { id: 'ok' });
    const run = vi.fn(async (cmd: AgentCommand) => { if (cmd.id === 'next') abort.abort(); });
    const onError = vi.fn();
    const timeout = setTimeout(() => abort.abort(), 600);
    await runServerCommandIntake({ api: socketApi(execute).api, roomId: 'room', agentId: 'agent',
      context: ctx, signal: abort.signal, run, stop: vi.fn(), onLeave, onError }).catch(() => {});
    clearTimeout(timeout);
    expect(run.mock.calls.map(([cmd]) => cmd.id)).toEqual(['first', 'next']);
    expect(onError).toHaveBeenCalledWith(error);
    expect(ctx.current).toBeUndefined();
  });

  it('reports push subscription loss and recovery without reading the server on disconnect', async () => {
    const abort = new AbortController();
    const execute = vi.fn(async (name: string) => name === 'getAgentCommands'
      ? { commandProtocol: 1, commands: [] } : { id: 'ok' });
    const socket = socketApi(execute);
    const states: boolean[] = [];
    const running = runServerCommandIntake({ api: socket.api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, run: vi.fn(), stop: vi.fn(),
      onSubscriptionState: (connected) => states.push(connected) });
    await vi.waitFor(() => expect(socket.api.liveSubscribe).toHaveBeenCalledOnce());
    socket.connected();
    socket.disconnected();
    socket.unsupported();
    expect(states).toEqual([true, false, false]);
    expect(execute.mock.calls.map(([name]) => name)).toEqual(['getAgentCommands']);
    abort.abort();
    await running;
  });
  it('refuses an older server without reading shared traffic', async () => {
    const execute = vi.fn(async () => ({ items: [command().source] }));
    await expect(runServerCommandIntake({ api: { execute } as unknown as DaemonApiClient,
      roomId: 'room', agentId: 'agent', context: await context(), run: vi.fn(), stop: vi.fn(),
    })).rejects.toThrow('protocol');
    expect(execute.mock.calls.map((call) => call[0])).toEqual(['getAgentCommands']);
  });
  it('rejects wrong-target and malformed commands', () => {
    for (const row of [{ ...command(), agentId: 'other' }, { ...command(), roomId: 'other' },
      { ...command(), agentDepth: 4 }, { ...command(), action: 'message' }])
      expect(() => validateServerCommand(row as AgentCommand, 'room', 'agent')).toThrow();
  });
  it('takes no recurring server reads during hours of connected idle time and reconciles once per reconnect', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const execute = vi.fn(async (name: string) => name === 'getAgentCommands'
      ? { commandProtocol: 1, commands: [] } : { id: 'ok' });
    const socket = socketApi(execute);
    const running = runServerCommandIntake({ api: socket.api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, run: vi.fn(), stop: vi.fn() });
    await vi.waitFor(() => expect(socket.api.liveSubscribe).toHaveBeenCalledOnce());
    socket.connected();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(execute.mock.calls.map(([name]) => name)).toEqual(['getAgentCommands']);
    socket.disconnected();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(execute).toHaveBeenCalledTimes(1);
    socket.connected();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(execute).toHaveBeenCalledTimes(2);
    abort.abort();
    await running;
  });
  it('claims a pushed command once and forwards release identity', async () => {
    const abort = new AbortController();
    const execute = vi.fn(async (name: string) => name === 'getAgentCommands'
      ? { commandProtocol: 1, commands: [] } : { id: 'ok' });
    const socket = socketApi(execute);
    const run = vi.fn(async () => abort.abort());
    const presence = { releaseVersion: 'v0.0.68', sourceSha: 'db2618408a205a3f319d26017a953725e7f13b61' };
    const running = runServerCommandIntake({ api: socket.api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, presence, run, stop: vi.fn() });
    await vi.waitFor(() => expect(socket.api.liveSubscribe).toHaveBeenCalledOnce());
    socket.connected();
    socket.push([command(), command()]);
    await running;
    expect(execute.mock.calls.filter(([name]) => name === 'claimAgentCommand')).toHaveLength(1);
    expect(run).toHaveBeenCalledOnce();
    expect(socket.api.liveSubscribe).toHaveBeenCalledWith('room', undefined, undefined,
      expect.any(Function), presence, expect.any(Function));
  });
  it('exits when shutdown aborts during an asynchronous closed check', async () => {
    const abort = new AbortController();
    const execute = vi.fn(async () => ({ commandProtocol: 1, commands: [] }));
    const socket = socketApi(execute);
    const closed = vi.fn(async () => {
      abort.abort();
      return false;
    });
    await runServerCommandIntake({ api: socket.api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, closed, run: vi.fn(), stop: vi.fn() });
    expect(closed).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('processes a pushed stop while an input is running', async () => {
    const abort = new AbortController();
    let release = () => {};
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const stop = vi.fn(() => { release(); abort.abort(); });
    const execute = vi.fn(async (name: string) => name === 'getAgentCommands'
      ? { commandProtocol: 1, commands: [command('input')] } : { id: 'ok' });
    const socket = socketApi(execute);
    const running = runServerCommandIntake({ api: socket.api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, run, stop });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    socket.push([command('stop', 'stop')]);
    await running;
    expect(stop).toHaveBeenCalledWith('turn');
    expect(execute).toHaveBeenCalledWith('acknowledgeAgentCommand', expect.anything());
  });
  it('claims a command the server requeued mid-run again once that run ends, in the same process', async () => {
    const abort = new AbortController();
    let release = () => {};
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockImplementationOnce(async () => abort.abort());
    const execute = vi.fn(async (name: string) => name === 'getAgentCommands'
      ? { commandProtocol: 1, commands: [command()] } : { id: 'ok' });
    const socket = socketApi(execute);
    const running = runServerCommandIntake({ api: socket.api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, run, stop: vi.fn() });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    // The server failed the stalled turn and requeued the same command.
    socket.push([command()]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(run).toHaveBeenCalledOnce();
    release();
    await running;
    expect(run).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.filter(([name]) => name === 'claimAgentCommand')).toHaveLength(2);
  });
  it('binds output to the claimed generation and request', async () => {
    const ctx = await context();
    await ctx.enter(command());
    const execute = vi.fn(async () => ({ id: 'ok' }));
    await ctx.bind({ execute } as unknown as DaemonApiClient)
      .execute('postAgentAttachment', { roomId: 'room', attachment: { url: 'url' } });
    expect(execute).toHaveBeenCalledWith('postAgentAttachment',
      expect.objectContaining({ requestId: 'turn', generationId: ctx.generationId }));
  });
  // C112: RoomRuntimeCoordinator.reconcile's repository-revision restart
  // reads a room's `body.isBusy()` to decide whether it is safe to stop and
  // restart. That flag used to flip only once `run()` got around to calling
  // `prompt()`, deep inside the caller - leaving a real window, spanning the
  // claim's own network round trip AND `context.enter()`'s own file I/O,
  // where the caller's turn had already been claimed (or was about to be)
  // but every busy check still read `false`. A same-tick repository-
  // revision reconcile landing in that window stopped the loop (its own
  // shutdown then cancelled the just-claimed command), reporting "stopped
  // by the requester" even though nobody asked - reproduced under induced
  // CPU contention, never without it, since the window is normally a
  // handful of microtasks wide. `onClaiming` exists to close that window: it
  // must fire before the claim attempt even starts, and `onClaimFailed`
  // undoes it if the claim itself is refused, so a caller marks itself busy
  // for exactly as long as (and no less than) it might actually run a turn.
  it('marks a command claiming before the claim round trip and context.enter settle (C112)', async () => {
    const abort = new AbortController();
    const order: string[] = [];
    const ctx = await context();
    const realEnter = ctx.enter.bind(ctx);
    let releaseEnter = () => {};
    const entryGate = new Promise<void>((resolve) => {
      releaseEnter = resolve;
    });
    vi.spyOn(ctx, 'enter').mockImplementation(async (cmd) => {
      order.push('entering');
      await entryGate;
      await realEnter(cmd);
      order.push('entered');
    });
    const run = vi.fn(async () => {
      order.push('run');
      abort.abort();
    });
    let releaseClaim = () => {};
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [command()] };
      if (name === 'claimAgentCommand') {
        order.push('claiming');
        await claimGate;
        return { id: 'ok' };
      }
      return { id: 'ok' };
    });
    const onClaiming = vi.fn(() => order.push('marked-busy'));
    const running = runServerCommandIntake({
      api: { execute } as unknown as DaemonApiClient,
      roomId: 'room',
      agentId: 'agent',
      context: ctx,
      signal: abort.signal,
      run,
      stop: vi.fn(),
      onClaiming,
    });
    await vi.waitFor(() => expect(onClaiming).toHaveBeenCalledOnce());
    // Marked busy before the claim's own network round trip even starts -
    // exactly the earlier, wider window a same-tick reconcile busy-check
    // used to see as idle and stop.
    expect(order).toEqual(['marked-busy', 'claiming']);
    releaseClaim();
    await vi.waitFor(() => expect(order).toContain('entering'));
    expect(order).toEqual(['marked-busy', 'claiming', 'entering']);
    releaseEnter();
    await running;
    expect(order).toEqual(['marked-busy', 'claiming', 'entering', 'entered', 'run']);
  });
  it('undoes the busy mark when the claim itself is refused (C112)', async () => {
    const abort = new AbortController();
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [command()] };
      if (name === 'claimAgentCommand') throw new Error('command claim conflict');
      return { id: 'ok' };
    });
    const onClaiming = vi.fn();
    const onClaimFailed = vi.fn();
    const onError = vi.fn(() => abort.abort());
    await runServerCommandIntake({
      api: { execute } as unknown as DaemonApiClient,
      roomId: 'room',
      agentId: 'agent',
      context: await context(),
      signal: abort.signal,
      run: vi.fn(),
      stop: vi.fn(),
      onClaiming,
      onClaimFailed,
      onError,
    });
    expect(onClaiming).toHaveBeenCalledOnce();
    expect(onClaimFailed).toHaveBeenCalledOnce();
  });
});
