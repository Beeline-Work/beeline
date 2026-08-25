import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WORKBENCH_ENV,
  WORKBENCH_MAX_BYTES,
  WORKBENCH_MAX_INODES,
  detectWorkbenchScratchLeak,
  prepareSessionWorkbench,
  sweepSessionWorkbench,
  workbenchInstructions,
} from './workbench.js';
import { isAgentWorkbenchWritePermissionRequest } from './session-sandbox.js';
import { detectBwrapSandbox, wrapAgentCommand } from './bwrap-sandbox.js';
import type { SessionWorkbench } from './workbench.js';
import type { NostrEvent } from '@beeline/nostr';
import { AcpClient } from './acp.js';
import { Body } from './body.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workbench() {
  const root = await mkdtemp(join(tmpdir(), 'beeline-workbench-'));
  roots.push(root);
  const dir = join(root, 'agent-private', 'workbench');
  await mkdir(dir, { recursive: true });
  return {
    dir,
    storageDir: dir,
  } satisfies SessionWorkbench;
}

describe('Room workbench capability', () => {
  it('creates a named private scratch directory and advertises the boundary rule', async () => {
    const prepared = await workbench();
    expect((await stat(prepared.dir)).isDirectory()).toBe(true);
    expect(prepared.dir).toMatch(/agent-private\/workbench$/);

    for (const mode of ['readonly', 'edit'] as const) {
      const prompt = workbenchInstructions(prepared, mode);
      expect(prompt).toContain(prepared.dir);
      expect(prompt).toContain(WORKBENCH_ENV);
      expect(prompt).toContain('NOT the repository');
      expect(prompt).toContain('hard 25 MB / roughly-dozen-entry filesystem quota');
      expect(prompt).toContain('Any change meant to land');
      expect(prompt).toContain('Open the corner yourself in one step');
      expect(prompt).toContain('Trusty Squire MCP session');
      expect(prompt).toContain('Do not install or run a browser');
      expect(prompt).toContain('single-file v1');
      expect(prompt.toLowerCase()).toContain('network access');
      expect(prompt).toContain(
        mode === 'edit' ? 'physical corner session' : 'physical Room session',
      );
    }
  });

  it('publishes a source leak through the existing typed activity ledger and nudges once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-workbench-ledger-'));
    roots.push(root);
    const logicalDir = join(root, 'logical-workbench');
    const storageDir = join(root, 'live-session-root', 'workbench');
    await mkdir(logicalDir, { recursive: true });
    await mkdir(join(storageDir, 'src'), { recursive: true });
    await writeFile(
      join(storageDir, 'src', 'implementation.ts'),
      'export const stranded = true;\n',
    );

    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: root,
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    body.registerSession({
      channelId: 'scratch-room',
      sessionId: 'scratch-session',
      client: new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} }),
      mode: 'readonly',
      workbench: { dir: logicalDir, storageDir },
    });
    const appended: Array<{ text: string }> = [];
    const durableState = Reflect.get(body, 'durableState') as {
      appendConversation: (_channelId: string, entry: { text: string }) => Promise<void>;
    };
    vi.spyOn(durableState, 'appendConversation').mockImplementation(async (_channelId, entry) => {
      appended.push(entry);
    });
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await Reflect.get(body, 'sweepWorkbench').call(body, 'scratch-room');
    await Reflect.get(body, 'sweepWorkbench').call(body, 'scratch-room');

    const warnings = published.filter((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === 'scratch-leak'),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe(9);
    expect(warnings[0]!.tags).toContainEqual(['t', 'agent-activity']);
    const envelope = JSON.parse(warnings[0]!.content) as {
      update: { sessionUpdate: string; updates: Array<Record<string, unknown>> };
    };
    expect(envelope.update.sessionUpdate).toBe('activity_batch');
    expect(envelope.update.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'tool_activity',
        status: 'failed',
        title: 'Working in scratch — will not land — open a corner',
      }),
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]!.text).toContain('initiate the documented one-step corner-open action');
    vi.unstubAllGlobals();
  });

  it('allows only absolute, path-pinned file operations inside the workbench', async () => {
    const prepared = await workbench();
    const edit = (path: string) => ({
      toolCall: { kind: 'edit', title: 'Write', rawInput: { file_path: path } },
    });
    expect(
      isAgentWorkbenchWritePermissionRequest(
        edit(join(prepared.dir, 'preview.html')),
        prepared.dir,
      ),
    ).toBe(true);
    expect(isAgentWorkbenchWritePermissionRequest(edit('preview.html'), prepared.dir)).toBe(false);
    expect(
      isAgentWorkbenchWritePermissionRequest(
        edit(join(prepared.dir, '../repo/file.ts')),
        prepared.dir,
      ),
    ).toBe(false);
    expect(
      isAgentWorkbenchWritePermissionRequest(
        { toolCall: { kind: 'execute', rawInput: { command: `echo x > ${prepared.dir}/x` } } },
        prepared.dir,
      ),
    ).toBe(false);
  });

  it('classifies source-shaped scratch without flagging preview artifacts', async () => {
    const prepared = await workbench();
    await writeFile(join(prepared.dir, 'preview.html'), '<h1>Preview</h1>');
    await writeFile(join(prepared.dir, 'render.png'), 'not-really-a-png');
    await expect(detectWorkbenchScratchLeak(prepared)).resolves.toBeUndefined();
    await mkdir(join(prepared.dir, 'src'));
    await writeFile(join(prepared.dir, 'src', 'feature.ts'), 'export const stranded = true;');
    await expect(detectWorkbenchScratchLeak(prepared)).resolves.toEqual({
      paths: ['src/feature.ts'],
      reason: 'repository-tree',
    });
  });
});

describe('workbench garbage collection', () => {
  it('evicts TTL-expired files and then oldest files until the size cap is met', async () => {
    const prepared = await workbench();
    const expired = join(prepared.dir, 'expired.txt');
    const oldest = join(prepared.dir, 'oldest.txt');
    const newest = join(prepared.dir, 'newest.txt');
    await writeFile(expired, 'old');
    await writeFile(oldest, '1234');
    await writeFile(newest, '5678');
    const now = Date.now();
    await utimes(expired, new Date(now - 8_000), new Date(now - 8_000));
    await utimes(oldest, new Date(now - 2_000), new Date(now - 2_000));
    await utimes(newest, new Date(now - 1_000), new Date(now - 1_000));

    const result = await sweepSessionWorkbench(prepared, {
      now,
      ttlMs: 7_000,
      maxBytes: 4,
      maxEntries: 20,
      maxDeletes: 20,
    });

    expect(result).toMatchObject({ scannedFiles: 3, deletedFiles: 2, bytesAfter: 4 });
    await expect(readFile(expired)).rejects.toThrow();
    await expect(readFile(oldest)).rejects.toThrow();
    await expect(readFile(newest, 'utf8')).resolves.toBe('5678');
  });

  it('bounds each pass and reports when more entries remain', async () => {
    const prepared = await workbench();
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(prepared.dir, `${index}.txt`), 'x');
    }
    const result = await sweepSessionWorkbench(prepared, {
      maxEntries: 2,
      maxDeletes: 1,
      maxBytes: 0,
    });
    expect(result.truncated).toBe(true);
    expect(result.scannedFiles).toBe(2);
    expect(result.deletedFiles).toBe(1);
  });
});

const bwrap = detectBwrapSandbox();
const quotaDescribe = bwrap.path ? describe : describe.skip;

quotaDescribe('workbench filesystem quota (live bwrap)', () => {
  it('accepts a 10 MB artifact but rejects .git, byte/inode exhaustion, deep trees, and shell cp -r', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-workbench-quota-'));
    roots.push(root);
    const repo = join(root, 'repo');
    await mkdir(repo);
    spawnSync('git', ['init', '-q', repo]);
    const sourceTree = join(root, 'source-tree');
    await mkdir(sourceTree);
    for (let index = 0; index < 30; index += 1) {
      await writeFile(
        join(sourceTree, `source-${index}.ts`),
        `export const value${index} = ${index};\n`,
      );
    }
    const prepared = await prepareSessionWorkbench(join(root, 'agent-private'));
    const wrapped = wrapAgentCommand({
      bwrapPath: bwrap.path!,
      spec: {
        mode: 'readonly',
        cwd: repo,
        workbench: {
          dir: prepared.dir,
          maxBytes: WORKBENCH_MAX_BYTES,
          maxInodes: WORKBENCH_MAX_INODES,
        },
      },
      command: 'sh',
      args: [
        '-c',
        [
          'set -eu',
          'test ! -d "$2/.git"',
          'if mkdir "$2/.git" 2>/dev/null; then exit 41; fi',
          'dd if=/dev/zero of="$2/preview.html" bs=1M count=10 status=none',
          'test "$(stat -c %s "$2/preview.html")" -eq 10485760',
          'if dd if=/dev/zero of="$2/too-large.bin" bs=1M count=20 status=none 2>/dev/null; then exit 42; fi',
          'rm -f "$2/too-large.bin"',
          'if cp -r "$1" "$2/repo-copy" 2>/dev/null; then exit 42; fi',
          'rm -rf "$2/repo-copy"',
          'if cp -r "$3" "$2/implementation-copy" 2>/dev/null; then exit 43; fi',
          'rm -rf "$2/implementation-copy"',
          'deep="$2/deep"; exhausted=0',
          'for _level in $(seq 1 20); do if ! mkdir "$deep" 2>/dev/null; then exhausted=1; break; fi; deep="$deep/d"; done',
          'test "$exhausted" -eq 1',
          'test "$(stat -f -c %b "$2")" -eq 6400',
          'test "$(stat -f -c %c "$2")" -eq "$5"',
        ].join('\n'),
        'workbench-quota-test',
        repo,
        prepared.dir,
        sourceTree,
        String(WORKBENCH_MAX_BYTES),
        String(WORKBENCH_MAX_INODES),
      ],
    });
    const proof = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' });
    expect(proof.status, `${proof.stderr}\n${proof.stdout}`).toBe(0);
  });
});
