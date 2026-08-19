/**
 * Every installed ACP harness must still be able to open a session inside the
 * OS sandbox — in BOTH modes.
 *
 * This is the regression that the mount-table unit tests structurally cannot
 * catch, and it is not hypothetical: the first cut of `bwrap-sandbox.ts`
 * followed "a Room writes nothing but /tmp" literally, and the result was that
 * `codex-acp` could not start a Room session at all ("failed to initialize
 * sqlite state runtime under …/codex") while `pi-acp` could not start one in
 * either mode ("EROFS … open '~/.pi/pi-acp/session-map.json'" — a path pi-acp
 * hard-codes, so `agent-home.ts` cannot relocate it). Both failures surface as
 * an error out of `session/new`, not as a denied tool call, so nothing on the
 * permission path would ever have reported them.
 *
 * No relay and no model call: this is `initialize` + `session/new` over stdio
 * against the operator's own installed adapters, which is the exact handshake
 * `Body.createManagedSession` performs. Each harness soft-skips when it is not
 * installed, and the whole file skips when `bwrap` is unusable on this host.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { detectBwrapSandbox, harnessHomeStateDirs, wrapAgentCommand } from './bwrap-sandbox.js';
import { harnessStateDirsFromEnv, prepareRoomAgentHome } from './agent-home.js';
import { executableOnPath } from './agent-command.js';
import type { SessionMode } from './config.js';

const sandbox = detectBwrapSandbox();
const HARNESSES = ['codex-acp', 'claude-agent-acp', 'pi-acp'] as const;
const HANDSHAKE_TIMEOUT_MS = 45_000;

const root = mkdtempSync(resolve(tmpdir(), 'buzzy-harness-sandbox-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** initialize + session/new against one harness, wrapped exactly as Body does. */
async function sessionNewUnderSandbox(
  harness: string,
  mode: SessionMode,
): Promise<{ ok: boolean; detail: string }> {
  const overlay = await prepareRoomAgentHome({ root: resolve(root, mode, 'agent-home') });
  const cwd = resolve(root, mode, 'checkout');
  // Node reports a missing spawn cwd as ENOENT on the command itself.
  mkdirSync(cwd, { recursive: true });
  const { stateDirs, tmpDir } = harnessStateDirsFromEnv(overlay);
  const wrapped = wrapAgentCommand({
    bwrapPath: sandbox.path!,
    spec: {
      mode,
      cwd,
      harnessStateDirs: stateDirs,
      harnessHomeStateDirs: harnessHomeStateDirs(harness),
      ...(tmpDir ? { tmpDir } : {}),
      ...(mode === 'edit' ? { worktreePath: cwd } : {}),
    },
    command: harness,
  });

  return await new Promise((resolveResult) => {
    const child = spawn(wrapped.command, wrapped.args, {
      env: { ...process.env, ...overlay },
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolveResult({ ok, detail });
    };
    const timer = setTimeout(() => finish(false, `timed out; stderr: ${stderr.slice(-400)}`), HANDSHAKE_TIMEOUT_MS);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on('error', (error) => finish(false, String(error)));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: { id?: number; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } });
        if (message.id === 2) {
          finish(!message.error, message.error ? JSON.stringify(message.error) : 'ok');
        }
      }
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
  });
}

const suite = sandbox.path ? describe : describe.skip;

suite('installed harnesses start inside the OS sandbox', () => {
  for (const harness of HARNESSES) {
    const binary = executableOnPath(harness);
    const test = binary ? it : it.skip;
    for (const mode of ['readonly', 'edit'] as const) {
      test(
        `${harness} opens a ${mode} session under the wrapper`,
        async () => {
          const { ok, detail } = await sessionNewUnderSandbox(binary!, mode);
          // A read-only harness state directory shows up here, and only here.
          expect(detail).not.toMatch(/EROFS|[Rr]ead-only file system/);
          expect(ok, `${harness} ${mode}: ${detail}`).toBe(true);
        },
        HANDSHAKE_TIMEOUT_MS + 15_000,
      );
    }
  }
});
