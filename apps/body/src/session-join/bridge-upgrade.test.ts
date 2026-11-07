import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { acceptMemberDelivery, deliver, ensureBridge, refreshJoinedSessionBridge } from './bridge.js';
import { readState, updateState, type JoinedSession } from './store.js';

const children: ChildProcess[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit'); child.kill(); await ended;
    }
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function changedFile(path: string, ready: () => boolean): Promise<void> {
  return new Promise(resolve => {
    const watcher = watch(path, { recursive: true }, () => { if (ready()) { watcher.close(); resolve(); } });
    if (ready()) { watcher.close(); resolve(); }
  });
}

it('parks after an expired replacement without resetting the recovery allowance when tokens rotate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-expiry-budget-')); folders.push(dir);
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir,
    CLAUDE_CONFIG_DIR: join(dir, '.claude'), CODEX_HOME: join(dir, '.codex') };
  const stateDir = join(dir, 'state'); mkdirSync(stateDir);
  const requests = join(dir, 'requests');
  await updateState(stateDir, state => { state.sessions = [{ key: `claude-code:${dir}`, agent: 'claude-code', cwd: dir,
    name: 'Claude', server: 'https://synthetic.invalid', clientId: 'client', refreshToken: 'original-refresh',
    accessToken: 'original-access', accessExpiresAt: Date.now() + 3_600_000, cursor: '0', deliveredWakes: [], joinedAt: '' }]; });
  const bridge = resolve('src/session-join/bridge.ts');
  const script = `import { runBridge } from ${JSON.stringify(bridge)};
    import { appendFileSync } from 'node:fs';
    let streams = 0, refreshes = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/mcp/oauth/token')) {
        appendFileSync(${JSON.stringify(requests)}, 'refresh\\n');
        return Response.json({ access_token: 'fresh-' + (++refreshes), refresh_token: 'refresh-' + refreshes, expires_in: 3600 });
      }
      if (init.method === 'POST') return Response.json({ result: { capabilities: { memberStreamV1: true } } });
      appendFileSync(${JSON.stringify(requests)}, 'stream\\n');
      return new Response(JSON.stringify({ v: 1, type: 'ended', reason: ++streams > 3 ? 'unavailable' : 'expired' }) + '\\n',
        { headers: { 'content-type': 'application/x-ndjson' } });
    };
    await runBridge(${JSON.stringify(stateDir)}, { node: process.execPath, bundle: ${JSON.stringify(bridge)} });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env, stdio: 'ignore' }); children.push(child);
  await changedFile(dir, () => existsSync(requests) && readFileSync(requests, 'utf8').split('stream\n').length >= 3);
  // The replacement has ended synchronously; allow the credential/state file
  // events to settle and prove they cannot admit a third connection.
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(readFileSync(requests, 'utf8')).toBe('stream\nrefresh\nstream\n');
});

it('replaces a living legacy bridge and catches up the saved cursor before delivering live Claude tags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-upgrade-')); folders.push(dir);
  const env = { ...process.env, HOME: dir, XDG_STATE_HOME: dir, CLAUDE_CONFIG_DIR: join(dir, '.claude') };
  const stateDir = join(dir, 'beeline-sessions'); mkdirSync(stateDir);
  const joined: JoinedSession = { key: `claude-code:${dir}`, agent: 'claude-code', cwd: dir,
    name: 'Claude', server: 'https://synthetic.invalid', clientId: 'client', refreshToken: 'synthetic',
    accessToken: 'synthetic', accessExpiresAt: Date.now() + 3_600_000, cursor: '437', deliveredWakes: [],
    sessionId: 'synthetic-session', pid: process.pid, joinedAt: '' };
  await updateState(stateDir, state => { state.sessions = [joined]; });
  const oldBundle = join(dir, 'usebeeline.mjs');
  writeFileSync(oldBundle, `import { createServer } from 'node:net';
    import { writeFileSync } from 'node:fs';
    createServer().listen(${JSON.stringify(join(dir, 'old.sock'))}, () => {
      writeFileSync(${JSON.stringify(join(stateDir, 'bridge.pid'))}, String(process.pid));
    });`);
  const old = spawn(process.execPath, [oldBundle, 'session', 'bridge'], { env, stdio: 'ignore' }); children.push(old);
  await changedFile(stateDir, () => { try { return Number(readFileSync(join(stateDir, 'bridge.pid'))) === old.pid; } catch { return false; } });

  const socket = join(dir, 'claude.sock');
  const messages: string[] = [];
  let received!: () => void;
  const delivered = new Promise<void>(done => { received = done; });
  const server = createServer(peer => {
    let text = ''; peer.on('data', chunk => { text += chunk; });
    peer.on('end', () => { messages.push(JSON.parse(text).message.content); if (messages.length === 2) received(); });
  });
  server.listen(socket); await once(server, 'listening');
  mkdirSync(join(env.CLAUDE_CONFIG_DIR, 'sessions'), { recursive: true });
  writeFileSync(join(env.CLAUDE_CONFIG_DIR, 'sessions', `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: joined.sessionId, cwd: joined.cwd, messagingSocketPath: socket,
  }));
  const bundle = join(dir, 'new', 'usebeeline.mjs'); mkdirSync(join(dir, 'new'));
  writeFileSync(bundle, `import { tsImport } from ${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm/api'))};
    import { appendFileSync } from 'node:fs';
    const { runBridge } = await tsImport(${JSON.stringify(resolve('src/session-join/bridge.ts'))}, import.meta.url);
    let streams = 0;
    globalThis.fetch = async (url, init) => {
      if (init.method === 'POST') return Response.json({ result: { capabilities: { memberStreamV1: true } } });
      appendFileSync(${JSON.stringify(join(dir, 'connections'))}, new URL(url).searchParams.get('mentions') + '\\n');
      const n = ++streams;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ v: 1, type: 'delivery', deliveryId: 'mention:' + n,
          mentions: [{ id: 'tag-' + n, room_id: 'synthetic-room', text: n === 1 ? 'missed while old bridge lived' : 'committed after reconnect' }],
          wakes: [], mentionCursor: String(459 + n) }) + '\\n'));
        if (n === 1) controller.close();
      } }), { headers: { 'content-type': 'application/x-ndjson' } });
    };
    await runBridge(${JSON.stringify(stateDir)}, { node: process.execPath, bundle: ${JSON.stringify(bundle)} });`);
  try {
    await refreshJoinedSessionBridge(bundle, env);
    expect(old.exitCode !== null || old.signalCode !== null).toBe(true);
    await delivered;
    expect(messages[0]).toContain('missed while old bridge lived');
    expect(messages[1]).toContain('committed after reconnect');
    expect(readState(stateDir).sessions[0]?.cursor).toBe('461');
    expect(readFileSync(join(dir, 'connections'), 'utf8')).toBe('437\n460\n');
    const pid = Number(readFileSync(join(stateDir, 'bridge.pid')));
    await ensureBridge(stateDir, { node: process.execPath, bundle: join(stateDir, 'usebeeline.mjs') }, env);
    expect(Number(readFileSync(join(stateDir, 'bridge.pid')))).toBe(pid);
  } finally {
    const pid = Number(readFileSync(join(stateDir, 'bridge.pid')));
    if (pid !== old.pid) {
      const { waitForProcessExit } = await import('../process-exit.js');
      try { process.kill(pid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      await waitForProcessExit(pid);
    }
    await new Promise<void>(done => server.close(() => done()));
  }
}, 20_000);

it('refuses to signal an unrelated process named by a stale bridge PID file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-pid-')); folders.push(dir);
  const bundle = join(dir, 'unrelated.mjs'); writeFileSync(bundle, 'process.stdin.resume();');
  const child = spawn(process.execPath, [bundle, 'session', 'bridge'], { stdio: ['pipe', 'ignore', 'ignore'] }); children.push(child);
  await once(child, 'spawn'); writeFileSync(join(dir, 'bridge.pid'), String(child.pid));
  await expect(ensureBridge(dir, { node: process.execPath, bundle })).rejects.toThrow('refusing takeover');
  expect(child.exitCode).toBe(null); expect(child.signalCode).toBe(null);
});

it('wakes Claude’s authenticated in-session receiver on a committed durable delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-commit-')); folders.push(dir);
  const env = { ...process.env, HOME: dir, XDG_STATE_HOME: dir, CLAUDE_CONFIG_DIR: join(dir, '.claude'),
    CLAUDE_CODE_MESSAGING_TOKEN: 'synthetic-session-token' };
  const socket = join(dir, 'claude.sock');
  const joined: JoinedSession = { key: `claude-code:${dir}`, agent: 'claude-code', cwd: dir, name: 'Claude',
    server: 'https://synthetic.invalid', clientId: 'client', refreshToken: 'synthetic', cursor: '437',
    deliveredWakes: [], sessionId: 'claude-commit', pid: process.pid, joinedAt: '' };
  await updateState(dir, state => { state.sessions = [joined]; });
  mkdirSync(join(env.CLAUDE_CONFIG_DIR, 'sessions'), { recursive: true });
  writeFileSync(join(env.CLAUDE_CONFIG_DIR, 'sessions', `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: joined.sessionId, cwd: dir, messagingSocketPath: socket,
  }));
  let receive!: (frames: { type: string; token?: string; message?: { content: string } }[]) => void;
  const received = new Promise<Parameters<typeof receive>[0]>(done => { receive = done; });
  const connections: Parameters<typeof receive>[0] = [];
  const server = createServer(peer => {
    let text = ''; peer.on('data', chunk => { text += chunk; });
    peer.on('end', () => {
      connections.push(...text.trim().split('\n').map(line => JSON.parse(line)));
      if (connections.length === 4) receive(connections);
    });
  });
  server.listen(socket); await once(server, 'listening');
  const script = `import { runClaudeMcp } from ${JSON.stringify(resolve('src/session-join/claude-mcp.ts'))};
    import { postToClaude } from ${JSON.stringify(resolve('src/session-join/claude.ts'))};
    import { watch } from 'node:fs';
    let first = true;
    await runClaudeMcp(${JSON.stringify(dir)}, process.env, undefined, async (...args) => {
      await postToClaude(...args);
      if (first) {
        first = false;
        await new Promise(done => {
          const watcher = watch(${JSON.stringify(dir)}, (_event, name) => {
            if (String(name) === 'release-post') { watcher.close(); done(); }
          });
          process.stdout.write('first post waiting\\n');
        });
      }
    });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  children.push(child);
  try {
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    await once(child.stdout!, 'data');
    const firstPost = once(child.stdout!, 'data');
    await acceptMemberDelivery(dir, joined.key, { node: '/node', bundle: '/synthetic' }, { v: 1, type: 'delivery',
      deliveryId: 'mention:missed', mentions: [{ id: 'missed', room_id: 'room', text: 'committed tag for Claude' }], wakes: [], mentionCursor: '460' });
    expect(await deliver(dir, joined, { agent: 'claude-code', sessionId: joined.sessionId!, pid: process.pid, socket }))
      .toBe('waiting for the in-session MCP server');
    await firstPost;
    // A second commit while a post awaits completion must not disappear behind
    // the in-flight guard. Releasing the first post is a filesystem event.
    await acceptMemberDelivery(dir, joined.key, { node: '/node', bundle: '/synthetic' }, { v: 1, type: 'delivery',
      deliveryId: 'mention:next', mentions: [{ id: 'next', room_id: 'room', text: 'tag committed during the first post' }], wakes: [], mentionCursor: '461' });
    writeFileSync(join(dir, 'release-post'), '');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const frames = await Promise.race([received, new Promise<never>((_done, fail) => {
      timeout = setTimeout(() => fail(new Error('Claude receiver missed the durable delivery commit')), 2000);
    })]).finally(() => clearTimeout(timeout));
    expect(frames[0]).toEqual({ type: 'auth', token: 'synthetic-session-token' });
    expect(frames[1]?.message?.content).toContain('committed tag for Claude');
    expect(frames[3]?.message?.content).toContain('tag committed during the first post');
    expect(readState(dir).sessions[0]?.cursor).toBe('461');
  } finally {
    const ended = once(child, 'exit'); child.stdin!.end(); await ended;
    await new Promise<void>(done => server.close(() => done()));
  }
}, 20_000);
