import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { CommandExecutionContext } from './server-command-intake.js';
import { identityFromKey } from './runtime.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.each(['room', 'corner'] as const)('%s sessions replace the MCP context captured for the previous order', async kind => {
  const root = await mkdtemp(join(process.cwd(), '.command-binding-'));
  roots.push(root);
  const identity = identityFromKey('11'.repeat(32), 'Bee');
  const options = {
    runtime: { agent: { ...identity, secretKeyHex: '11'.repeat(32) }, supervisorRoot: root },
    config: { workspaceRoot: root, agentHomeRoot: root },
    api: { execute: vi.fn() }, cwd: root, roomId: 'room', cornerId: 'room',
  };
  const loop = (kind === 'room'
    ? new MonolithRoomTurnLoop(options as never)
    : new MonolithCornerTurnLoop(options as never)) as unknown as {
      commandContext: CommandExecutionContext;
      sessionId?: string;
      sessionContextPath?: string;
      sessionCwd?: string;
      sessionFingerprint?: string;
      client?: { isAlive: boolean; stop: () => Promise<void> };
      refreshTurnCheckout: () => Promise<void>;
      currentSessionFingerprint: () => Promise<string>;
      sessionIsCurrent: () => Promise<boolean>;
      activate: () => Promise<string>;
      activateCold: () => Promise<string>;
      squireRelay: { listen: (path: string) => Promise<{ contextFile: string }>; close: () => void };
    };
  const context = loop.commandContext;
  const source = { connectionId: 'source', epoch: 1 };
  const command = (id: string) => ({ id, roomId: 'room', turnRequestId: id, rootCommandId: id, reason: 'human_message' }) as AgentCommand;
  context.prepareOwnership(source, 'first');
  await context.enter(command('first'));
  const captured = context.path;
  const stopped = vi.fn(async () => undefined);
  loop.client = { isAlive: true, stop: stopped };
  loop.sessionId = 'first-session';
  loop.sessionContextPath = captured;
  loop.sessionCwd = root;
  loop.sessionFingerprint = 'same-configuration';
  loop.refreshTurnCheckout = async () => undefined;
  loop.currentSessionFingerprint = async () => 'same-configuration';
  expect(await loop.sessionIsCurrent()).toBe(true);
  await context.leave();
  context.prepareOwnership(source, 'second');
  await context.enter(command('second'));
  expect(JSON.parse(await readFile(captured, 'utf8'))).toEqual({});
  expect(JSON.parse(await readFile(context.path, 'utf8')).requestId).toBe('second');
  try {
    // The retained process still has the old environment, even though config,
    // checkout and model match. It must drain before a new process is used.
    expect(await loop.sessionIsCurrent()).toBe(false);
    const cold = vi.fn(async () => {
      expect(stopped).toHaveBeenCalledOnce();
      const relay = await loop.squireRelay.listen(context.path);
      expect(relay.contextFile).toBe(context.path);
      expect(JSON.parse(await readFile(relay.contextFile, 'utf8')).requestId).toBe('second');
      return 'second-session';
    });
    loop.activateCold = cold;
    expect(await loop.activate()).toBe('second-session');
    expect(cold).toHaveBeenCalledOnce();
  } finally { loop.squireRelay.close(); await context.leave(); }
});
