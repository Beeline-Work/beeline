import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';
import { systemLine } from './system-line.js';

export type ComputerSessionRow = {
  id: string;
  room_id: string;
  message_id: string;
  agent_id: string;
  source_session_id: string;
  upstream_url: string;
  status: 'live' | 'ended';
  relay_instance_id: string | null;
  handoff_count: number;
};
const latestFrames = new Map<string, Buffer>();
const savedFrameAt = new Map<string, number>();
const handbackWaiters = new Map<string, Set<WebSocket>>();
const MAX_VIEWER_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Persist a bounded recent frame so an end request on another server instance has a snapshot. */
function rememberFrame(database: SqlDatabase, id: string, frame: Buffer | undefined): void {
  if (!frame) return;
  latestFrames.set(id, frame);
  const now = Date.now();
  if (now - (savedFrameAt.get(id) ?? 0) < 5_000) return;
  savedFrameAt.set(id, now);
  void database.query(`UPDATE computer_sessions SET last_frame=$2 WHERE id=$1 AND status='live'`, [id, frame])
    .catch(() => { savedFrameAt.delete(id); });
}

function notifyWaiters(id: string, value: { type: 'handoff' | 'ended'; note?: string }): void {
  const waiting = handbackWaiters.get(id);
  handbackWaiters.delete(id);
  for (const waiter of waiting ?? []) {
    if (waiter.readyState === WebSocket.OPEN) waiter.send(JSON.stringify(value));
    waiter.close();
  }
}

export async function noteComputerHandback(database: SqlDatabase, row: ComputerSessionRow): Promise<void> {
  const changed = await database.query(
    `UPDATE computer_sessions SET handoff_count=handoff_count+1 WHERE id=$1 AND status='live'`, [row.id],
  );
  if (changed.rowCount) notifyWaiters(row.id, { type: 'handoff', note: 'Human handed the browser back' });
}

/** The public origin can move to computer.usebeeline.app after DNS and TLS are ready. */
export function computerSessionUrl(id: string): string {
  const origin = process.env.BEELINE_COMPUTER_ORIGIN || 'https://server.usebeeline.app';
  return `${origin.replace(/\/$/, '')}/s/${id}`;
}

export async function createComputerSession(
  database: SqlDatabase,
  live: LiveHub,
  input: { roomId: string; agentId: string; sessionId: string; upstreamUrl: string; title?: string },
): Promise<{ id: string; url: string }> {
  const bodySource = input.upstreamUrl === 'body:';
  const upstream = bodySource ? undefined : new URL(input.upstreamUrl);
  if (!bodySource && (!upstream || !['http:', 'https:', 'ws:', 'wss:'].includes(upstream.protocol) || upstream.username || upstream.password))
    throw new Error('computer share URL is invalid');
  if (!input.sessionId.trim() || input.sessionId.length > 240)
    throw new Error('computer session id is invalid');
  const title = input.title?.trim().slice(0, 120) || 'Browser';
  const id = randomBytes(32).toString('base64url');
  const messageId = randomBytes(32).toString('hex');
  const url = computerSessionUrl(id);
  const agent = (await database.query<{ name: string }>(
    'SELECT name FROM identities WHERE id=$1', [input.agentId],
  )).rows[0];
  if (!agent) throw new Error('computer session agent missing');
  await database.transaction(async (db) => {
    await systemLine(db, {
      id: messageId,
      roomId: input.roomId,
      authorId: input.agentId,
      subject: { kind: 'agent', id: input.agentId, name: agent.name },
      verb: 'shared',
      object: 'a live browser',
      presentation: 'card',
      cardType: 'computer-session',
      card: { id, url, title, status: 'live', lastFrameUrl: `${url}/last.jpg` },
    });
    await db.query(
      `INSERT INTO computer_sessions(id,room_id,message_id,agent_id,source_session_id,upstream_url,relay_instance_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, input.roomId, messageId, input.agentId, input.sessionId, upstream?.toString() ?? 'body:', process.env.FLY_MACHINE_ID ?? null],
    );
  });
  live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'message', agentId: input.agentId });
  return { id, url };
}

export async function getComputerSession(database: SqlDatabase, id: string): Promise<ComputerSessionRow | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return undefined;
  return (await database.query<ComputerSessionRow>(
    `SELECT id,room_id,message_id,agent_id,source_session_id,upstream_url,status,relay_instance_id,handoff_count
     FROM computer_sessions WHERE id=$1`, [id],
  )).rows[0];
}

export async function endComputerSession(
  database: SqlDatabase,
  live: LiveHub,
  row: ComputerSessionRow,
  lastFrame?: Buffer,
): Promise<void> {
  if (row.status === 'ended') return;
  const changed = await database.transaction(async (db) => {
    const update = await db.query(
      `UPDATE computer_sessions SET status='ended',ended_at=now(),last_frame=COALESCE($2,last_frame)
       WHERE id=$1 AND status='live'`, [row.id, lastFrame ?? latestFrames.get(row.id) ?? null],
    );
    if (!update.rowCount) return false;
    await db.query(
      `UPDATE messages SET card=jsonb_set(card,'{status}','"ended"'::jsonb)
       WHERE id=$1 AND card_type='computer-session'`, [row.message_id],
    );
    return true;
  });
  if (changed) live.publish({ type: 'invalidate', roomId: row.room_id, reason: 'message', agentId: row.agent_id });
  latestFrames.delete(row.id);
  savedFrameAt.delete(row.id);
  if (changed) notifyWaiters(row.id, { type: 'ended' });
}

export async function serveComputerLastFrame(response: ServerResponse, database: SqlDatabase, id: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) { response.writeHead(404).end(); return; }
  const found = (await database.query<{ last_frame: Buffer | null }>(
    `SELECT last_frame FROM computer_sessions WHERE id=$1 AND status='ended'`, [id],
  )).rows[0];
  if (!found?.last_frame) { response.writeHead(404, { 'cache-control': 'no-store' }).end(); return; }
  response.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  response.end(found.last_frame);
}

/** One authoritative read when a live viewer's socket reconnects. */
export async function serveComputerStatus(response: ServerResponse, database: SqlDatabase, id: string): Promise<void> {
  const row = await getComputerSession(database, id);
  response.writeHead(row ? 200 : 404, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify({ status: row?.status ?? 'ended' }));
}

function frameBytes(data: WebSocket.RawData): Buffer | undefined {
  try {
    const message = JSON.parse(data.toString()) as { method?: string; params?: { data?: string } };
    if (message.method !== 'Page.screencastFrame' || typeof message.params?.data !== 'string') return undefined;
    const bytes = Buffer.from(message.params.data, 'base64');
    return bytes.length <= 2 * 1024 * 1024 ? bytes : undefined;
  } catch { return undefined; }
}

/** A bearer URL is the only public entry. Never redirect to the Squire host. */
export async function serveComputerSession(
  request: IncomingMessage,
  response: ServerResponse,
  database: SqlDatabase,
  live: LiveHub,
  id: string,
): Promise<void> {
  const row = await getComputerSession(database, id);
  if (!row || row.status !== 'live') {
    response.writeHead(410, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('This browser session has ended.');
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' wss: ws:; base-uri 'none'; form-action 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(computerViewerHtml(id));
}

/** One protocol for both Squire's share adapter and an agent-owned CDP tab. */
export function computerViewerHtml(id: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>Browser · Beeline</title><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#1b1320;color:#f6edf4;font-family:system-ui,sans-serif}
  #screen{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;touch-action:none}
  #ended{display:none;position:absolute;inset:0;place-items:center;font-size:16px}
  #controls{position:absolute;top:env(safe-area-inset-top,12px);right:12px;display:flex;gap:8px}
  button,a{border:1px solid #ffffff44;border-radius:999px;background:#261a2ad9;color:#f6edf4;padding:10px 14px;font:500 13px system-ui,sans-serif;text-decoration:none;cursor:pointer}
  body.embedded #controls{display:none}
  #keys{position:absolute;opacity:0;width:1px;height:1px;left:0;bottom:0}
  </style></head><body><img id="screen" alt="Live browser"><div id="ended">Browser session ended</div><input id="keys" autocomplete="off" autocapitalize="off"><div id="controls"><button id="back" aria-label="Close browser">✕</button><a id="external" target="_blank" rel="noopener noreferrer" href="/s/${id}">Open in browser ↗</a></div><script>
  const query=new URLSearchParams(location.search), preview=query.has('preview');
  if(query.has('embedded')) document.body.classList.add('embedded');
  const image=document.getElementById('screen'), ended=document.getElementById('ended'), keys=document.getElementById('keys');
  const socketUrl=(location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/s/${id}/ws'+(preview?'?preview=1':'');
  let wire, serial=1, controlling=false, width=1, height=1, leaving=false, endedSession=false, reconnected=false;
  function send(value){if(wire.readyState===WebSocket.OPEN) wire.send(JSON.stringify(value));}
  function cdp(method,params={}){send({id:serial++,method,params});}
  function takeover(){if(!controlling){controlling=true;send({type:'takeover'});}}
  function finish(){if(leaving)return;leaving=true;if(controlling){send({type:'release'});controlling=false;}if(!preview)send({type:'leave'});}
  function showEnded(){endedSession=true;image.style.display='none';ended.textContent='Browser session ended';ended.style.display='grid';document.getElementById('external').style.display='none';
    const notice=JSON.stringify({type:'computer-ended',id:'${id}'});parent.postMessage({type:'computer-ended',id:'${id}'},'*');window.ReactNativeWebView?.postMessage(notice);}
  function showLost(){ended.textContent='Connection lost · reopen to retry';ended.style.display='grid';}
  function connect(){wire=new WebSocket(socketUrl);
    wire.onopen=()=>{cdp('Page.startScreencast',{format:'jpeg',quality:preview?45:65,maxWidth:preview?640:1280,maxHeight:preview?450:900,everyNthFrame:1});if(document.hidden)send({type:'pause-view'});};
    wire.onmessage=event=>{try{const message=JSON.parse(event.data);
      if(message.type==='ended'){showEnded();return;}
      if(message.method==='Page.screencastFrame'){const p=message.params;image.src='data:image/jpeg;base64,'+p.data;width=p.metadata?.deviceWidth||image.naturalWidth||width;height=p.metadata?.deviceHeight||image.naturalHeight||height;cdp('Page.screencastFrameAck',{sessionId:p.sessionId});}
    }catch{}};
    wire.onclose=async()=>{if(leaving||endedSession)return;controlling=false;
      if(reconnected){showLost();return;}reconnected=true;
      try{const response=await fetch('/s/${id}/status',{cache:'no-store'});const status=await response.json();
        if(status.status==='ended'){showEnded();return;}
        if(status.status!=='live'){showLost();return;}
        setTimeout(()=>{if(!leaving)connect();},300);
      }catch{showLost();}};
  }
  connect();
  document.addEventListener('visibilitychange',()=>send({type:document.hidden?'pause-view':'resume-view'}));
  function point(event){const r=image.getBoundingClientRect(),scale=Math.min(r.width/width,r.height/height),left=r.left+(r.width-width*scale)/2,top=r.top+(r.height-height*scale)/2;return {x:Math.max(0,Math.min(width,(event.clientX-left)/scale)),y:Math.max(0,Math.min(height,(event.clientY-top)/scale))};}
  let touch;
  image.addEventListener('pointerdown',event=>{if(preview)return;takeover();const p=point(event);image.setPointerCapture(event.pointerId);
    if(event.pointerType==='touch'){touch={id:event.pointerId,x:p.x,y:p.y,moved:false};return;}
    keys.focus();cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});});
  image.addEventListener('pointermove',event=>{if(!controlling||!event.buttons)return;const p=point(event);
    if(touch?.id===event.pointerId){const dx=touch.x-p.x,dy=touch.y-p.y;if(Math.abs(dx)+Math.abs(dy)>3){touch.moved=true;cdp('Input.dispatchMouseEvent',{type:'mouseWheel',x:p.x,y:p.y,deltaX:dx,deltaY:dy});}touch.x=p.x;touch.y=p.y;return;}
    cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y,button:'left',buttons:1});});
  image.addEventListener('pointerup',event=>{if(!controlling)return;const p=point(event);
    if(touch?.id===event.pointerId){if(!touch.moved){cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});keys.focus();}touch=undefined;return;}
    cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});});
  image.addEventListener('wheel',event=>{if(preview)return;event.preventDefault();takeover();const p=point(event);cdp('Input.dispatchMouseEvent',{type:'mouseWheel',x:p.x,y:p.y,deltaX:event.deltaX,deltaY:event.deltaY});},{passive:false});
  keys.addEventListener('input',()=>{if(keys.value){takeover();cdp('Input.insertText',{text:keys.value});keys.value='';}});
  keys.addEventListener('keydown',event=>{if(['Enter','Backspace','Tab','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){takeover();cdp('Input.dispatchKeyEvent',{type:'keyDown',key:event.key,code:event.code});cdp('Input.dispatchKeyEvent',{type:'keyUp',key:event.key,code:event.code});event.preventDefault();}});
  document.getElementById('back').onclick=()=>{finish();window.close();history.back();};
  addEventListener('pagehide',finish);
  </script></body></html>`;
}

const computerWebSockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
type BodyChannel = { source?: WebSocket; viewers: Set<WebSocket>; interactiveViewers: Set<WebSocket>; pausedViewers: Set<WebSocket>; previewSentAt: Map<WebSocket, number>; controller?: WebSocket; handoffComplete?: boolean; pendingHandback?: ReturnType<typeof setTimeout>; ending?: boolean; lastFrame?: Buffer; lastFrameMessage?: WebSocket.RawData; lastFrameBinary?: boolean };
const bodyChannels = new Map<string, BodyChannel>();
type SquireChannel = { viewers: Set<WebSocket>; controller?: WebSocket; handoffComplete: boolean; pendingHandback?: ReturnType<typeof setTimeout> };
const squireChannels = new Map<string, SquireChannel>();

function bodyChannel(id: string): BodyChannel {
  let channel = bodyChannels.get(id);
  if (!channel) { channel = { viewers: new Set(), interactiveViewers: new Set(), pausedViewers: new Set(), previewSentAt: new Map() }; bodyChannels.set(id, channel); }
  return channel;
}

/** The agent's pending tool call waits here; the database counter closes a reconnect race. */
export async function upgradeComputerWaiter(
  request: IncomingMessage, socket: Duplex, head: Buffer,
  database: SqlDatabase, id: string, agentId: string, since: number,
): Promise<void> {
  const row = await getComputerSession(database, id);
  if (!row || row.agent_id !== agentId) { socket.destroy(); return; }
  if (replayToSourceMachine(socket, row)) return;
  computerWebSockets.handleUpgrade(request, socket, head, (waiter) => {
    let waiting = handbackWaiters.get(id);
    if (!waiting) { waiting = new Set(); handbackWaiters.set(id, waiting); }
    waiting.add(waiter);
    waiter.once('close', () => {
      waiting!.delete(waiter);
      if (!waiting!.size) handbackWaiters.delete(id);
    });
    void getComputerSession(database, id).then((current) => {
      if (waiter.readyState !== WebSocket.OPEN) return;
      if (!current || current.status === 'ended') {
        waiter.send(JSON.stringify({ type: 'ended' })); waiter.close();
      } else if (current.handoff_count > since) {
        waiter.send(JSON.stringify({ type: 'handoff', note: 'Human handed the browser back' })); waiter.close();
      }
    }).catch(() => waiter.close());
  });
}

function replayToSourceMachine(socket: Duplex, row: ComputerSessionRow): boolean {
  if (!row.relay_instance_id || !process.env.FLY_MACHINE_ID || row.relay_instance_id === process.env.FLY_MACHINE_ID)
    return false;
  socket.write(`HTTP/1.1 307 Temporary Redirect\r\nfly-replay: instance=${row.relay_instance_id}\r\ncontent-length: 0\r\n\r\n`);
  socket.end();
  return true;
}

/** The body connects outward to the server; its local CDP port is never public. */
export async function upgradeBodyComputerSource(
  request: IncomingMessage, socket: Duplex, head: Buffer,
  database: SqlDatabase, live: LiveHub, id: string, agentId: string,
): Promise<void> {
  const row = await getComputerSession(database, id);
  if (!row || row.status !== 'live' || row.agent_id !== agentId || row.upstream_url !== 'body:') {
    socket.destroy(); return;
  }
  if (replayToSourceMachine(socket, row)) return;
  computerWebSockets.handleUpgrade(request, socket, head, (source) => {
    const channel = bodyChannel(id);
    channel.source?.close();
    channel.source = source;
    source.on('message', (data, binary) => {
      const frame = frameBytes(data);
      channel.lastFrame = frame ?? channel.lastFrame;
      if (frame) {
        channel.lastFrameMessage = data;
        channel.lastFrameBinary = binary;
        rememberFrame(database, id, frame);
      }
      const now = Date.now();
      for (const viewer of channel.viewers) {
        if (frame && channel.pausedViewers.has(viewer)) continue;
        if (frame && !channel.interactiveViewers.has(viewer)) {
          const last = channel.previewSentAt.get(viewer) ?? 0;
          if (now - last < 1_000) continue;
          channel.previewSentAt.set(viewer, now);
        }
        if (viewer.readyState === WebSocket.OPEN && viewer.bufferedAmount < MAX_VIEWER_BUFFERED_BYTES)
          viewer.send(data, { binary });
      }
    });
    source.once('close', () => {
      if (channel.source !== source) return;
      channel.ending = true;
      if (channel.pendingHandback) clearTimeout(channel.pendingHandback);
      channel.source = undefined;
      const closeViewers = () => {
        for (const viewer of channel.viewers) {
          if (viewer.readyState === WebSocket.OPEN) viewer.send(JSON.stringify({ type: 'ended' }));
          viewer.close();
        }
        bodyChannels.delete(id);
      };
      void endComputerSession(database, live, row, channel.lastFrame).then(closeViewers, closeViewers);
    });
  });
}

function upgradeBodyViewer(request: IncomingMessage, socket: Duplex, head: Buffer, database: SqlDatabase, row: ComputerSessionRow): void {
  const preview = new URL(request.url ?? '/', 'http://beeline.local').searchParams.has('preview');
  computerWebSockets.handleUpgrade(request, socket, head, (viewer) => {
    const channel = bodyChannel(row.id);
    if (channel.pendingHandback) { clearTimeout(channel.pendingHandback); channel.pendingHandback = undefined; }
    if (row.handoff_count > 0) channel.handoffComplete = true;
    channel.viewers.add(viewer);
    if (!preview) channel.interactiveViewers.add(viewer);
    const handBack = () => {
      if (preview || channel.handoffComplete || channel.ending) return;
      if (channel.pendingHandback) { clearTimeout(channel.pendingHandback); channel.pendingHandback = undefined; }
      channel.handoffComplete = true;
      void noteComputerHandback(database, row);
    };
    const scheduleHandBack = () => {
      if (preview || channel.handoffComplete || channel.ending || channel.pendingHandback) return;
      channel.pendingHandback = setTimeout(() => {
        channel.pendingHandback = undefined;
        if (!channel.interactiveViewers.size) handBack();
      }, 5_000);
    };
    viewer.on('message', (data) => {
      let message: { type?: string; method?: string };
      try { message = JSON.parse(data.toString()) as typeof message; } catch { return; }
      if (message.type === 'pause-view') channel.pausedViewers.add(viewer);
      else if (message.type === 'resume-view') {
        channel.pausedViewers.delete(viewer);
        if (channel.lastFrameMessage && viewer.readyState === WebSocket.OPEN)
          viewer.send(channel.lastFrameMessage, { binary: channel.lastFrameBinary });
      } else if (message.type === 'takeover' && !channel.controller && !channel.handoffComplete) {
        channel.controller = viewer;
        channel.source?.send(data);
      } else if (message.type === 'release' && channel.controller === viewer) {
        channel.controller = undefined;
        channel.source?.send(data);
        handBack();
      } else if (message.type === 'leave') {
        if (channel.controller === viewer) {
          channel.controller = undefined;
          channel.source?.send(JSON.stringify({ type: 'release' }));
        }
        handBack();
      } else if (message.method?.startsWith('Input.') && channel.controller === viewer) {
        channel.source?.send(data);
      }
    });
    viewer.once('close', () => {
      channel.viewers.delete(viewer);
      channel.interactiveViewers.delete(viewer);
      channel.pausedViewers.delete(viewer);
      channel.previewSentAt.delete(viewer);
      if (channel.controller === viewer) {
        channel.controller = undefined;
        channel.source?.send(JSON.stringify({ type: 'release' }));
        handBack();
      }
      if (!channel.interactiveViewers.size) scheduleHandBack();
    });
  });
}

export async function upgradeComputerSession(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  database: SqlDatabase,
  live: LiveHub,
  id: string,
): Promise<void> {
  const row = await getComputerSession(database, id);
  if (!row || row.status !== 'live') { socket.destroy(); return; }
  if (replayToSourceMachine(socket, row)) return;
  if (row.upstream_url === 'body:') { upgradeBodyViewer(request, socket, head, database, row); return; }
  const target = new URL(row.upstream_url);
  if (target.protocol === 'https:') target.protocol = 'wss:';
  if (target.protocol === 'http:') target.protocol = 'ws:';
  if (!['ws:', 'wss:'].includes(target.protocol)) { socket.destroy(); return; }
  const upstream = new WebSocket(target.toString());
  let lastFrame: Buffer | undefined;
  const preview = new URL(request.url ?? '/', 'http://beeline.local').searchParams.has('preview');
  upstream.once('open', () => {
    computerWebSockets.handleUpgrade(request, socket, head, (viewer) => {
      let channel = squireChannels.get(id);
      if (!channel) { channel = { viewers: new Set(), handoffComplete: row.handoff_count > 0 }; squireChannels.set(id, channel); }
      if (channel.pendingHandback) { clearTimeout(channel.pendingHandback); channel.pendingHandback = undefined; }
      if (!preview) channel.viewers.add(viewer);
      let sessionEnded = false;
      let viewerGone = false;
      const handBack = () => {
        if (preview || channel!.handoffComplete || sessionEnded) return;
        if (channel!.pendingHandback) { clearTimeout(channel!.pendingHandback); channel!.pendingHandback = undefined; }
        channel!.handoffComplete = true;
        void noteComputerHandback(database, row);
      };
      const scheduleHandBack = () => {
        if (preview || channel!.handoffComplete || sessionEnded || channel!.pendingHandback) return;
        channel!.pendingHandback = setTimeout(() => {
          channel!.pendingHandback = undefined;
          if (!channel!.viewers.size) {
            handBack();
            squireChannels.delete(id);
          }
        }, 5_000);
      };
      viewer.on('message', (data, binary) => {
        let message: { type?: string; method?: string };
        try { message = JSON.parse(data.toString()) as typeof message; } catch { return; }
        if (message.type === 'pause-view' || message.type === 'resume-view') {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ id: 1,
            method: message.type === 'pause-view' ? 'Page.stopScreencast' : 'Page.startScreencast',
            params: message.type === 'pause-view' ? {} : { format: 'jpeg', quality: preview ? 45 : 65,
              maxWidth: preview ? 640 : 1280, maxHeight: preview ? 450 : 900, everyNthFrame: 1 },
          }));
          return;
        }
        if (message.type === 'takeover') {
          if (preview || channel!.controller || channel!.handoffComplete) return;
          channel!.controller = viewer;
        } else if (message.type === 'release') {
          if (channel!.controller !== viewer) return;
          channel!.controller = undefined;
          handBack();
        } else if (message.type === 'leave') {
          if (channel!.controller === viewer) {
            channel!.controller = undefined;
            if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: 'release' }));
          }
          handBack();
        } else if (message.method?.startsWith('Input.') && channel!.controller !== viewer) return;
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      });
      upstream.on('message', (data, binary) => {
        const frame = frameBytes(data);
        lastFrame = frame ?? lastFrame;
        if (frame) rememberFrame(database, id, frame);
        if (viewer.readyState === WebSocket.OPEN) {
          if (viewer.bufferedAmount < MAX_VIEWER_BUFFERED_BYTES) viewer.send(data, { binary });
          else viewer.close(1013, 'screen backpressure');
        }
      });
      viewer.once('close', () => {
        viewerGone = true;
        channel!.viewers.delete(viewer);
        if (channel!.controller === viewer) {
          channel!.controller = undefined;
          if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: 'release' }));
        }
        if (!channel!.viewers.size) scheduleHandBack();
        if (!channel!.viewers.size && channel!.handoffComplete) squireChannels.delete(id);
        upstream.close();
      });
      upstream.once('close', () => {
        // A viewer closes its own upstream socket. An upstream close first
        // means this share endpoint can no longer serve a live browser.
        sessionEnded = !viewerGone;
        if (sessionEnded && channel!.pendingHandback) clearTimeout(channel!.pendingHandback);
        if (sessionEnded) {
          const closeViewer = () => {
            if (viewer.readyState === WebSocket.OPEN) viewer.send(JSON.stringify({ type: 'ended' }));
            viewer.close();
          };
          void endComputerSession(database, live, row, lastFrame).then(closeViewer, closeViewer);
        } else viewer.close();
      });
      upstream.once('error', () => viewer.close());
    });
  });
  upstream.once('error', () => socket.destroy());
}
