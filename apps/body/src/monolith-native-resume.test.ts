import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';
import type { WarmTranscript } from './warm-transcript.js';

type Loop = { activate(): Promise<string>; discardSession(preserve?: boolean): Promise<void>; warmTranscript: WarmTranscript };

it.each([
  ['room', 'codex', 'resume'], ['corner', 'codex', 'resume'],
  ['room', 'grok', 'resume'], ['corner', 'grok', 'resume'],
  ['room', 'claude', 'cold'], ['corner', 'claude', 'cold'],
  ['room', 'codex', 'lost'], ['corner', 'grok', 'lost'],
  ['room', 'codex', 'changed'], ['corner', 'grok', 'changed'],
] as const)('%s %s conversation after helper restart: %s', async (surface, harness, outcome) => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-native-restart-'));
  const identity = identityFromKey('11'.repeat(32), 'Bee');
  const runtime = { agent: { name: 'Bee', publicKey: identity.publicKey,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex') }, rooms: [],
    communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'test' },
  } as AgentRuntimeRecord;
  const command = harness === 'codex' ? '/fake/codex-acp' : harness === 'grok' ? '/fake/grok' : '/fake/claude-agent-acp';
  const config = { agentCommand: command, agentBinary: command, agentKind: harness, agentArgs: [],
    readonlyMcpCommand: '/fake/mcp', mcpBinary: '/fake/mcp', agentEnv: {},
    workspaceRoot: root, agentHomeRoot: join(root, 'agent-home'), operatorHome: join(root, 'operator'),
  } as BodyConfig;
  let name = 'Bee';
  const api = {
    execute: vi.fn(async (operation: string) => {
      if (operation === 'getAgentConfiguration') return { commands: [], yoloMode: false };
      if (operation === 'getWorkspaceRoster') return { members: [{ identityId: identity.publicKey, name, kind: 'agent' }] };
      if (operation === 'getRoomRepositoryState') return { resolution: 'none' };
      if (operation === 'listAgentGrants') return { grants: [] };
      if (operation === 'getCornerRestoreState') return { cornerId: 'surface', lifecycle: { lifecycle: 'working', checks: 'unknown' } };
      return { id: 'ok' };
    }),
    connection: () => ({ baseUrl: 'https://server.example', daemonToken: 'test', agentId: identity.publicKey }),
  };
  const scheduler = new SessionScheduler({ maxLiveSessions: 1 });
  const clients: AcpClient[] = [];
  const loops: Loop[] = [];
  const make = () => {
    const client = new AcpClient({ agentCommand: command, agentEnv: {} });
    clients.push(client);
    vi.spyOn(client, 'start').mockResolvedValue();
    vi.spyOn(client, 'stop').mockResolvedValue();
    vi.spyOn(client, 'isAlive', 'get').mockReturnValue(true);
    vi.spyOn(client, 'canLoadSession').mockReturnValue(true);
    vi.spyOn(client, 'sessionNew').mockResolvedValue({ sessionId: `native-${clients.length}`, raw: {} });
    vi.spyOn(client, 'sessionLoad').mockImplementation(async ({ sessionId }) => {
      if (outcome === 'lost') throw new Error('conversation expired');
      return { sessionId, raw: {} };
    });
    const options = { runtime, config, api: api as never, scheduler, createAcpClient: () => client };
    const loop = (surface === 'room'
      ? new MonolithRoomTurnLoop({ ...options, roomId: 'surface', workspaceId: 'workspace', cwd: root,
          signal: new AbortController().signal, health: { poll: () => undefined } })
      : new MonolithCornerTurnLoop({ ...options, cornerId: 'surface', parentRoomId: 'parent',
          workspaceId: 'workspace', objective: 'Answer the message', worktreePath: root,
          onPoll: () => undefined, onCloseRequested: async () => undefined })) as unknown as Loop;
    loops.push(loop);
    return loop;
  };
  const rows = [{ id: 'old', line: 'old message' }, { id: 'new', line: 'new message' }];
  try {
    const predecessor = make();
    const first = await predecessor.activate();
    predecessor.warmTranscript.select(first, rows.slice(0, 1));
    predecessor.warmTranscript.complete(first, ['completed-ask']);
    await predecessor.discardSession(true);
    if (outcome === 'changed') name = 'New name';
    const successor = make();
    const second = await successor.activate();
    if (outcome === 'resume') {
      expect(second).toBe(first);
      expect(clients[1]!.sessionNew).not.toHaveBeenCalled();
      expect(clients[1]!.sessionLoad).toHaveBeenCalledWith(expect.objectContaining({ sessionId: first,
        mode: surface === 'room' ? 'readonly' : 'edit' }));
      expect(successor.warmTranscript.select(second, rows).rows.map(row => row.id)).toEqual(['new']);
      expect(successor.warmTranscript.select(second, [{ id: 'completed-ask', line: 'completed' }]).rows).toEqual([]);
    } else {
      expect(second).not.toBe(first);
      expect(clients[1]!.sessionNew).toHaveBeenCalledOnce();
      expect(successor.warmTranscript.select(second, rows).rows).toHaveLength(2);
      if (outcome !== 'lost') expect(clients[1]!.sessionLoad).not.toHaveBeenCalled();
      if (harness === 'claude') await expect(readFile(join(config.agentHomeRoot!, 'warm-transcript.json')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally {
    for (const loop of loops) await loop.discardSession(true);
    await scheduler.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
