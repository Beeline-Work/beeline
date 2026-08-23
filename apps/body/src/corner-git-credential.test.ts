import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  loadRuntimeForRoom,
  runCornerGitCredentialCommand,
} from './corner-git-credential.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { newIdentity } from '@beeline/gate';

const cleanup: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(`${tmpdir()}/${prefix}-`);
  cleanup.push(path);
  return path;
}

function runtimeRecord(rooms: string[]): AgentRuntimeRecord {
  // A real keypair: readRuntimeRecord verifies the stored agent identity
  // cryptographically, exactly as it does for a paired daemon.
  const agentIdentity = newIdentity('test-agent');
  const bodyIdentity = newIdentity('test-body');
  return {
    version: 2,
    communityId: '11111111-1111-4111-8111-111111111111',
    pairedBy: 'a'.repeat(64),
    agent: {
      name: 'test-agent',
      secretKeyHex: Buffer.from(agentIdentity.secretKey).toString('hex'),
      publicKey: agentIdentity.publicKey,
    },
    body: {
      name: 'test-body',
      secretKeyHex: Buffer.from(bodyIdentity.secretKey).toString('hex'),
      publicKey: bodyIdentity.publicKey,
    },
    rooms: rooms.map((channelId) => ({
      channelId,
      repo: { root: '/tmp/does-not-matter' },
      membershipSince: 10,
      discoveredAt: new Date(0).toISOString(),
    })),
    supervisorRoot: '/tmp/state-root',
    relayBaseUrl: 'https://relay.test',
    agentBinary: '/usr/bin/agent',
    mcpBinary: '/usr/bin/mcp',
    createdAt: new Date(0).toISOString(),
  } as unknown as AgentRuntimeRecord;
}

async function writeRuntime(configPath: string, record: AgentRuntimeRecord): Promise<void> {
  await mkdir(resolve(configPath, '..'), { recursive: true });
  await writeFile(configPath, JSON.stringify(record), 'utf8');
}

describe('corner-git-credential command', () => {
  it('mints ONLY the read-only token variant and prints git credentials', async () => {
    const calls: Array<{ baseUrl: string; roomId: string; options: { readOnly?: boolean } }> = [];
    const exitCode = await runCornerGitCredentialCommand(
      ['--config', '/tmp/runtime.json', '--room', 'room-1', 'get'],
      {
        loadRuntimeForRoom: async () => ({
          relayBaseUrl: 'https://relay.test',
          identity: { secretKey: '22'.repeat(32) as `33`, publicKey: 'b'.repeat(64) },
        }),
        fetchToken: async (baseUrl, _identity, roomId, options) => {
          calls.push({ baseUrl, roomId, options });
          return {
            token: 'ro-secret-token',
            expiresAt: '2030-01-01T00:00:00Z',
            installationId: 42,
            fullName: 'acme/widget',
          };
        },
      },
    );

    // Regression pin: this credential path NEVER asks for a writable token.
    expect(calls).toEqual([
      {
        baseUrl: 'https://relay.test',
        roomId: 'room-1',
        options: { readOnly: true },
      },
    ]);
    expect(exitCode).toBe(0);
  });

  it('fails without minting when --config or --room is missing', async () => {
    const fetchToken = vi.fn();
    expect(await runCornerGitCredentialCommand(['--room', 'room-1'], { fetchToken })).toBe(2);
    expect(await runCornerGitCredentialCommand(['--config', '/x.json'], { fetchToken })).toBe(2);
    expect(fetchToken).not.toHaveBeenCalled();
  });

  it('answers with a real auth-service request carrying read_only and no repository name', async () => {
    const stateRoot = await tempDir('beeline-cred-state');
    const configPath = resolve(stateRoot, 'agents', 'b'.repeat(64), 'runtime.json');
    await writeRuntime(configPath, runtimeRecord(['22222222-2222-4222-8222-222222222222']));

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: { body?: unknown }) => {
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : {};
        requests.push({ url: String(url), body });
        return new Response(
          JSON.stringify({
            token: 'ro-token-from-auth',
            expires_at: '2030-01-01T00:00:00Z',
            installation_id: 77,
            full_name: 'octocat/widget',
          }),
          { status: 200 },
        );
      }),
    );

    // Capture stdout instead of spawning: the command writes the credential
    // protocol answer to stdout.
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const exitCode = await runCornerGitCredentialCommand([
        '--config',
        configPath,
        '--room',
        '22222222-2222-4222-8222-222222222222',
      ]);
      expect(exitCode).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(writes.join('')).toContain('username=x-access-token');
    expect(writes.join('')).toContain('password=ro-token-from-auth');
    expect(requests).toHaveLength(1); // only the room-token POST (the 16 relay proofs are signed locally)
    const mintRequest = requests.find(({ url }) => url.endsWith('/auth/github/room-token'))!;
    expect(mintRequest).toBeDefined();
    // The session never names a repository; read_only is the whole ask.
    expect(mintRequest.body.read_only).toBe(true);
    expect(mintRequest.body.room_id).toBe('22222222-2222-4222-8222-222222222222');
    expect(mintRequest.body).not.toHaveProperty('repository');
    expect(mintRequest.body).not.toHaveProperty('repo');
  });

  it('refuses to mint through an unrelated runtime record', async () => {
    const stateRoot = await tempDir('beeline-cred-state-other');
    const configPath = resolve(stateRoot, 'agents', 'b'.repeat(64), 'runtime.json');
    await writeRuntime(configPath, runtimeRecord(['99999999-9999-4999-8999-999999999999']));
    const env = { ...process.env, XDG_STATE_HOME: stateRoot };

    const resolved = await loadRuntimeForRoom('22222222-2222-4222-8222-222222222222', env);
    expect(resolved).toBeUndefined();

    const fetchToken = vi.fn();
    const exitCode = await runCornerGitCredentialCommand(
      ['--config', configPath, '--room', '22222222-2222-4222-8222-222222222222'],
      { fetchToken },
    );
    expect(exitCode).toBe(1);
    expect(fetchToken).not.toHaveBeenCalled();
  });

  it('keeps token material out of stderr when the mint fails', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(' '));
    try {
      const exitCode = await runCornerGitCredentialCommand(
        ['--config', '/tmp/runtime.json', '--room', 'room-1'],
        {
          loadRuntimeForRoom: async () => ({
            relayBaseUrl: 'https://relay.test',
            identity: { secretKey: 'k' as never, publicKey: 'p' },
          }),
          fetchToken: async () => {
            throw new Error('auth refused: HTTP 403 secret ro-pending-token leaked?');
          },
        },
      );
      expect(exitCode).toBe(1);
    } finally {
      console.error = originalError;
    }
    const joined = errors.join('\n');
    expect(joined).toContain('read-only repository token unavailable');
  });
});
