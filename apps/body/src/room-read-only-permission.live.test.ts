/**
 * Live end-to-end proof that a Room keeps its reads and loses its writes,
 * against a REAL ACP harness rather than a hand-written payload.
 *
 * The regression this closes: a claude-backed Room answered every read-only
 * tool call — `read_file`, `git_log`, `git_show` — with "User refused
 * permission to run tool". Those calls arrive from claude-agent-acp with no MCP
 * marker, `kind: 'other'`, and a `mcp__<server>__<tool>` name, so a detector
 * keyed on an MCP envelope or on dot/slash-separated names never recognized
 * them and the fail-closed default swallowed them.
 *
 * The unit coverage in `body.test.ts` drives the captured payloads
 * (`fixtures/claude-agent-acp-permissions.ts`). This drives the actual adapter:
 * it spawns `claude-agent-acp` exactly the way `acp.ts` does, mounts one MCP
 * server named `beeline-readonly-mcp` advertising the same six tool names as
 * `read-only-policy.ts`, answers every `session/request_permission` with
 * Beeline's own `isReadOnlyMcpPermissionRequest`, and asserts what the harness
 * was actually told: read_file / git_log / git_show allowed, Write and Bash
 * denied.
 *
 * Soft-skips when `claude-agent-acp` is not installed or the harness cannot
 * start a session (no credentials in this environment). Needs no relay.
 */
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReadOnlyMcpPermissionRequest } from './read-only-policy.js';
import type { AcpPermissionRequest } from './acp.js';

const ADAPTER = process.env.BUZZY_LIVE_ACP_ADAPTER ?? 'claude-agent-acp';
const PROBE_MCP = resolve(
  fileURLToPath(new URL('../scripts/acp-permission-probe-mcp.mjs', import.meta.url)),
);
const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

interface Answered {
  title: string;
  kind: string | undefined;
  decision: 'allow' | 'reject';
}

/**
 * Drive one real prompt through the adapter, answering permissions with the
 * shipped Room policy. Returns what every request was told, in order.
 */
async function runRoomTurn(prompt: string, timeoutMs = 180_000): Promise<Answered[]> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(ADAPTER, [], { stdio: ['pipe', 'pipe', 'pipe'], cwd: REPO_ROOT });
  } catch {
    return [];
  }
  const answered: Answered[] = [];
  const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  let buf = '';
  let nextId = 1;
  let spawnFailed = false;

  child.on('error', () => {
    spawnFailed = true;
  });
  child.stderr.on('data', () => {
    /* the adapter is chatty about watchers/settings; ignore */
  });

  const write = (message: unknown): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method: string, params: unknown): Promise<Record<string, unknown>> =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res: res as (v: unknown) => void, rej });
      write({ jsonrpc: '2.0', id, method, params });
    });

  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let index: number;
    while ((index = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, index).trim();
      buf = buf.slice(index + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (message.id !== undefined && message.method === undefined) {
        const waiter = pending.get(message.id as number);
        pending.delete(message.id as number);
        if (!waiter) continue;
        if (message.error) waiter.rej(new Error(JSON.stringify(message.error)));
        else waiter.res(message.result);
        continue;
      }
      if (message.method === 'session/request_permission') {
        // The shipped Room policy, answering a real harness.
        const permission = message.params as AcpPermissionRequest & {
          options?: Array<{ kind?: string; optionId?: string }>;
        };
        const allowed = isReadOnlyMcpPermissionRequest(permission);
        const option = permission.options?.find((candidate) =>
          allowed
            ? candidate.kind === 'allow_once' || candidate.kind === 'allow_always'
            : candidate.kind?.startsWith('reject'),
        );
        answered.push({
          title: permission.toolCall?.title ?? '',
          kind: permission.toolCall?.kind,
          decision: allowed ? 'allow' : 'reject',
        });
        write({
          jsonrpc: '2.0',
          id: message.id,
          result: { outcome: { outcome: 'selected', optionId: option?.optionId ?? 'reject' } },
        });
        continue;
      }
      if (message.id !== undefined) write({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  });

  try {
    await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    if (spawnFailed) return [];
    const session = await request('session/new', {
      cwd: REPO_ROOT,
      mcpServers: [
        { name: 'beeline-readonly-mcp', command: process.execPath, args: [PROBE_MCP], env: [] },
      ],
      systemPrompt:
        'You are in a read-only conversation channel. Use beeline-readonly-mcp to inspect the repository.',
    });
    await Promise.race([
      request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: prompt }],
      }),
      new Promise((_res, rej) => setTimeout(() => rej(new Error('prompt timed out')), timeoutMs)),
    ]);
  } catch {
    // No credentials, no adapter, or a turn that never completed: whatever was
    // answered before the failure is still real evidence; the caller skips when
    // it is empty.
  } finally {
    child.kill('SIGTERM');
  }
  return answered;
}

describe('a Room keeps its reads and loses its writes, against a real ACP harness', () => {
  it('allows read_file / git_log / git_show', async () => {
    const answered = await runRoomTurn(
      'Call the beeline-readonly-mcp read_file tool on the path "README.md", then its git_log tool ' +
        'with limit 3, then its git_show tool with revision "HEAD". Use no built-in tool. Then stop.',
    );
    if (answered.length === 0) {
      console.warn(`[live] ${ADAPTER} unavailable; skipping the Room read proof`);
      return;
    }
    const reads = answered.filter((entry) => entry.title.includes('beeline_readonly_mcp'));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      // The exact shape that used to be denied: no MCP envelope, kind 'other'.
      expect(read.decision).toBe('allow');
    }
  }, 240_000);

  it('denies a write and a shell command', async () => {
    const answered = await runRoomTurn(
      'Using your BUILT-IN tools only: create a file /tmp/beeline-room-probe.txt containing the ' +
        'word hi, then run the shell command `npm run typecheck`. Then stop.',
    );
    if (answered.length === 0) {
      console.warn(`[live] ${ADAPTER} unavailable; skipping the Room write proof`);
      return;
    }
    const mutations = answered.filter((entry) => entry.kind === 'edit' || entry.kind === 'execute');
    expect(mutations.length).toBeGreaterThan(0);
    for (const mutation of mutations) expect(mutation.decision).toBe('reject');
  }, 240_000);
});
