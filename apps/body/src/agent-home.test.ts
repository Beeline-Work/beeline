import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { prepareRoomAgentHome, roomAgentHomeEnv } from './agent-home.js';

const cleanup: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('per-room harness state isolation', () => {
  it('points every harness state directory at this Room, and never overrides HOME', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    const roomA = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const roomB = resolve(await scratch('beeline-room-b-'), 'agent-home');

    const envA = await prepareRoomAgentHome({ root: roomA, operatorHome });
    const envB = await prepareRoomAgentHome({ root: roomB, operatorHome });

    for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) {
      expect(envA[key]).toBeTruthy();
      expect(envA[key]!.startsWith(roomA)).toBe(true);
      // Two Rooms of the same agent must not share a harness state directory.
      expect(envA[key]).not.toBe(envB[key]);
    }
    // Captain's decision D2: isolate state, share credentials. Overriding HOME
    // would move harness auth too.
    expect(envA.HOME).toBeUndefined();
    expect(envB.HOME).toBeUndefined();
    expect(existsSync(resolve(roomA, 'claude'))).toBe(true);
    expect(existsSync(resolve(roomA, 'tmp'))).toBe(true);
  });

  it('shares the operator credentials into every isolated state directory', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    await mkdir(resolve(operatorHome, '.claude'), { recursive: true });
    await mkdir(resolve(operatorHome, '.codex'), { recursive: true });
    await writeFile(resolve(operatorHome, '.claude/.credentials.json'), '{"token":"claude"}');
    await writeFile(resolve(operatorHome, '.codex/auth.json'), '{"token":"codex"}');

    const roomA = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const roomB = resolve(await scratch('beeline-room-b-'), 'agent-home');
    await prepareRoomAgentHome({ root: roomA, operatorHome });
    await prepareRoomAgentHome({ root: roomB, operatorHome });

    for (const root of [roomA, roomB]) {
      const claude = resolve(root, 'claude/.credentials.json');
      const codex = resolve(root, 'codex/auth.json');
      expect(readFileSync(claude, 'utf8')).toBe('{"token":"claude"}');
      expect(readFileSync(codex, 'utf8')).toBe('{"token":"codex"}');
      // Symlinked, not copied: a refreshed token stays shared with every other
      // room-instance and with the operator's own CLI.
      expect(lstatSync(claude).isSymbolicLink()).toBe(true);
      expect(lstatSync(codex).isSymbolicLink()).toBe(true);
    }
  });

  it('degrades to the daemon state instead of failing a Room it cannot isolate', async () => {
    const blocked = await scratch('beeline-blocked-');
    // A file where the agent home must go: mkdir fails, the Room must not.
    const root = resolve(blocked, 'agent-home');
    await writeFile(root, 'not a directory');

    await expect(prepareRoomAgentHome({ root })).resolves.toEqual({});
  });

  it('derives the env overlay without touching the filesystem', () => {
    const overlay = roomAgentHomeEnv('/rooms/room-a/agent-home');
    expect(overlay).toEqual({
      CLAUDE_CONFIG_DIR: '/rooms/room-a/agent-home/claude',
      CODEX_HOME: '/rooms/room-a/agent-home/codex',
      XDG_STATE_HOME: '/rooms/room-a/agent-home/state',
      XDG_CACHE_HOME: '/rooms/room-a/agent-home/cache',
      TMPDIR: '/rooms/room-a/agent-home/tmp',
    });
    expect(existsSync('/rooms/room-a/agent-home')).toBe(false);
  });
});
