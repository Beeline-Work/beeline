import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { DaemonApiClient, type DaemonWebSocketFactory } from './daemon-api-client.js';
import { withTurnReceiptHeartbeat } from './turn-receipt-heartbeat.js';
import { CommandExecutionContext } from './server-command-intake.js';

const agent = 'a'.repeat(64), source = { connectionId: 'synthetic-turn-owner', epoch: 1 };
const turn = { agentId: agent, roomId: 'room', requestId: 'request', generationId: 'generation' };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
class Socket extends EventEmitter {
  readyState = 0; onopen?: () => void; onclose?: () => void; onmessage?: (value: { data: string }) => void;
  frames: Record<string, any>[] = []; hold = false; malformed = false;
  constructor(readonly capable: boolean, readonly invalidSource = false) { super(); }
  receive(frame: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify({ agentId: agent, ...frame }) }); }
  send(raw: string) {
    const frame = JSON.parse(raw); this.frames.push(frame);
    if (frame.type === 'register') this.receive({ type: 'registered', capabilities: this.capable
      ? { turnOwnershipV1: true, turnConnectionId: source.connectionId,
        ...(this.invalidSource ? {} : { turnConnectionEpoch: source.epoch }), intakeHeartbeat: false, initialSnapshotsV1: true }
      : { intakeHeartbeat: true } });
    if (frame.type === 'subscribe') {
      this.receive({ type: 'commands', roomId: frame.roomId, requestId: frame.requestId, commandProtocol: 1, commands: [] });
      this.receive({ type: 'inbox', roomId: frame.roomId, requestId: frame.requestId, items: [] });
      this.receive({ type: 'subscribed', roomId: frame.roomId, requestId: frame.requestId,
        capabilities: { pushIntake: true, initialSnapshotsV1: true, inboxSnapshot: frame.inbox !== false } });
    }
    if (frame.type === 'turn-operation' && !this.hold) this.receive({ type: 'turn-result', requestId: frame.requestId,
      result: this.malformed ? {} : { id: 'write', createdAt: 1 } });
  }
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
  close() { this.terminate(); }
}
const cleanup: Array<() => void> = [];
afterEach(() => { for (const release of cleanup.splice(0)) release(); vi.useRealTimers(); });
function fixture(capable = true, invalidSource = false) {
  const socket = new Socket(capable, invalidSource), fetcher = vi.fn(async () => Response.json({ id: 'legacy', createdAt: 1 }));
  const api = new DaemonApiClient('http://synthetic.invalid', 'bdt_synthetic', agent, fetcher,
    (() => socket as unknown as WebSocket) as DaemonWebSocketFactory);
  cleanup.push(() => api.closeLive()); api.liveSubscribe('room'); socket.readyState = 1; socket.onopen?.();
  return { api, socket, fetcher };
}

describe('actual owned turn machine adapter', () => {
  it('uses zero HTTP and zero freshness frames for a ten-minute claimed turn, while transport pings remain separate', async () => {
    vi.useFakeTimers();
    const { api, socket, fetcher } = fixture();
    await api.execute('claimAgentCommand', { roomId: turn.roomId, commandId: 'command', generationId: turn.generationId });
    const lost = vi.fn(); api.noteOwnedTurnClaim(turn, source, lost);
    const task = deferred<string>();
    const running = withTurnReceiptHeartbeat(api, turn, () => task.promise, vi.fn(), lost);
    const applicationFrames = socket.frames.length;
    for (let i = 0; i < 20; i += 1) { await vi.advanceTimersByTimeAsync(30_000); socket.emit('ping'); }
    expect(socket.frames).toHaveLength(applicationFrames);
    expect(fetcher).not.toHaveBeenCalled(); expect(lost).not.toHaveBeenCalled();
    task.resolve('done'); await expect(running).resolves.toBe('done');
    await api.execute('postAgentTurnReceipt', { ...turn, status: 'complete' });
    await api.execute('acknowledgeAgentCommand', { roomId: 'room', commandId: 'stop', generationId: turn.generationId });
    expect(socket.frames.filter(frame => frame.type === 'turn-operation').map(frame => frame.operation))
      .toEqual(['claimAgentCommand', 'postAgentTurnReceipt', 'acknowledgeAgentCommand']);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retains the explicit legacy claim adapter without treating negotiation alone as a successful owned claim', async () => {
    vi.useFakeTimers();
    const { api, socket, fetcher } = fixture(false);
    await api.execute('claimAgentCommand', { roomId: 'room', commandId: 'legacy', generationId: 'generation' });
    api.noteLegacyTurnClaim(turn);
    const task = deferred<void>();
    const running = withTurnReceiptHeartbeat(api, turn, () => task.promise, vi.fn());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(2); // Explicit old claim plus its compatibility receipt.
    expect(socket.frames.some(frame => frame.type === 'turn-operation')).toBe(false);
    task.resolve(); await running;
    const selected = fixture(); const neverStarted = vi.fn(async () => undefined);
    await expect(withTurnReceiptHeartbeat(selected.api, turn, neverStarted, vi.fn())).rejects.toThrow('not admitted');
    expect(neverStarted).not.toHaveBeenCalled(); expect(selected.fetcher).not.toHaveBeenCalled();
  });

  it('cancels once on source loss and never downgrades the same pending/terminal identity to HTTP', async () => {
    const { api, fetcher } = fixture();
    await api.execute('claimAgentCommand', { roomId: 'room', commandId: 'command', generationId: 'generation' });
    const lost = vi.fn(); api.noteOwnedTurnClaim(turn, source, lost);
    const task = deferred<void>(), running = withTurnReceiptHeartbeat(api, turn, () => task.promise, vi.fn(), lost);
    api.closeLive(); api.closeLive(); expect(lost).toHaveBeenCalledTimes(1);
    await expect(api.execute('postAgentTurnReceipt', { ...turn, status: 'complete' })).rejects.toThrow('UNKNOWN');
    expect(fetcher).not.toHaveBeenCalled(); task.resolve(); await running;
    api.releaseOwnedTurn(turn);
    await expect(api.runWithTurnOwnership(turn, async () => 'invalid')).rejects.toThrow('already ended');
  });

  it('keeps an uncertain claim command/generation stable and sends nothing more until an explicit recovery', async () => {
    vi.useFakeTimers();
    const { api, socket, fetcher } = fixture(); socket.hold = true;
    const input = { roomId: 'room', commandId: 'command', generationId: 'generation' };
    const pending = api.execute('claimAgentCommand', input).catch(error => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).message).toContain('UNKNOWN');
    for (let i = 0; i < 20; i += 1) { await vi.advanceTimersByTimeAsync(30_000); socket.emit('ping'); }
    expect(socket.frames.filter(frame => frame.type === 'turn-operation')).toHaveLength(1);
    socket.hold = false;
    await api.execute('claimAgentCommand', input); // One explicit recovery, same durable identity.
    const frames = socket.frames.filter(frame => frame.type === 'turn-operation');
    expect(frames.map(frame => frame.input)).toEqual([input, input]);
    expect(frames[0]!.requestId).not.toBe(frames[1]!.requestId);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses malformed selected registration and malformed replies without HTTP fallback', async () => {
    const invalid = fixture(true, true);
    await expect(invalid.api.execute('claimAgentCommand', { roomId: 'room', commandId: 'command', generationId: 'generation' })).rejects.toThrow('UNKNOWN');
    expect(invalid.fetcher).not.toHaveBeenCalled();
    expect(invalid.socket.frames.some(frame => frame.type === 'turn-operation')).toBe(false);
    const malformed = fixture(); malformed.socket.malformed = true;
    await expect(malformed.api.execute('claimAgentCommand', { roomId: 'room', commandId: 'command', generationId: 'generation' })).rejects.toThrow('UNKNOWN');
    expect(malformed.fetcher).not.toHaveBeenCalled();
  });

  it('rotates a drained execution generation/file, retains uncertain claim identity, and never rebinds a generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-turn-owner-proof-'));
    try {
      const context = new CommandExecutionContext(root);
      context.prepareOwnership(source, 'command'); const oldPath = context.path, generation = context.generationId;
      context.prepareOwnership(source, 'command'); expect(context.generationId).toBe(generation);
      const command = { id: 'command', roomId: 'room', turnRequestId: 'request', rootCommandId: 'command', reason: 'human_mention' } as AgentCommand;
      await context.enter(command);
      expect(() => context.prepareOwnership({ ...source, epoch: 2 }, 'command')).toThrow('has not drained');
      await context.leave(); expect(await readFile(oldPath, 'utf8')).toBe('{}');
      context.prepareOwnership({ ...source, epoch: 2 }, 'command');
      expect(context.generationId).not.toBe(generation); expect(context.path).not.toBe(oldPath);
      const { api } = fixture(); api.noteOwnedTurnClaim(turn, source, vi.fn());
      expect(() => api.noteOwnedTurnClaim(turn, { ...source, epoch: 2 }, vi.fn())).toThrow('cannot change owner');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
