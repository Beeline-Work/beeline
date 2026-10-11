import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { ThinDaemonCore } from './thin-core.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import type { DaemonApiClient } from './daemon-api-client.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('claims and answers in a pending Room while eighty other Room listings reconcile', async () => {
  const root = await mkdtemp(resolve(process.cwd(), '.fast-resume-'));
  vi.stubEnv('XDG_STATE_HOME', root);
  const agent = identityFromKey('11'.repeat(32), 'Bee');
  const rooms = Array.from({ length: 80 }, (_, i) => ({ roomId: `room-${i}`, archived: false }));
  const target = rooms.at(-1)!.roomId;
  const command: AgentCommand = {
    id: 'pending', roomId: target, agentId: agent.publicKey, sourceMessageId: 'human',
    turnRequestId: 'human', rootCommandId: 'pending', rootSourceMessageId: 'human',
    action: 'input', reason: 'human_tag', agentDepth: 0,
    source: { id: 'human', authorId: 'person', body: 'Are you back?', attachments: [], createdAt: 1, type: 'message' },
  };
  const startedAt = performance.now();
  let firstClaimMs: number | undefined;
  let answered = false;
  let listed = 0;
  const execute = vi.fn(async (name: string, input: { roomId?: string }) => {
    if (name === 'getDaemonBootstrap') return {
      workspaceIds: ['workspace'], rooms, pendingRooms: [{ roomId: target }],
    };
    if (name === 'listRoomCorners') {
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
      listed += 1;
      return { corners: [] };
    }
    if (name === 'getAgentCommands') return {
      commandProtocol: 1, commands: input.roomId === target && firstClaimMs === undefined ? [command] : [],
    };
    if (name === 'claimAgentCommand') { firstClaimMs = performance.now() - startedAt; return { id: 'claimed' }; }
    throw new Error(`unexpected operation ${name}`);
  });
  // Exercise the real core, coordinator and command intake without a provider or production account.
  vi.spyOn(MonolithRoomTurnLoop.prototype as unknown as { startPrompt(): void }, 'startPrompt')
    .mockImplementation(function (this: { busy: boolean }) { answered = true; this.busy = false; });
  const core = new ThinDaemonCore({
    agent: { publicKey: agent.publicKey, secretKeyHex: '11'.repeat(32), name: 'Bee' },
    rooms: [], communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'http://127.0.0.1', daemonToken: 'isolated-fixture' },
  } as unknown as AgentRuntimeRecord, resolve(root, 'agent.json'), { workspaceRoot: root } as never, {
    daemonApi: { execute, liveSubscribe: vi.fn(() => () => undefined) } as unknown as DaemonApiClient,
  });
  const abort = new AbortController();
  const running = core.run({ signal: abort.signal });
  try {
    await vi.waitFor(() => expect(answered).toBe(true));
    console.info('[isolated-fast-resume]', { rooms: rooms.length, firstClaimMs: Math.round(firstClaimMs!), listingsAtAnswer: listed });
    if (process.env.BEELINE_FAST_RESUME_BASELINE === '1') expect(listed).toBe(80);
    else expect(listed).toBeLessThan(80);
  } finally {
    abort.abort();
    await running;
    await rm(root, { recursive: true, force: true });
  }
});
