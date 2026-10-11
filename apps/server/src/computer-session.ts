import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseAgentAccessPolicy, senderMayAddressAgent } from '@beeline/api-contract/agent-access';
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
  view_secret: Buffer | null;
};
const handbackWaiters = new Map<string, Set<WebSocket>>();
const MAX_VIEWER_BUFFERED_BYTES = 4 * 1024 * 1024;

const VIEW_TOKEN_LIFETIME_MS = 60 * 60_000;

async function mayViewComputer(database: SqlDatabase, row: ComputerSessionRow, viewerId: string): Promise<boolean> {
  const result = await database.query<{ access_policy: unknown; owner_id: string | null }>(
    `SELECT agent.access_policy,agent.owner_id FROM agents agent
     JOIN identities viewer ON viewer.id=$3 AND viewer.kind='human'
     JOIN rooms room ON room.id=$1 AND room.archived_at IS NULL
     JOIN memberships member ON member.room_id=room.id AND member.identity_id=$3
       AND member.removed_at IS NULL AND member.role<>'spectator'
     JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
       AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$3
       AND workspace_member.removed_at IS NULL AND workspace_member.role<>'spectator'
     JOIN memberships agent_member ON agent_member.room_id=room.id
       AND agent_member.identity_id=$2 AND agent_member.removed_at IS NULL
     WHERE agent.agent_id=$2`, [row.room_id, row.agent_id, viewerId],
  );
  const agent = result.rows[0];
  return Boolean(agent && senderMayAddressAgent(
    parseAgentAccessPolicy(agent.access_policy), viewerId, agent.owner_id ?? undefined,
  ));
}

/** A Room reader obtains a short-lived, viewer-bound URL only through phone auth. */
export async function computerViewToken(database: SqlDatabase, id: string, viewerId: string): Promise<string | null> {
  const row = await getComputerSession(database, id);
  if (!row || row.status !== 'live' || !row.view_secret || !(await mayViewComputer(database, row, viewerId))) return null;
  const expires = Date.now() + VIEW_TOKEN_LIFETIME_MS;
  const body = `${row.id}.${viewerId}.${expires}`;
  const signature = createHmac('sha256', row.view_secret).update(body).digest('hex');
  return `${viewerId}.${expires}.${signature}`;
}

async function authorizedViewer(request: IncomingMessage, database: SqlDatabase, row: ComputerSessionRow): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://beeline.local');
  const token = url.searchParams.get('access') ?? '';
  const [, viewerId, expiresText, signature] = /^(?:([0-9a-f]{64})\.([0-9]{13})\.([0-9a-f]{64}))$/.exec(token) ?? [];
  if (!viewerId || !expiresText || !signature || !row.view_secret || Number(expiresText) <= Date.now()) return false;
  const expected = createHmac('sha256', row.view_secret)
    .update(`${row.id}.${viewerId}.${expiresText}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return false;
  return mayViewComputer(database, row, viewerId);
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
  return `${origin.replace(/\/$/, '')}/s/${id}/`;
}

export async function createComputerSession(
  database: SqlDatabase,
  live: LiveHub,
  input: { roomId: string; agentId: string; sessionId: string; upstreamUrl: string; title?: string },
): Promise<{ id: string; url: string }> {
  const bodySource = input.upstreamUrl === 'body:';
  const upstream = bodySource ? undefined : new URL(input.upstreamUrl);
  if (!bodySource && (!upstream || !['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password))
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
      card: { id, url, title, status: 'live' },
    });
    await db.query(
      `INSERT INTO computer_sessions(id,room_id,message_id,agent_id,source_session_id,upstream_url,relay_instance_id,view_secret)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, input.roomId, messageId, input.agentId, input.sessionId, upstream?.toString() ?? 'body:', process.env.FLY_MACHINE_ID ?? null, randomBytes(32)],
    );
  });
  live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'message', agentId: input.agentId });
  return { id, url };
}

export async function getComputerSession(database: SqlDatabase, id: string): Promise<ComputerSessionRow | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return undefined;
  return (await database.query<ComputerSessionRow>(
    `SELECT id,room_id,message_id,agent_id,source_session_id,upstream_url,status,relay_instance_id,handoff_count,view_secret
     FROM computer_sessions WHERE id=$1`, [id],
  )).rows[0];
}

export async function endComputerSession(
  database: SqlDatabase,
  live: LiveHub,
  row: ComputerSessionRow,
): Promise<void> {
  if (row.status === 'ended') return;
  const changed = await database.transaction(async (db) => {
    const update = await db.query(
      `UPDATE computer_sessions SET status='ended',ended_at=now()
       WHERE id=$1 AND status='live'`, [row.id],
    );
    if (!update.rowCount) return false;
    await db.query(
      `UPDATE messages SET card=jsonb_set(card,'{status}','"ended"'::jsonb)
       WHERE id=$1 AND card_type='computer-session'`, [row.message_id],
    );
    return true;
  });
  if (changed) live.publish({ type: 'invalidate', roomId: row.room_id, reason: 'message', agentId: row.agent_id });
  if (changed) notifyWaiters(row.id, { type: 'ended' });
}

/** One authoritative read when a live viewer's socket reconnects. */
export async function serveComputerStatus(request: IncomingMessage, response: ServerResponse, database: SqlDatabase, id: string): Promise<void> {
  const row = await getComputerSession(database, id);
  if (!row || !(await authorizedViewer(request, database, row))) { response.writeHead(403).end(); return; }
  response.writeHead(row ? 200 : 404, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify({ status: row?.status ?? 'ended' }));
}

function isFrameMessage(data: WebSocket.RawData): boolean {
  try {
    const message = JSON.parse(data.toString()) as { method?: string; params?: { data?: string }; type?: string; data?: string };
    const encoded = message.type === 'frame' ? message.data : message.method === 'Page.screencastFrame' ? message.params?.data : undefined;
    return typeof encoded === 'string';
  } catch { return false; }
}

/** The public session path needs a viewer token and current Room/agent authority. */
export async function serveComputerSession(
  request: IncomingMessage,
  response: ServerResponse,
  database: SqlDatabase,
  live: LiveHub,
  id: string,
): Promise<void> {
  const row = await getComputerSession(database, id);
  if (!row || !(await authorizedViewer(request, database, row))) { response.writeHead(403).end(); return; }
  if (!row || row.status !== 'live') {
    response.writeHead(410, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('This browser session has ended.');
    return;
  }
  if (row.upstream_url !== 'body:') {
    if (new URL(request.url ?? '/', 'http://beeline.local').pathname === `/s/${id}`) {
      response.writeHead(308, { location: `/s/${id}/`, 'cache-control': 'no-store' }).end();
      return;
    }
    const upstream = await fetch(row.upstream_url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
      .catch(() => undefined);
    if (!upstream) { response.writeHead(502, { 'cache-control': 'no-store' }).end(); return; }
    if (!upstream.ok) {
      response.writeHead(upstream.status === 410 || upstream.status === 404 ? 410 : 502,
        { 'cache-control': 'no-store' }).end();
      return;
    }
    const html = await upstream.text().catch(() => undefined);
    if (!html) { response.writeHead(502, { 'cache-control': 'no-store' }).end(); return; }
    // The Squire page uses a relative "stream" URL. This small host bridge
    // reconciles one close with our session row and notifies the artifact view.
    const coverStyle = `<style>
      html,body{background:#1b1320!important}
      #screen{display:block!important;overflow:auto!important;align-items:unset!important;justify-content:unset!important;touch-action:none!important}
      canvas{display:block!important;max-width:none!important;max-height:none!important;object-fit:fill!important;touch-action:none!important}
      #bar{position:fixed!important;z-index:2;right:12px;bottom:12px;padding:0!important;background:transparent!important}
      #state{display:none!important}
      #focus{width:42px;height:42px;margin:0!important;padding:0;border:1px solid #ffffff44;border-radius:14px;background:#261a2ae8;color:#f6edf4;font-size:0}
      #focus::before{content:'⌨';font-size:20px}
      @media(pointer:fine){#bar{display:none!important}}
    </style>`;
    const bridge = `<script>
      const beelineScreen=document.getElementById('screen'),beelineCanvas=document.getElementById('canvas');
      if(new URLSearchParams(location.search).has('preview'))document.getElementById('bar').style.display='none';
      function beelineFit(){if(!beelineCanvas.width||!beelineCanvas.height)return;
        const scale=Math.max(beelineScreen.clientWidth/beelineCanvas.width,beelineScreen.clientHeight/beelineCanvas.height);
        beelineCanvas.style.width=Math.ceil(beelineCanvas.width*scale)+'px';
        beelineCanvas.style.height=Math.ceil(beelineCanvas.height*scale)+'px';}
      new MutationObserver(beelineFit).observe(beelineCanvas,{attributes:true,attributeFilter:['width','height']});
      addEventListener('resize',beelineFit);beelineFit();
      if(matchMedia('(pointer:coarse)').matches){let drag;
        beelineCanvas.addEventListener('pointerdown',event=>{if(event.pointerType!=='touch')return;
          event.preventDefault();event.stopImmediatePropagation();beelineCanvas.setPointerCapture(event.pointerId);
          drag={id:event.pointerId,x:event.clientX,y:event.clientY,moved:false};beelineCanvas.focus();},true);
        beelineCanvas.addEventListener('pointermove',event=>{if(event.pointerType!=='touch'||drag?.id!==event.pointerId)return;
          event.preventDefault();event.stopImmediatePropagation();const dx=drag.x-event.clientX,dy=drag.y-event.clientY;
          if(Math.abs(dx)+Math.abs(dy)>3){drag.moved=true;
            if(Math.abs(dx)>Math.abs(dy)&&beelineScreen.scrollWidth>beelineScreen.clientWidth)beelineScreen.scrollLeft+=dx;
            else send({type:'wheel',delta_x:dx,delta_y:dy,...point(event)});}
          drag.x=event.clientX;drag.y=event.clientY;},true);
        beelineCanvas.addEventListener('pointerup',event=>{if(event.pointerType!=='touch'||drag?.id!==event.pointerId)return;
          event.preventDefault();event.stopImmediatePropagation();
          if(!drag.moved){const p=point(event);send({type:'touch',phase:'start',...p});send({type:'touch',phase:'end',...p});}
          drag=undefined;},true);
        beelineCanvas.addEventListener('pointercancel',event=>{if(event.pointerType==='touch')drag=undefined;},true);
      }
      socket.addEventListener('close',async()=>{
        try{const reply=await fetch('status'+location.search,{cache:'no-store'});const state=await reply.json();
          if(state.status==='live'&&!new URLSearchParams(location.search).has('reconnected')){
            const next=new URL(location.href);next.searchParams.set('reconnected','1');location.replace(next.href);return;
          }
          if(state.status==='ended'){
            const value={type:'computer-ended',id:'${id}'};
            parent.postMessage(value,'*');window.ReactNativeWebView?.postMessage(JSON.stringify(value));
          }
        }catch{}
      });
    </script>`;
    const securedHtml = html.replace('new URL("stream", location.href)', 'new URL("stream" + location.search, location.href)');
    if (securedHtml === html) { response.writeHead(502, { 'cache-control': 'no-store' }).end(); return; }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' wss: ws:; base-uri 'none'; form-action 'none'",
      'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    });
    response.end(securedHtml.replace('</head>', `${coverStyle}</head>`).replace('</body>', `${bridge}</body>`));
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

/** Viewer for an agent-owned CDP tab; Squire serves its own canvas viewer through the proxy. */
export function computerViewerHtml(id: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>Browser · Beeline</title><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#1b1320;color:#f6edf4;font-family:system-ui,sans-serif}
  #stage{position:absolute;inset:0;overflow:auto;background:#1b1320}
  #screen{display:block;height:100%;width:auto;max-width:none;object-fit:fill;touch-action:none}
  #ended{display:none;position:absolute;inset:0;place-items:center;font-size:16px}
  #controls{position:absolute;top:env(safe-area-inset-top,12px);right:12px;display:flex;gap:8px}
  button,a{border:1px solid #ffffff44;border-radius:999px;background:#261a2ad9;color:#f6edf4;padding:10px 14px;font:500 13px system-ui,sans-serif;text-decoration:none;cursor:pointer}
  body.embedded #controls{display:none}
  #keys{position:absolute;opacity:0;width:1px;height:1px;left:0;bottom:0}
  </style></head><body><div id="stage"><img id="screen" alt="Live browser"></div><div id="ended">Browser session ended</div><input id="keys" autocomplete="off" autocapitalize="off"><div id="controls"><button id="back" aria-label="Close browser">✕</button></div><script>
  const query=new URLSearchParams(location.search), preview=query.has('preview');
  if(query.has('embedded')) document.body.classList.add('embedded');
  const image=document.getElementById('screen'), stage=document.getElementById('stage'), ended=document.getElementById('ended'), keys=document.getElementById('keys');
  const socketUrl=(location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/s/${id}/ws'+location.search;
  let wire, serial=1, controlling=false, width=1, height=1, leaving=false, endedSession=false, reconnected=false;
  function fit(){if(width<=1||height<=1)return;const scale=Math.max(stage.clientWidth/width,stage.clientHeight/height);
    image.style.width=Math.ceil(width*scale)+'px';image.style.height=Math.ceil(height*scale)+'px';}
  addEventListener('resize',fit);
  function send(value){if(wire.readyState===WebSocket.OPEN) wire.send(JSON.stringify(value));}
  function cdp(method,params={}){send({id:serial++,method,params});}
  function takeover(){if(!controlling){controlling=true;send({type:'takeover'});}}
  function finish(){if(leaving)return;leaving=true;if(controlling){send({type:'release'});controlling=false;}if(!preview)send({type:'leave'});}
  function showEnded(){endedSession=true;image.style.display='none';ended.textContent='Browser session ended';ended.style.display='grid';
    const notice=JSON.stringify({type:'computer-ended',id:'${id}'});parent.postMessage({type:'computer-ended',id:'${id}'},'*');window.ReactNativeWebView?.postMessage(notice);}
  function showLost(){ended.textContent='Connection lost · reopen to retry';ended.style.display='grid';}
  function connect(){wire=new WebSocket(socketUrl);
    wire.onopen=()=>{cdp('Page.startScreencast',{format:'jpeg',quality:preview?45:65,maxWidth:preview?640:1280,maxHeight:preview?450:900,everyNthFrame:1});if(document.hidden)send({type:'pause-view'});};
    wire.onmessage=event=>{try{const message=JSON.parse(event.data);
      if(message.type==='ended'){showEnded();return;}
      if(message.method==='Page.screencastFrame'){const p=message.params;image.src='data:image/jpeg;base64,'+p.data;width=p.metadata?.deviceWidth||image.naturalWidth||width;height=p.metadata?.deviceHeight||image.naturalHeight||height;fit();cdp('Page.screencastFrameAck',{sessionId:p.sessionId});}
    }catch{}};
    wire.onclose=async()=>{if(leaving||endedSession)return;controlling=false;
      if(reconnected){showLost();return;}reconnected=true;
      try{const response=await fetch('/s/${id}/status'+location.search,{cache:'no-store'});const status=await response.json();
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
    if(event.pointerType==='touch'){touch={id:event.pointerId,x:p.x,y:p.y,clientX:event.clientX,clientY:event.clientY,moved:false};return;}
    keys.focus();cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});});
  image.addEventListener('pointermove',event=>{if(!controlling||!event.buttons)return;const p=point(event);
    if(touch?.id===event.pointerId){const dx=touch.clientX-event.clientX,dy=touch.clientY-event.clientY;if(Math.abs(dx)+Math.abs(dy)>3){touch.moved=true;
      if(Math.abs(dx)>Math.abs(dy)&&stage.scrollWidth>stage.clientWidth)stage.scrollLeft+=dx;
      else cdp('Input.dispatchMouseEvent',{type:'mouseWheel',x:p.x,y:p.y,deltaX:dx,deltaY:dy});}
      touch.x=p.x;touch.y=p.y;touch.clientX=event.clientX;touch.clientY=event.clientY;return;}
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
type BodyChannel = { source?: WebSocket; viewers: Set<WebSocket>; interactiveViewers: Set<WebSocket>; pausedViewers: Set<WebSocket>; previewSentAt: Map<WebSocket, number>; controller?: WebSocket; handoffComplete?: boolean; pendingHandback?: ReturnType<typeof setTimeout>; ending?: boolean };
const bodyChannels = new Map<string, BodyChannel>();
type SquireChannel = { viewers: Set<WebSocket>; humanControl: boolean; handoffComplete: boolean; pendingHandback?: ReturnType<typeof setTimeout> };
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
      const frame = isFrameMessage(data);
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
      void endComputerSession(database, live, row).then(closeViewers, closeViewers);
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
  if (!(await authorizedViewer(request, database, row))) { socket.destroy(); return; }
  if (replayToSourceMachine(socket, row)) return;
  const path = new URL(request.url ?? '/', 'http://beeline.local').pathname;
  if (row.upstream_url === 'body:') {
    if (!path.endsWith('/ws')) { socket.destroy(); return; }
    upgradeBodyViewer(request, socket, head, database, row); return;
  }
  if (!path.endsWith('/stream')) { socket.destroy(); return; }
  const target = new URL('stream', row.upstream_url);
  if (target.protocol === 'https:') target.protocol = 'wss:';
  if (target.protocol === 'http:') target.protocol = 'ws:';
  if (!['ws:', 'wss:'].includes(target.protocol)) { socket.destroy(); return; }
  const upstream = new WebSocket(target.toString());
  const preview = new URL(request.url ?? '/', 'http://beeline.local').searchParams.has('preview');
  upstream.once('open', () => {
    computerWebSockets.handleUpgrade(request, socket, head, (viewer) => {
      let channel = squireChannels.get(id);
      if (!channel) { channel = { viewers: new Set(), humanControl: false, handoffComplete: row.handoff_count > 0 }; squireChannels.set(id, channel); }
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
        // Squire validates and arbitrates input. A transcript preview never
        // sends control, even if an embedded client is compromised.
        if (preview || Buffer.byteLength(data.toString()) > 4_096) return;
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      });
      let lastPreviewFrameAt = 0;
      upstream.on('message', (data, binary) => {
        let message: { type?: string; state?: string } | undefined;
        try { message = JSON.parse(data.toString()) as typeof message; } catch { /* Forward unknown frames. */ }
        if (message?.type === 'control') {
          if (message.state === 'human') channel!.humanControl = true;
          if (message.state === 'agent' && channel!.humanControl) {
            channel!.humanControl = false;
            handBack();
          }
        }
        const frame = isFrameMessage(data);
        if (frame && preview) {
          const now = Date.now();
          if (now - lastPreviewFrameAt < 1_000) return;
          lastPreviewFrameAt = now;
        }
        if (viewer.readyState === WebSocket.OPEN) {
          if (viewer.bufferedAmount < MAX_VIEWER_BUFFERED_BYTES) viewer.send(data, { binary });
          else viewer.close(1013, 'screen backpressure');
        }
      });
      viewer.once('close', () => {
        viewerGone = true;
        channel!.viewers.delete(viewer);
        if (!channel!.viewers.size) scheduleHandBack();
        if (!channel!.viewers.size && channel!.handoffComplete) squireChannels.delete(id);
        upstream.close();
      });
      upstream.once('close', (code, reason) => {
        // A viewer closes its own upstream socket. An upstream close first
        // may be a transient tunnel loss. Reconcile once against Squire.
        if (code === 1000 && reason.toString() === 'share ended') {
          sessionEnded = true;
          if (channel!.pendingHandback) clearTimeout(channel!.pendingHandback);
          squireChannels.delete(id);
          void endComputerSession(database, live, row).finally(() => viewer.close());
          return;
        }
        if (!viewerGone) void fetch(row.upstream_url, { redirect: 'error', signal: AbortSignal.timeout(5_000) })
          .then((reply) => {
            sessionEnded = reply.status === 404 || reply.status === 410;
            if (!sessionEnded) { viewer.close(); return; }
            if (channel!.pendingHandback) clearTimeout(channel!.pendingHandback);
            squireChannels.delete(id);
            const closeViewer = () => {
              if (viewer.readyState === WebSocket.OPEN) viewer.send(JSON.stringify({ type: 'ended' }));
              viewer.close();
            };
            void endComputerSession(database, live, row).then(closeViewer, closeViewer);
          }).catch(() => viewer.close());
        else viewer.close();
      });
      upstream.once('error', () => viewer.close());
    });
  });
  upstream.once('error', () => socket.destroy());
}
