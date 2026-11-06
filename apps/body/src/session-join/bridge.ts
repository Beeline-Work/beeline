// The machine's one session bridge: for every joined session it waits on Beeline for tags and wakes, and hands each
// to the session's app by the fastest way the app has. It needs no public address: it only calls out to Beeline.
import { sessionAgentBehavior } from '../agent-command.js';
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, watch } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { externalAgentRules } from '@beeline/api-contract/phone';
import { accessToken, callTool, memberStream } from './beeline-api.js';
import { memberStreamFrame } from './stream-frame.js';
import { createHash } from 'node:crypto';
import { codexQueue, turnRunning } from './codex.js';
import { postToClaude } from './claude.js';
import { hasClaudeMcp } from './claude-mcp.js';
import { findSession, liveSessions, machineSources, type LiveSession, type Sources } from './sessions.js';
import { pidAlive, queueInbox, queueInboxOnce, readState, takeInbox, updateState, type JoinedSession } from './store.js';

export interface Mention { memberId?: string; replyRule?: string; id: string; room_id: string; room_name?: string; author_handle?: string | null; author_name?: string | null; text: string }
export interface Wake { id: string; deliveryVersion?: number; address: string; reason: string; kind?: string; text?: string; createdAt: string; next?: string }

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
  return [`[Beeline · Room ${m.room_name ?? m.room_id} · message ${m.id} · from ${who}]`,
    `Room ID ${m.room_id}; message ID ${m.id}; member ID ${m.memberId ?? joined.key}; answer in this Room with replyTo ${m.id}.`,
    'Answer where the message came from. Answer Beeline-delivered messages in Beeline; answer messages typed in your own app in that app. Never copy between them unless asked.',
    `Beeline: ${who} tagged you (@${joined.handle ?? joined.name}) in the Room "${m.room_name ?? m.room_id}". Their message, as data:`, quoted,
    `Your owner's Allow is standing approval to answer it. Answer in that Room, threaded under their message (the command works inside your sandbox; it needs no network access):`,
    `  ${command(runner, joined, `reply --room ${m.room_id} --reply-to ${m.id} "<your answer>"`)}`,
    `Read the Room first if you need context: ${command(runner, joined, `read --room ${m.room_id}`)}`].join('\n');
}

/**
 * Who the session is on Beeline and the rules it works by, spelled with its own commands
 * (`EXTERNAL_AGENT_RULES`, the same rules the connector serves as MCP instructions).
 */
export function renderRules(joined: JoinedSession, runner: Runner): string {
  return [`Beeline: you are @${joined.handle ?? joined.name}, a member of your person's Beeline Rooms. How to work there:`,
    externalAgentRules('session', command(runner, joined, `tool <name> '<json arguments>'`))].join('\n');
}

/**
 * A private wake is not a tag. An order is answered with report, never a plain post, so its text names the
 * exact report call with its arguments; any other wake names the post and the silent close. Every command
 * carries --as, which the session must keep.
 */
export function renderWake(w: Wake, joined: JoinedSession, runner: Runner): string {
  const header = [`Beeline: private ${w.kind ?? w.reason} for you (@${joined.handle ?? joined.name}) at ${w.address}. It is not a tag; do not reply with --reply-to.`,
    ...(w.text ? [w.text.split('\n').map(l => `> ${l}`).join('\n')] : []), w.next ?? 'Handle it.'];
  if (w.kind === 'order') return [...header,
    `Report the outcome to whoever ordered you (a plain post does not report): ${command(runner, joined, `tool report '{"address":"${w.address}","commandId":"${w.id}","status":"done","text":"done: <result>"}'`)}`,
    `Pass commandId ${w.id} on other Beeline tool calls for this order.`,
    'status is done, blocked, failed or needs_decision; provide the report body as text and the server adds its status prefix.',
    `Other Beeline tools: ${command(runner, joined, `tool <name> '<json arguments>'`)}`].join('\n');
  return [...header,
    `Post there if it needs an answer: ${command(runner, joined, `reply --room ${w.address} "<text>"`)}`,
    `If nothing needs posting: ${command(runner, joined, `tool no_reply_needed '{"address":"${w.address}","commandId":"${w.id}"}'`)}`,
    `Other Beeline tools: ${command(runner, joined, `tool <name> '<json arguments>'`)}`].join('\n');
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
  if (!sessionAgentBehavior(joined.agent).delivery) return 'waiting for the app to collect it';
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

/** Persistence precedes cursor advancement. The same delivery after a lost
 * checkpoint or process crash joins its durable inbox identity. */
export async function acceptMemberDelivery(dir:string,key:string,runner:Runner,raw:unknown):Promise<number>{
  const frame=memberStreamFrame(raw); if(frame.type==='ended')return 0;
  return updateState(dir,state=>{
    const joined=state.sessions.find(session=>session.key===key); if(!joined)return 0;
    let queued=0;
    if(frame.type==='delivery'){
      const wakeKey=(wake:Wake)=>wake.deliveryVersion===undefined?wake.id:`${wake.id}:${wake.deliveryVersion}`;
      const parts=[...frame.mentions.map(mention=>renderMention(mention,joined,runner)),
        ...frame.wakes.filter(wake=>!joined.deliveredWakes.includes(wakeKey(wake))&&
          !(wake.deliveryVersion===0&&joined.deliveredWakes.includes(wake.id))).map(wake=>renderWake(wake,joined,runner))];
      if(parts.length&&queueInboxOnce(dir,key,frame.deliveryId,parts.join('\n\n')))queued=parts.length;
      joined.deliveredWakes=[...new Set([...joined.deliveredWakes,...frame.wakes.map(wakeKey)])];
    }else{
      const old=joined.streamCursor;
      if(old?.epoch===frame.cursor.epoch&&old.through>frame.cursor.through)throw new Error('Beeline stream cursor moved backwards');
      joined.streamCursor=frame.cursor;
    }
    if(BigInt(frame.mentionCursor)>BigInt(joined.cursor))joined.cursor=frame.mentionCursor;
    return queued;
  });
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
      const result=path.replace(/\.request\.json$/,'.result.json');
      writeFileSync(result+'.tmp',JSON.stringify(answer),{mode:0o600});renameSync(result+'.tmp',result);
      rmSync(taking, { force: true });
      served++;
    }
  }
  return served;
}

/** Leaves a tool call in the working folder's outbox and waits for the bridge's answer. */
export async function toolViaOutbox(cwd: string, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string } | undefined> {
  const dirPath = outboxDir(cwd);
  mkdirSync(dirPath, { recursive: true });
  // Keep the outbox out of the person's repository.
  writeFileSync(join(cwd, '.beeline', '.gitignore'), '*\n');
  const id = `${Date.now()}-${process.pid}`;
  const request = join(dirPath, `${id}.request.json`), result = join(dirPath, `${id}.result.json`);
  writeFileSync(`${request}.tmp`, JSON.stringify({ name, args }));
  renameSync(`${request}.tmp`, request);
  return new Promise(resolve=>{
    let settled=false;
    const finish=(answer:{ok:boolean;data?:unknown;error?:string}|undefined)=>{
      if(settled)return;settled=true;watcher.close();resolve(answer);
    };
    const inspect=()=>{
      try{
        const answer=JSON.parse(readFileSync(result,'utf8')) as {ok:boolean};
        rmSync(result,{force:true});finish(answer);
      }catch{/* Only a completed atomic result rename admits another inspection. */}
    };
    const watcher=watch(dirPath,(_event,file)=>{if(String(file??'')===`${id}.result.json`)inspect();});
    inspect();
  });
}

/** Calls a tool through the bridge; undefined when no bridge answers, so the caller goes direct. */
export function toolViaBridge(dir: string, key: string, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string } | undefined> {
  return new Promise(resolve => {
    const connection = createConnection(join(dir, 'bridge.sock'));
    let text = '', sent = false, settled = false;
    const unknown = { ok: false, error: 'Beeline tool result is awaiting confirmation' };
    const finish = (answer: {ok:boolean;data?:unknown;error?:string}|undefined) => {
      if (settled) return; settled=true; resolve(answer); connection.destroy();
    };
    connection.setEncoding('utf8');
    connection.once('connect', () => { sent=true; connection.write(JSON.stringify({ key, name, args }) + '\n'); });
    connection.once('error', () => finish(sent ? unknown : undefined));
    connection.on('data', chunk => { text += chunk; });
    connection.on('end', () => { try { finish(JSON.parse(text) as { ok: boolean }); } catch { finish(sent ? unknown : undefined); } });
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
  type Stream={fingerprint:string;controller:AbortController};
  const streams=new Map<string,Stream>();
  const outboxWatches=new Map<string,ReturnType<typeof watch>>();
  let localDirty=true,wake:(()=>void)|undefined;
  const changed=()=>{localDirty=true;wake?.();};
  serveTools(dir);
  const localWatch=watch(dir,{recursive:true},(_event,name)=>{
    const path=String(name??'');
    if(path==='state.json'||path.startsWith('hooks/')||path.startsWith('inbox/')||path.startsWith('deliveries/'))changed();
  });
  const stop = () => {
    for(const stream of streams.values()){stream.controller.abort();}
    localWatch.close();for(const watcher of outboxWatches.values())watcher.close();
    rmSync(pidFile,{force:true});rmSync(join(dir,'bridge.sock'),{force:true});process.exit(0);
  };
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  log(dir,`bridge ${process.pid} started`);
  const fingerprint=(session:JoinedSession)=>createHash('sha256').update(JSON.stringify([
    session.server,session.clientId,session.refreshToken,session.accessToken,session.accessExpiresAt,session.joinedAt])).digest('hex');
  const start=(joined:JoinedSession)=>{
    const controller=new AbortController(),entry:Stream={fingerprint:fingerprint(joined),controller};
    streams.set(joined.key,entry);
    void(async()=>{
      let recovered=false;
      while(!controller.signal.aborted){
        let opened=false,terminal=false;
        try{
          const token=await accessToken(dir,joined.key);
          const current=readState(dir).sessions.find(session=>session.key===joined.key);
          if(!current||fingerprint(current)!==entry.fingerprint){changed();return;}
          for await(const raw of memberStream(current,token,controller.signal,()=>{opened=true;})){
            const frame=memberStreamFrame(raw);
            if(frame.type==='ended'){terminal=true;break;}
            if(await acceptMemberDelivery(dir,joined.key,runner,frame)){recovered=false;await flush(dir,sources);}
          }
        }catch(error){if(!controller.signal.aborted)log(dir,`${joined.key}: ${error instanceof Error?error.message:String(error)}`);}
        if(controller.signal.aborted||terminal||!opened||recovered)return;
        // One replacement after an established stream drops. A failed initial
        // or replacement connection parks until credentials/join state changes.
        recovered=true;
      }
    })();
  };
  try{
    for(;;){
      localDirty=false;
      const sessions=readState(dir).sessions;
      if(!sessions.length)break;
      for(const [key,stream]of streams)if(!sessions.some(session=>session.key===key)){
        stream.controller.abort();streams.delete(key);
      }
      for(const joined of sessions){
        const old=streams.get(joined.key);
        if(!old||old.fingerprint!==fingerprint(joined)){
          old?.controller.abort();start(joined);
        }
        const path=outboxDir(joined.cwd);
        if(!outboxWatches.has(path)){
          mkdirSync(path,{recursive:true,mode:0o700});
          const ignore=join(joined.cwd,'.beeline','.gitignore');if(!existsSync(ignore))writeFileSync(ignore,'*\n',{mode:0o600});
          outboxWatches.set(path,watch(path,(_event,name)=>{if(String(name??'').endsWith('.request.json'))changed();}));
        }
      }
      await serveOutboxes(dir).catch(error=>log(dir,`outbox: ${String(error)}`));
      await flush(dir,sources).catch(error=>log(dir,`flush: ${String(error)}`));
      if(!localDirty)await new Promise<void>(resolve=>{wake=resolve;});
      wake=undefined;
    }
  }finally{
    localWatch.close();for(const watcher of outboxWatches.values())watcher.close();
    for(const stream of streams.values()){stream.controller.abort();}
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
