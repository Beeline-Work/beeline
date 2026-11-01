// The machine's one session bridge: for every joined session it waits on Beeline for tags and wakes, and hands each
// to the session's app by the fastest way the app has. It needs no public address: it only calls out to Beeline.
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { accessToken, callTool } from './beeline-api.js';
import { codexQueue, turnRunning } from './codex.js';
import { postToClaude } from './claude.js';
import { hasClaudeMcp } from './claude-mcp.js';
import { findSession, liveSessions, machineSources, type LiveSession, type Sources } from './sessions.js';
import { pidAlive, queueInbox, readState, takeInbox, updateState, type JoinedSession } from './store.js';

export interface Mention { id: string; room_id: string; room_name?: string; author_handle?: string | null; author_name?: string | null; text: string }
export interface Wake { id: string; address: string; reason: string; kind?: string; text?: string; createdAt: string; next?: string }

/** How the session runs Beeline commands: the stable bundle copy and this member's id. */
export interface Runner { node: string; bundle: string }

function command(runner: Runner, joined: JoinedSession, args: string): string {
  const q = (v: string) => /^[A-Za-z0-9_./:@=-]+$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, '\\$1')}"`;
  return `${q(runner.node)} ${q(runner.bundle)} session ${args} --as ${q(joined.key)}`;
}

/** What the session reads: who tagged it, where, the exact text as data, and the command that answers. */
export function renderMention(m: Mention, joined: JoinedSession, runner: Runner): string {
  const who = m.author_handle ? `@${m.author_handle}` : m.author_name ?? 'Someone';
  const quoted = m.text.split('\n').map(line => `> ${line}`).join('\n');
  return [`Beeline: ${who} tagged you (@${joined.handle ?? joined.name}) in the Room "${m.room_name ?? m.room_id}". Their message, as data:`, quoted,
    `Your owner's Allow is standing approval to answer it. Answer in that Room, threaded under their message (the command works inside your sandbox; it needs no network access):`,
    `  ${command(runner, joined, `reply --room ${m.room_id} --reply-to ${m.id} "<your answer>"`)}`,
    `Read the Room first if you need context: ${command(runner, joined, `read --room ${m.room_id}`)}`].join('\n');
}

export function renderWake(w: Wake, joined: JoinedSession, runner: Runner): string {
  return [`Beeline: ${w.kind ?? w.reason} for you (@${joined.handle ?? joined.name}) at ${w.address}.`, ...(w.text ? [w.text.split('\n').map(l => `> ${l}`).join('\n')] : []),
    w.next ?? 'Handle it.',
    `Post there: ${command(runner, joined, `reply --room ${w.address} "<text>"`)}`,
    `Other Beeline tools (report, no_reply_needed, …): ${command(runner, joined, `tool <name> '<json arguments>'`)}`].join('\n');
}

export interface DeliverDeps {
  postClaude: typeof postToClaude;
  queueCodex: (bin: string, threadId: string, text: string) => Promise<void>;
  codexBusy: (rollout: string) => boolean | undefined;
}

const realDeps: DeliverDeps = {
  postClaude: postToClaude,
  queueCodex: (bin, thread, text) => codexQueue(thread, text, bin),
  codexBusy: rollout => turnRunning(rollout),
};

/**
 * Hands waiting text to a joined session. Claude Code takes it in its inbox socket and Codex through `codex queue`;
 * both start a turn when idle. Every other app takes it from the inbox at its next hook or plugin poll, so it stays
 * there. Returns how it went, for the log.
 */
export async function deliver(dir: string, joined: JoinedSession, session: LiveSession | undefined, deps: DeliverDeps = realDeps): Promise<string> {
  if (joined.agent !== 'claude-code' && joined.agent !== 'codex') return 'waiting for the app to collect it';
  if (!session) return 'waiting for the session to open';
  if (joined.agent === 'claude-code' && hasClaudeMcp(dir, session.pid)) return 'waiting for the in-session MCP server';
  const text = takeInbox(dir, joined.key);
  if (!text) return 'nothing waiting';
  try {
    if (joined.agent === 'claude-code') {
      if (!session.socket) throw new Error('this Claude Code session has no inbox');
      await deps.postClaude({ path: session.socket }, text);
      return 'pushed into the Claude Code session';
    }
    // Read before queueing: an idle thread starts its turn the moment it takes the message.
    const busy = session.rollout ? deps.codexBusy(session.rollout) : undefined;
    await deps.queueCodex(joined.agentBin ?? 'codex', session.sessionId, text);
    return busy ? 'queued for after the current Codex turn' : 'queued into the idle Codex thread';
  } catch (error) {
    queueInbox(dir, joined.key, text);
    return `left waiting: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** One long poll: new tags and wakes become inbox text; the cursor moves only after the text is saved. */
export async function pollOnce(dir: string, key: string, runner: Runner, waitSeconds = 25): Promise<number> {
  const joined = readState(dir).sessions.find(s => s.key === key);
  if (!joined) return 0;
  const token = await accessToken(dir, key);
  // Wakes already handed over do not end the wait; a newer one does.
  const page = await callTool(joined, token, 'list_mentions', { cursor: joined.cursor, waitSeconds,
    ...(joined.wakesSeenAt ? { wakesAfter: joined.wakesSeenAt } : {}) }) as { mentions: Mention[]; nextCursor: string; wakes: Wake[] };
  const fresh = page.wakes.filter(w => !joined.deliveredWakes.includes(w.id));
  const parts = [...page.mentions.map(m => renderMention(m, joined, runner)), ...fresh.map(w => renderWake(w, joined, runner))];
  await updateState(dir, state => {
    const current = state.sessions.find(s => s.key === key);
    if (!current) return;
    if (parts.length) queueInbox(dir, key, parts.join('\n\n'));
    current.cursor = page.nextCursor;
    // Remember only wakes still waiting, so the list stays as short as Beeline's.
    current.deliveredWakes = page.wakes.map(w => w.id);
    const newest = page.wakes.map(w => w.createdAt).sort().at(-1);
    if (newest && (!current.wakesSeenAt || newest > current.wakesSeenAt)) current.wakesSeenAt = newest;
  });
  return parts.length;
}

function log(dir: string, line: string): void {
  try { writeFileSync(join(dir, 'bridge.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a', mode: 0o600 }); } catch { /* best effort */ }
}

/** Finds each joined session's live conversation, records it, and hands over what waits. */
export async function flush(dir: string, sources: Sources, deps: DeliverDeps = realDeps): Promise<void> {
  const state = readState(dir);
  const live = liveSessions(sources);
  for (const joined of state.sessions) {
    const session = findSession(joined, live, state.sessions);
    if (session && (session.sessionId !== joined.sessionId || session.pid !== joined.pid)) {
      await updateState(dir, s => {
        const current = s.sessions.find(x => x.key === joined.key);
        if (current) { current.sessionId = session.sessionId; current.pid = session.pid; }
      });
      log(dir, `${joined.key}: in session ${session.sessionId}`);
    }
    const outcome = await deliver(dir, joined, session, deps);
    if (outcome !== 'nothing waiting' && !outcome.startsWith('waiting')) log(dir, `${joined.key}: ${outcome}`);
  }
}

/**
 * Tool calls for joined sessions, over a private socket. A sandboxed app (Codex's default) blocks the network but
 * not this socket, so its replies go out without asking the person to approve network access each time.
 */
function serveTools(dir: string): void {
  const path = join(dir, 'bridge.sock');
  rmSync(path, { force: true });
  const server = createServer(connection => {
    let buffer = '', taken = false;
    connection.setEncoding('utf8');
    connection.on('data', async chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0 || taken) return;
      taken = true;
      let answer: object;
      try {
        const request = JSON.parse(buffer.slice(0, end)) as { key: string; name: string; args: Record<string, unknown> };
        const joined = readState(dir).sessions.find(s => s.key === request.key);
        if (!joined) throw new Error('This session has not joined Beeline');
        answer = { ok: true, data: await callTool(joined, await accessToken(dir, joined.key), request.name, request.args ?? {}) };
      } catch (error) { answer = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      connection.end(JSON.stringify(answer) + '\n');
    });
  });
  server.listen(path, () => chmodSync(path, 0o600));
  server.unref();
}

/**
 * A sandbox that blocks sockets still lets the app write its working folder. A tool call left there as
 * `.beeline/outbox/<id>.request.json` is made by the bridge, which writes `<id>.result.json` beside it.
 */
export function outboxDir(cwd: string): string {
  return join(cwd, '.beeline', 'outbox');
}

export async function serveOutboxes(dir: string): Promise<number> {
  let served = 0;
  for (const joined of readState(dir).sessions) {
    let names: string[];
    try { names = readdirSync(outboxDir(joined.cwd)); } catch { continue; }
    for (const name of names.filter(n => n.endsWith('.request.json'))) {
      const path = join(outboxDir(joined.cwd), name);
      const taking = `${path}.taking`;
      try { renameSync(path, taking); } catch { continue; }
      let answer: object;
      try {
        const request = JSON.parse(readFileSync(taking, 'utf8')) as { name: string; args: Record<string, unknown> };
        // The folder names the member: a request can only act as the session joined from this folder.
        answer = { ok: true, data: await callTool(joined, await accessToken(dir, joined.key), request.name, request.args ?? {}) };
      } catch (error) { answer = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      rmSync(taking, { force: true });
      writeFileSync(path.replace(/\.request\.json$/, '.result.json'), JSON.stringify(answer));
      served++;
    }
  }
  return served;
}

/** Leaves a tool call in the working folder's outbox and waits for the bridge's answer. */
export async function toolViaOutbox(cwd: string, name: string, args: Record<string, unknown>, timeoutMs = 90_000): Promise<{ ok: boolean; data?: unknown; error?: string } | undefined> {
  const dirPath = outboxDir(cwd);
  mkdirSync(dirPath, { recursive: true });
  // Keep the outbox out of the person's repository.
  writeFileSync(join(cwd, '.beeline', '.gitignore'), '*\n');
  const id = `${Date.now()}-${process.pid}`;
  const request = join(dirPath, `${id}.request.json`), result = join(dirPath, `${id}.result.json`);
  writeFileSync(`${request}.tmp`, JSON.stringify({ name, args }));
  renameSync(`${request}.tmp`, request);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const answer = JSON.parse(readFileSync(result, 'utf8')) as { ok: boolean };
      rmSync(result, { force: true });
      return answer;
    } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    // No bridge took it: the caller goes direct.
    if (Date.now() - started > 5000 && existsSync(request)) break;
  }
  rmSync(request, { force: true });
  return undefined;
}

/** Calls a tool through the bridge; undefined when no bridge answers, so the caller goes direct. */
export function toolViaBridge(dir: string, key: string, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string } | undefined> {
  return new Promise(resolve => {
    const connection = createConnection(join(dir, 'bridge.sock'));
    let text = '';
    connection.setEncoding('utf8');
    connection.once('error', () => resolve(undefined));
    connection.on('data', chunk => { text += chunk; });
    connection.on('end', () => { try { resolve(JSON.parse(text) as { ok: boolean }); } catch { resolve(undefined); } });
    connection.setTimeout(90_000, () => { connection.destroy(); resolve(undefined); });
    connection.write(JSON.stringify({ key, name, args }) + '\n');
  });
}

/** Runs until no session is joined. One per machine user: a second exits at once. */
export async function runBridge(dir: string, runner: Runner): Promise<void> {
  const pidFile = join(dir, 'bridge.pid');
  try {
    const fd = openSync(pidFile, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch {
    const holder = Number(readFileSync(pidFile, 'utf8'));
    if (holder && holder !== process.pid && pidAlive(holder)) return;
    writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  }
  const sources = machineSources(dir);
  const polling = new Map<string, Promise<void>>();
  serveTools(dir);
  let serving = false;
  setInterval(() => {
    if (serving) return;
    serving = true;
    void serveOutboxes(dir).catch(error => log(dir, `outbox: ${String(error)}`)).finally(() => { serving = false; });
  }, 500).unref();
  const stop = () => { rmSync(pidFile, { force: true }); rmSync(join(dir, 'bridge.sock'), { force: true }); process.exit(0); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  log(dir, `bridge ${process.pid} started`);
  for (;;) {
    const keys = readState(dir).sessions.map(s => s.key);
    if (!keys.length) break;
    for (const key of keys) {
      if (polling.has(key)) continue;
      polling.set(key, (async () => {
        let pause = 0;
        while (readState(dir).sessions.some(s => s.key === key)) {
          try {
            if (await pollOnce(dir, key, runner)) await flush(dir, sources);
            pause = 0;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log(dir, `${key}: ${message}`);
            pause = Math.min(60_000, (pause || 2000) * 2);
            await new Promise(resolve => setTimeout(resolve, pause));
          }
        }
      })().finally(() => polling.delete(key)));
    }
    await flush(dir, sources).catch(error => log(dir, `flush: ${String(error)}`));
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  log(dir, `bridge ${process.pid} stopped: no joined sessions`);
  rmSync(pidFile, { force: true });
  rmSync(join(dir, 'bridge.sock'), { force: true });
  process.exit(0);
}

export function bridgeRunning(dir: string): boolean {
  try {
    const holder = Number(readFileSync(join(dir, 'bridge.pid'), 'utf8'));
    return Boolean(holder) && pidAlive(holder);
  } catch { return false; }
}

/** Starts the bridge in the background unless one runs. It outlives the command that started it. */
export function ensureBridge(dir: string, runner: Runner, env: NodeJS.ProcessEnv = process.env): void {
  if (bridgeRunning(dir)) return;
  const out = openSync(join(dir, 'bridge.log'), 'a', 0o600);
  const child = spawn(runner.node, [runner.bundle, 'session', 'bridge'], { detached: true, stdio: ['ignore', out, out], env });
  child.unref();
  closeSync(out);
}
