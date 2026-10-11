import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseAgentAccessPolicy, senderMayAddressAgent } from '@beeline/api-contract/agent-access';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
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

export type ComputerActivityEvent = {
  type: 'event';
  seq: number;
  at: string;
  name: 'viewer-opened' | 'viewer-closed' | 'takeover' | 'input' | 'navigation' | 'handback';
  detail?: string;
};

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

async function recordComputerActivity(
  database: SqlDatabase, row: ComputerSessionRow, name: ComputerActivityEvent['name'], detail?: string,
): Promise<void> {
  const result = await database.query<{ id: string; created_at: Date }>(
    `INSERT INTO computer_session_events(session_id,name,detail)
     SELECT id,$2,$3 FROM computer_sessions WHERE id=$1 AND status='live'
     RETURNING id,created_at`, [row.id, name, detail ?? null],
  );
  const saved = result.rows[0];
  if (!saved) return;
  const event: ComputerActivityEvent = {
    type: 'event', seq: Number(saved.id), at: new Date(saved.created_at).toISOString(), name,
    ...(detail ? { detail } : {}),
  };
  for (const waiter of handbackWaiters.get(row.id) ?? []) {
    if (waiter.readyState === WebSocket.OPEN) waiter.send(JSON.stringify(event));
  }
  const words: Record<ComputerActivityEvent['name'], { verb: string; object: string }> = {
    'viewer-opened': { verb: 'opened', object: 'the shared browser' },
    'viewer-closed': { verb: 'closed', object: 'the shared browser view' },
    takeover: { verb: 'took', object: 'control of the shared browser' },
    input: { verb: 'used', object: `the shared browser ${detail ?? 'input'}` },
    navigation: { verb: 'navigated', object: 'the shared browser' },
    handback: { verb: 'returned', object: 'control of the shared browser' },
  };
  const phrase = words[name];
  void systemLine(database, {
    roomId: row.room_id,
    authorId: SYSTEM_IDENTITY_ID,
    subject: { kind: 'system', name: 'A person' },
    verb: phrase.verb,
    object: { text: phrase.object, ...(name === 'navigation' && detail ? { url: detail } : {}) },
    kind: 'computer-session-activity',
    payload: { sessionId: row.id, activity: name, ...(detail ? { detail } : {}) },
    wakes: [row.agent_id],
  }).catch((error: unknown) => console.warn('[computer-share] activity Room event failed', error));
  if (event.seq % 20 === 0) void database.query(
    `DELETE FROM computer_session_events WHERE session_id=$1 AND id <
      (SELECT id FROM computer_session_events WHERE session_id=$1 ORDER BY id DESC OFFSET 199 LIMIT 1)`,
    [row.id],
  ).catch(() => {});
}

export async function noteComputerHandback(database: SqlDatabase, row: ComputerSessionRow): Promise<void> {
  const changed = await database.query(
    `UPDATE computer_sessions SET handoff_count=handoff_count+1
     WHERE id=$1 AND status='live'`, [row.id],
  );
  if (changed.rowCount) {
    await recordComputerActivity(database, row, 'handback');
    notifyWaiters(row.id, { type: 'handoff', note: 'Human handed the browser back' });
  }
}

/** The public origin can move to computer.usebeeline.app after DNS and TLS are ready. */
export function computerSessionUrl(id: string): string {
  const origin = process.env.BEELINE_COMPUTER_ORIGIN || 'https://server.usebeeline.app';
  return `${origin.replace(/\/$/, '')}/s/${id}/`;
}

export async function createComputerSession(
  database: SqlDatabase,
  live: LiveHub,
  input: { roomId: string; agentId: string; sessionId: string; upstreamUrl: string; title?: string; expiresAt?: number },
): Promise<{ id: string; url: string }> {
  const bodySource = input.upstreamUrl === 'body:';
  const upstream = bodySource ? undefined : new URL(input.upstreamUrl);
  if (!bodySource && (!upstream || !['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password))
    throw new Error('computer share URL is invalid');
  if (!input.sessionId.trim() || input.sessionId.length > 240)
    throw new Error('computer session id is invalid');
  if (input.expiresAt !== undefined && !Number.isFinite(input.expiresAt))
    throw new Error('computer share expiry is invalid');
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
      `INSERT INTO computer_sessions(id,room_id,message_id,agent_id,source_session_id,upstream_url,relay_instance_id,view_secret,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9::double precision/1000))`,
      [id, input.roomId, messageId, input.agentId, input.sessionId, upstream?.toString() ?? 'body:', process.env.FLY_MACHINE_ID ?? null, randomBytes(32), input.expiresAt ?? null],
    );
  });
  live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'message', agentId: input.agentId });
  return { id, url };
}

export async function getComputerSession(database: SqlDatabase, id: string): Promise<ComputerSessionRow | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return undefined;
  return (await database.query<ComputerSessionRow>(
    // An expired link reads as ended at once, before the sweep updates the card.
    `SELECT id,room_id,message_id,agent_id,source_session_id,upstream_url,
       CASE WHEN expires_at<=now() THEN 'ended' ELSE status END AS status,
       relay_instance_id,handoff_count,view_secret
     FROM computer_sessions WHERE id=$1`, [id],
  )).rows[0];
}

export async function endComputerSession(
  database: SqlDatabase,
  live: LiveHub | undefined,
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
  if (changed) live?.publish({ type: 'invalidate', roomId: row.room_id, reason: 'message', agentId: row.agent_id });
  if (changed) closeComputerChannels(row.id);
}

function closeComputerChannels(id: string): void {
  notifyWaiters(id, { type: 'ended' });
  const body = bodyChannels.get(id);
  body?.source?.close();
  for (const viewer of body?.viewers ?? []) viewer.close();
  const squire = squireChannels.get(id);
  for (const upstream of squire?.upstreams ?? []) upstream.close();
  for (const viewer of squire?.viewers ?? []) viewer.close();
  bodyChannels.delete(id);
  squireChannels.delete(id);
}

/**
 * Ends every live card whose Squire link has expired. The expiry is stored,
 * so a restarted server ends cards that expired while it was down. Another
 * instance may end the row first; this instance still closes its own sockets.
 */
export async function expireComputerSessions(database: SqlDatabase, live: LiveHub | undefined): Promise<number> {
  const local = [...new Set([...bodyChannels.keys(), ...squireChannels.keys(), ...handbackWaiters.keys()])];
  const rows = (await database.query<ComputerSessionRow>(
    `SELECT id,room_id,message_id,agent_id,source_session_id,upstream_url,status,relay_instance_id,handoff_count,view_secret
     FROM computer_sessions WHERE expires_at<=now() AND (status='live' OR id=ANY($1::text[]))`, [local],
  )).rows;
  for (const row of rows) {
    await endComputerSession(database, live, row);
    if (row.status === 'ended') closeComputerChannels(row.id);
  }
  return rows.length;
}

const COMPUTER_EXPIRY_SWEEP_MS = 15_000;

/** Sweeps once now, then on an interval. The returned function stops it. */
export function startComputerExpirySweep(database: SqlDatabase, live: LiveHub, intervalMs = COMPUTER_EXPIRY_SWEEP_MS): () => void {
  let running = false;
  const sweep = () => {
    if (running) return;
    running = true;
    void expireComputerSessions(database, live)
      .catch((error: unknown) => console.warn('[computer-share] expiry sweep failed', error instanceof Error ? error.message : error))
      .finally(() => { running = false; });
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
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

function serveComputerRetry(request: IncomingMessage, response: ServerResponse): void {
  const retry = Math.min(10, Math.max(0, Number(new URL(request.url ?? '/', 'http://beeline.local').searchParams.get('retry')) || 0));
  const delay = Math.min(2_000, 300 * 2 ** retry);
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'",
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  });
  response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{margin:0;display:grid;place-items:center;height:100vh;background:#1b1320;color:#f6edf4;font:15px system-ui,sans-serif}
    button{border:1px solid #ffffff44;border-radius:12px;background:#261a2a;color:inherit;padding:10px 14px}
    </style><div>${retry < 10 ? 'Connecting to browser…' : '<button id="retry">Try again</button>'}</div><script>
    const next=new URL(location.href);next.searchParams.set('retry','${retry < 10 ? retry + 1 : 0}');
    ${retry < 10 ? `setTimeout(()=>location.replace(next.href),${delay});` : "document.getElementById('retry').onclick=()=>location.replace(next.href);"}
    </script>`);
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
  // HTTP and WebSocket requests must reach the same machine: the warm
  // preview's HTML and JPEG cache live with its source channel.
  if (row.relay_instance_id && process.env.FLY_MACHINE_ID && row.relay_instance_id !== process.env.FLY_MACHINE_ID) {
    response.writeHead(307, { 'fly-replay': `instance=${row.relay_instance_id}`, 'cache-control': 'no-store' }).end();
    return;
  }
  if (row.upstream_url !== 'body:') {
    if (new URL(request.url ?? '/', 'http://beeline.local').pathname === `/s/${id}`) {
      response.writeHead(308, { location: `/s/${id}/`, 'cache-control': 'no-store' }).end();
      return;
    }
    const fetchStartedAt = Date.now();
    const channel = squireChannel(id);
    const htmlWasCached = Boolean(channel.html);
    const upstream = channel.html ? undefined : await fetch(row.upstream_url, { redirect: 'error', signal: AbortSignal.timeout(4_000) })
      .catch(() => undefined);
    if (!upstream && !channel.html) { console.warn(`[computer-share] Squire HTML unavailable session=${id.slice(0, 8)}`); serveComputerRetry(request, response); return; }
    if (upstream && !upstream.ok) {
      console.warn(`[computer-share] Squire HTML status=${upstream.status} session=${id.slice(0, 8)}`);
      if (upstream.status === 410 || upstream.status === 404) response.writeHead(410, { 'cache-control': 'no-store' }).end();
      else serveComputerRetry(request, response);
      return;
    }
    const html = channel.html ?? await upstream!.text().catch(() => undefined);
    if (!html) { squireChannels.delete(id); serveComputerRetry(request, response); return; }
    channel.html = html;
    // The Squire page uses a relative "stream" URL. This small host bridge
    // reconciles one close with our session row and notifies the artifact view.
    const coverStyle = `<style>
      html,body{background:#1b1320!important}
      #screen{display:block!important;position:relative!important;overflow:hidden!important;align-items:unset!important;justify-content:unset!important;touch-action:none!important}
      canvas{display:block!important;position:absolute!important;max-width:none!important;max-height:none!important;object-fit:fill!important;touch-action:none!important}
      #bar{position:fixed!important;z-index:2;right:12px;bottom:max(12px,env(safe-area-inset-bottom))!important;padding:0!important;background:transparent!important}
      #beeline-handback{position:fixed;z-index:2;right:12px;bottom:72px;border:1px solid #ffffff44;border-radius:14px;padding:10px 14px;background:#261a2ae8;color:#f6edf4;font:500 13px system-ui,sans-serif}
      #beeline-end{position:fixed;z-index:2;right:12px;bottom:122px;border:1px solid #ffffff44;border-radius:14px;padding:10px 14px;background:#261a2ae8;color:#f6edf4;font:500 13px system-ui,sans-serif}
      #state{display:none!important}
      #focus{width:42px;height:42px;margin:0!important;padding:0;border:1px solid #ffffff44;border-radius:14px;background:#261a2ae8;color:#f6edf4;font-size:0}
      #focus::before{content:'⌨';font-size:20px}
      @media(pointer:fine){#bar{display:none!important}}
    </style>`;
    const bridge = `<script>
      const beelineScreen=document.getElementById('screen'),beelineCanvas=document.getElementById('canvas');
      const beelineQuery=new URLSearchParams(location.search),beelinePreview=beelineQuery.has('preview');
      if(beelinePreview)document.getElementById('bar').style.display='none';
      let beelineZoom=1,beelineLeft=0,beelineTop=0;
      addEventListener('message',event=>{if(event.data?.type!=='viewer-snapshot-request'||event.data.id!=='${id}')return;
        let image=null;try{if(beelineCanvas.width>1&&beelineCanvas.height>1)
          image=beelineCanvas.toDataURL('image/jpeg',0.72).split(',')[1]||null;}catch{}
        const answer={type:'computer-snapshot',id:'${id}',requestId:event.data.requestId,image};
        if(event.source!==window)event.source?.postMessage(answer,event.origin);window.ReactNativeWebView?.postMessage(JSON.stringify(answer));});
      function beelineFit(){if(!beelineCanvas.width||!beelineCanvas.height)return;
        const scale=(beelinePreview?Math.max:Math.min)(beelineScreen.clientWidth/beelineCanvas.width,beelineScreen.clientHeight/beelineCanvas.height)*beelineZoom;
        const w=beelineCanvas.width*scale,h=beelineCanvas.height*scale;
        if(beelineZoom===1){beelineLeft=(beelineScreen.clientWidth-w)/2;beelineTop=(beelineScreen.clientHeight-h)/2;}
        else{beelineLeft=Math.min(0,Math.max(beelineScreen.clientWidth-w,beelineLeft));beelineTop=Math.min(0,Math.max(beelineScreen.clientHeight-h,beelineTop));}
        beelineCanvas.style.width=Math.ceil(w)+'px';beelineCanvas.style.height=Math.ceil(h)+'px';
        beelineCanvas.style.left=Math.round(beelineLeft)+'px';beelineCanvas.style.top=Math.round(beelineTop)+'px';}
      new MutationObserver(beelineFit).observe(beelineCanvas,{attributes:true,attributeFilter:['width','height']});
      addEventListener('resize',beelineFit);beelineFit();
      if(!beelinePreview&&!beelineQuery.has('embedded')){const button=document.createElement('button');
        button.id='beeline-handback';button.textContent='Hand back';button.onclick=()=>send({type:'handback'});document.body.append(button);
        const end=document.createElement('button');end.id='beeline-end';end.textContent='End share';
        end.onclick=()=>send({type:'end-share'});document.body.append(end);}
      if(matchMedia('(pointer:coarse)').matches){let drag,pinch;const pointers=new Map();
        beelineCanvas.addEventListener('pointerdown',event=>{if(event.pointerType!=='touch')return;
          event.preventDefault();event.stopImmediatePropagation();beelineCanvas.setPointerCapture(event.pointerId);
          pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
          if(pointers.size===1)drag={id:event.pointerId,x:event.clientX,y:event.clientY,moved:false};
          if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),zoom:beelineZoom,
            left:beelineLeft,top:beelineTop,x:(a.x+b.x)/2-beelineScreen.getBoundingClientRect().left,
            y:(a.y+b.y)/2-beelineScreen.getBoundingClientRect().top};if(drag)drag.moved=true;}
          beelineCanvas.focus();},true);
        beelineCanvas.addEventListener('pointermove',event=>{if(event.pointerType!=='touch'||!pointers.has(event.pointerId))return;
          event.preventDefault();event.stopImmediatePropagation();pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
          if(pinch&&pointers.size>=2){const [a,b]=[...pointers.values()],distance=Math.hypot(a.x-b.x,a.y-b.y),ratio=Math.max(.25,distance/pinch.distance);
            beelineZoom=Math.min(4,Math.max(1,pinch.zoom*ratio));const z=beelineZoom/pinch.zoom;
            beelineLeft=(a.x+b.x)/2-beelineScreen.getBoundingClientRect().left-(pinch.x-pinch.left)*z;
            beelineTop=(a.y+b.y)/2-beelineScreen.getBoundingClientRect().top-(pinch.y-pinch.top)*z;beelineFit();return;}
          if(drag?.id!==event.pointerId)return;const dx=drag.x-event.clientX,dy=drag.y-event.clientY;
          if(Math.abs(dx)+Math.abs(dy)>3){drag.moved=true;
            if(beelineZoom>1){beelineLeft-=dx;beelineTop-=dy;beelineFit();}
            else send({type:'wheel',delta_x:dx,delta_y:dy,...point(event)});}
          drag.x=event.clientX;drag.y=event.clientY;},true);
        beelineCanvas.addEventListener('pointerup',event=>{if(event.pointerType!=='touch')return;
          event.preventDefault();event.stopImmediatePropagation();const wasPinch=Boolean(pinch);pointers.delete(event.pointerId);
          if(pointers.size<2)pinch=undefined;
          if(drag?.id===event.pointerId&&!drag.moved&&!wasPinch){const p=point(event);send({type:'touch',phase:'start',...p});send({type:'touch',phase:'end',...p});}
          drag=undefined;if(pointers.size===1){const [id,p]=[...pointers.entries()][0];drag={id,x:p.x,y:p.y,moved:true};}},true);
        beelineCanvas.addEventListener('pointercancel',event=>{if(event.pointerType==='touch'){pointers.delete(event.pointerId);drag=undefined;pinch=undefined;}},true);
      }
      // Signal a decoded canvas paint, not merely the receipt of JPEG bytes.
      let beelineFirstFrame=false;
      const beelineContext=beelineCanvas?.getContext('2d');
      if(beelineContext){const draw=beelineContext.drawImage.bind(beelineContext);
        beelineContext.drawImage=(...args)=>{draw(...args);if(beelineFirstFrame)return;beelineFirstFrame=true;
          requestAnimationFrame(()=>{const value={type:'computer-first-frame',id:'${id}',at:Date.now()};
            parent.postMessage(value,'*');window.ReactNativeWebView?.postMessage(JSON.stringify(value));});};}
      ${channel.lastFrame ? `if(!beelinePreview)socket.dispatchEvent(new MessageEvent('message',{data:atob('${channel.lastFrame.data.toString('base64')}')}));` : ''}
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
    if (securedHtml === html) { serveComputerRetry(request, response); return; }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'server-timing': `squire-html;dur=${Date.now() - fetchStartedAt};desc="${htmlWasCached ? 'cached' : 'fetched'}"`,
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
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser · Beeline</title><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#1b1320;color:#f6edf4;font-family:system-ui,sans-serif}
  #stage{position:absolute;inset:0;overflow:hidden;background:#1b1320}
  #screen{position:absolute;display:block;max-width:none;object-fit:fill;touch-action:none}
  #ended{display:none;position:absolute;inset:0;place-items:center;font-size:16px}
  #controls{position:absolute;top:env(safe-area-inset-top,12px);right:12px;display:flex;gap:8px}
  button,a{border:1px solid #ffffff44;border-radius:999px;background:#261a2ad9;color:#f6edf4;padding:10px 14px;font:500 13px system-ui,sans-serif;text-decoration:none;cursor:pointer}
  body.embedded #controls{display:none}
  #keys{position:absolute;opacity:0;width:1px;height:1px;left:0;bottom:0}
  </style></head><body><div id="stage"><img id="screen" alt="Live browser"></div><div id="ended">Browser session ended</div><input id="keys" autocomplete="off" autocapitalize="off"><div id="controls"><button id="handback" aria-label="Hand browser back to agent">Hand back</button><button id="end" aria-label="End browser share">End share</button><button id="back" aria-label="Close browser">✕</button></div><script>
  const query=new URLSearchParams(location.search), preview=query.has('preview');
  if(query.has('embedded')) document.body.classList.add('embedded');
  const image=document.getElementById('screen'), stage=document.getElementById('stage'), ended=document.getElementById('ended'), keys=document.getElementById('keys');
  addEventListener('message',event=>{if(event.data?.type!=='viewer-snapshot-request'||event.data.id!=='${id}')return;
    const answer={type:'computer-snapshot',id:'${id}',requestId:event.data.requestId,
      image:image.src.startsWith('data:image/jpeg;base64,')?image.src.slice('data:image/jpeg;base64,'.length):null};
    if(event.source!==window)event.source?.postMessage(answer,event.origin);window.ReactNativeWebView?.postMessage(JSON.stringify(answer));});
  const socketUrl=(location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/s/${id}/ws'+location.search;
  let wire, serial=1, controlling=false, width=1, height=1, leaving=false, endedSession=false, reconnected=false;
  let zoom=1,offsetX=0,offsetY=0;
  const pointers=new Map();
  function fit(){if(width<=1||height<=1)return;
    const base=(preview?Math.max:Math.min)(stage.clientWidth/width,stage.clientHeight/height);
    const w=width*base*zoom,h=height*base*zoom;
    if(zoom===1){offsetX=(stage.clientWidth-w)/2;offsetY=(stage.clientHeight-h)/2;}
    else{offsetX=Math.min(0,Math.max(stage.clientWidth-w,offsetX));offsetY=Math.min(0,Math.max(stage.clientHeight-h,offsetY));}
    image.style.width=Math.ceil(w)+'px';image.style.height=Math.ceil(h)+'px';
    image.style.left=Math.round(offsetX)+'px';image.style.top=Math.round(offsetY)+'px';}
  addEventListener('resize',fit);
  function send(value){if(wire.readyState===WebSocket.OPEN) wire.send(JSON.stringify(value));}
  function cdp(method,params={}){send({id:serial++,method,params});}
  function takeover(){if(!controlling){controlling=true;send({type:'takeover'});}}
  function finish(){if(leaving)return;leaving=true;if(!preview)send({type:'leave'});}
  function showEnded(){endedSession=true;image.style.display='none';ended.textContent='Browser session ended';ended.style.display='grid';
    const notice=JSON.stringify({type:'computer-ended',id:'${id}'});parent.postMessage({type:'computer-ended',id:'${id}'},'*');window.ReactNativeWebView?.postMessage(notice);}
  function showLost(){ended.textContent='Connection lost · reopen to retry';ended.style.display='grid';}
  function connect(){wire=new WebSocket(socketUrl);
    wire.onopen=()=>{if(document.hidden)send({type:'pause-view'});};
    wire.onmessage=event=>{try{const message=JSON.parse(event.data);
      if(message.type==='ended'){showEnded();return;}
      if(message.method==='Page.screencastFrame'){const p=message.params;image.src='data:image/jpeg;base64,'+p.data;width=p.metadata?.deviceWidth||width;height=p.metadata?.deviceHeight||height;fit();}
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
  let firstFrame=false;
  image.onload=()=>{if(width<=1||height<=1){width=image.naturalWidth;height=image.naturalHeight;}fit();
    if(!firstFrame){firstFrame=true;const value={type:'computer-first-frame',id:'${id}',at:Date.now()};
      parent.postMessage(value,'*');window.ReactNativeWebView?.postMessage(JSON.stringify(value));}};
  document.addEventListener('visibilitychange',()=>send({type:document.hidden?'pause-view':'resume-view'}));
  function point(event){const r=image.getBoundingClientRect(),scale=r.width/width;return {x:Math.max(0,Math.min(width,(event.clientX-r.left)/scale)),y:Math.max(0,Math.min(height,(event.clientY-r.top)/scale))};}
  let touch,pinch;
  function mid(a,b){return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,d:Math.hypot(a.x-b.x,a.y-b.y)};}
  image.addEventListener('pointerdown',event=>{if(preview)return;takeover();const p=point(event);image.setPointerCapture(event.pointerId);
    if(event.pointerType==='touch'){
      event.preventDefault();pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
      if(pointers.size===1)touch={id:event.pointerId,clientX:event.clientX,clientY:event.clientY,moved:false};
      if(pointers.size===2){const pair=[...pointers.values()],m=mid(pair[0],pair[1]);
        pinch={d:m.d,zoom,offsetX,offsetY,x:m.x-stage.getBoundingClientRect().left,y:m.y-stage.getBoundingClientRect().top};
        if(touch)touch.moved=true;}
      return;}
    keys.focus();cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});});
  image.addEventListener('pointermove',event=>{if(!controlling)return;
    if(event.pointerType==='touch'&&pointers.has(event.pointerId)){
      event.preventDefault();pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
      if(pinch&&pointers.size>=2){const pair=[...pointers.values()],m=mid(pair[0],pair[1]),ratio=Math.max(.25,m.d/pinch.d);
        zoom=Math.min(4,Math.max(1,pinch.zoom*ratio));const z=zoom/pinch.zoom;
        offsetX=m.x-stage.getBoundingClientRect().left-(pinch.x-pinch.offsetX)*z;
        offsetY=m.y-stage.getBoundingClientRect().top-(pinch.y-pinch.offsetY)*z;fit();return;}
      if(touch?.id===event.pointerId){const dx=touch.clientX-event.clientX,dy=touch.clientY-event.clientY;
        if(Math.abs(dx)+Math.abs(dy)>3){touch.moved=true;
          if(zoom>1){offsetX-=dx;offsetY-=dy;fit();}
          else{const p=point(event);cdp('Input.dispatchMouseEvent',{type:'mouseWheel',x:p.x,y:p.y,deltaX:dx,deltaY:dy});}}
        touch.clientX=event.clientX;touch.clientY=event.clientY;return;}}
    if(!event.buttons)return;const p=point(event);
    cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y,button:'left',buttons:1});});
  image.addEventListener('pointerup',event=>{if(!controlling)return;const p=point(event);
    if(event.pointerType==='touch'){
      const wasPinch=Boolean(pinch);pointers.delete(event.pointerId);
      if(pointers.size<2)pinch=undefined;
      if(touch?.id===event.pointerId&&!touch.moved&&!wasPinch){cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});keys.focus();}
      touch=undefined;
      if(pointers.size===1){const [id,remaining]=[...pointers.entries()][0];touch={id,clientX:remaining.x,clientY:remaining.y,moved:true};}
      return;}
    cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});});
  image.addEventListener('pointercancel',event=>{pointers.delete(event.pointerId);touch=undefined;pinch=undefined;});
  image.addEventListener('wheel',event=>{if(preview)return;event.preventDefault();takeover();
    if(event.ctrlKey){zoom=Math.min(4,Math.max(1,zoom*Math.exp(-event.deltaY/300)));fit();return;}
    const p=point(event);cdp('Input.dispatchMouseEvent',{type:'mouseWheel',x:p.x,y:p.y,deltaX:event.deltaX,deltaY:event.deltaY});},{passive:false});
  keys.addEventListener('input',()=>{if(keys.value){takeover();cdp('Input.insertText',{text:keys.value});keys.value='';}});
  keys.addEventListener('keydown',event=>{if(['Enter','Backspace','Tab','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){takeover();cdp('Input.dispatchKeyEvent',{type:'keyDown',key:event.key,code:event.code});cdp('Input.dispatchKeyEvent',{type:'keyUp',key:event.key,code:event.code});event.preventDefault();}});
  document.getElementById('handback').onclick=()=>{send({type:'handback'});controlling=false;};
  document.getElementById('end').onclick=()=>send({type:'end-share'});
  document.getElementById('back').onclick=()=>{finish();window.close();history.back();};
  addEventListener('pagehide',finish);
  </script></body></html>`;
}

const computerWebSockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
type BodyChannel = { source?: WebSocket; lastFrame?: { data: Buffer; binary: boolean }; viewers: Set<WebSocket>; interactiveViewers: Set<WebSocket>; pausedViewers: Set<WebSocket>; previewSentAt: Map<WebSocket, number>; controller?: WebSocket; ending?: boolean };
const bodyChannels = new Map<string, BodyChannel>();
type SquireChannel = { viewers: Set<WebSocket>; interactiveViewers: Set<WebSocket>; upstreams: Set<WebSocket>; humanControl: boolean; html?: string; lastFrame?: { data: Buffer; binary: boolean }; previewSentAt: Map<WebSocket, number> };
const squireChannels = new Map<string, SquireChannel>();
function squireChannel(id: string): SquireChannel {
  let channel = squireChannels.get(id);
  if (!channel) {
    channel = { viewers: new Set(), interactiveViewers: new Set(), upstreams: new Set(), humanControl: false, previewSentAt: new Map() };
    squireChannels.set(id, channel);
  }
  return channel;
}

/** Only an authenticated person's explicit action completes a share. */
export async function handBackComputerSession(database: SqlDatabase, id: string, viewerId: string): Promise<void> {
  const row = await getComputerSession(database, id);
  if (!row || row.status !== 'live' || !(await mayViewComputer(database, row, viewerId)))
    throw new Error('computer session access denied');
  const body = bodyChannels.get(id);
  if (body) {
    if (body.controller) {
      body.source?.send(JSON.stringify({ type: 'release' }));
      body.controller = undefined;
    }
  }
  const squire = squireChannels.get(id);
  if (squire) {
    for (const upstream of squire.upstreams) {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: 'release' }));
    }
  }
  await noteComputerHandback(database, row);
}

export async function endComputerSessionByViewer(database: SqlDatabase, live: LiveHub | undefined, id: string, viewerId: string): Promise<void> {
  const row = await getComputerSession(database, id);
  if (!row || row.status !== 'live' || !(await mayViewComputer(database, row, viewerId)))
    throw new Error('computer session access denied');
  await endComputerSession(database, live, row);
}

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
    void Promise.all([
      getComputerSession(database, id),
      database.query<{ id: string; name: ComputerActivityEvent['name']; detail: string | null; created_at: Date }>(
        `SELECT id,name,detail,created_at FROM computer_session_events
         WHERE session_id=$1 AND id>$2 ORDER BY id ASC LIMIT 200`, [id, since],
      ),
    ]).then(([current, events]) => {
      if (waiter.readyState !== WebSocket.OPEN) return;
      for (const event of events.rows) {
        waiter.send(JSON.stringify({ type: 'event', seq: Number(event.id), at: new Date(event.created_at).toISOString(),
          name: event.name, ...(event.detail ? { detail: event.detail } : {}) } satisfies ComputerActivityEvent));
      }
      if (!current || current.status === 'ended') {
        waiter.send(JSON.stringify({ type: 'ended' })); waiter.close();
      } else if (current.handoff_count > 0) {
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
    channel.lastFrame = undefined;
    source.on('message', (data, binary) => {
      try {
        const event = JSON.parse(data.toString()) as { type?: string; name?: string; detail?: string };
        if (event.type === 'share-event' && event.name === 'navigation') {
          void recordComputerActivity(database, row, 'navigation', event.detail?.slice(0, 200)).catch(() => {});
          return;
        }
      } catch { /* An unrelated source frame is still forwarded below. */ }
      const frame = isFrameMessage(data);
      // A quiet Chromium tab may emit its only frame before anyone opens the card.
      if (frame) channel.lastFrame = { data: Buffer.from(data.toString()), binary };
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

function upgradeBodyViewer(request: IncomingMessage, socket: Duplex, head: Buffer, database: SqlDatabase, live: LiveHub, row: ComputerSessionRow): void {
  const preview = new URL(request.url ?? '/', 'http://beeline.local').searchParams.has('preview');
  computerWebSockets.handleUpgrade(request, socket, head, (viewer) => {
    const channel = bodyChannel(row.id);
    channel.viewers.add(viewer);
    if (!preview) channel.interactiveViewers.add(viewer);
    if (channel.lastFrame) viewer.send(channel.lastFrame.data, { binary: channel.lastFrame.binary });
    if (!preview) void recordComputerActivity(database, row, 'viewer-opened').catch(() => {});
    const lastInputAt = new Map<string, number>();
    const handBack = () => {
      if (preview || channel.ending) return;
      if (channel.controller) {
        channel.source?.send(JSON.stringify({ type: 'release' }));
        channel.controller = undefined;
      }
      void noteComputerHandback(database, row);
    };
    viewer.on('message', (data) => {
      let message: { type?: string; method?: string; params?: { type?: string } };
      try { message = JSON.parse(data.toString()) as typeof message; } catch { return; }
      if (message.type === 'pause-view') channel.pausedViewers.add(viewer);
      else if (message.type === 'resume-view') {
        channel.pausedViewers.delete(viewer);
      } else if (message.type === 'takeover' && !channel.controller) {
        channel.controller = viewer;
        channel.source?.send(data);
        void recordComputerActivity(database, row, 'takeover').catch(() => {});
      } else if (message.type === 'release' && channel.controller === viewer) {
        channel.controller = undefined;
        channel.source?.send(data);
        handBack();
      } else if (message.type === 'handback') {
        handBack();
      } else if (message.type === 'end-share' && !preview) {
        void endComputerSession(database, live, row);
      } else if (message.type === 'leave') {
        if (channel.controller === viewer) {
          channel.controller = undefined;
          channel.source?.send(JSON.stringify({ type: 'release' }));
        }
      } else if (message.method?.startsWith('Input.') && channel.controller === viewer) {
        channel.source?.send(data);
        const category = message.method === 'Input.insertText' ? 'typing'
          : message.params?.type === 'mouseWheel' ? 'scroll'
          : message.method === 'Input.dispatchKeyEvent' ? 'key' : 'pointer';
        const now = Date.now();
        if (now - (lastInputAt.get(category) ?? 0) >= 1_000) {
          lastInputAt.set(category, now);
          void recordComputerActivity(database, row, 'input', category).catch(() => {});
        }
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
      }
      if (!preview) void recordComputerActivity(database, row, 'viewer-closed').catch(() => {});
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
    upgradeBodyViewer(request, socket, head, database, live, row); return;
  }
  if (!path.endsWith('/stream')) { socket.destroy(); return; }
  const target = new URL('stream', row.upstream_url);
  if (target.protocol === 'https:') target.protocol = 'wss:';
  if (target.protocol === 'http:') target.protocol = 'ws:';
  if (!['ws:', 'wss:'].includes(target.protocol)) { socket.destroy(); return; }
  const preview = new URL(request.url ?? '/', 'http://beeline.local').searchParams.has('preview');
  computerWebSockets.handleUpgrade(request, socket, head, (viewer) => {
    const channel = squireChannel(id);
    const startedAt = Date.now();
    channel.viewers.add(viewer);
    if (!preview) channel.interactiveViewers.add(viewer);
    if (channel.lastFrame) {
      viewer.send(channel.lastFrame.data, { binary: channel.lastFrame.binary });
      console.info(`[computer-share] squire cached JPEG session=${id.slice(0, 8)} ms=${Date.now() - startedAt}`);
    }
    if (!preview) void recordComputerActivity(database, row, 'viewer-opened').catch(() => {});
    let upstream = [...channel.upstreams][0];
    const newTunnel = !upstream;
    if (!upstream) {
      upstream = new WebSocket(target.toString(), { maxPayload: 2 * 1024 * 1024 });
      channel.upstreams.add(upstream);
    }
    const source = upstream;
    const pendingInput: Array<{ data: Buffer; binary: boolean }> = [];
    const flushPending = () => {
      for (const pending of pendingInput) source.send(pending.data, { binary: pending.binary });
      pendingInput.length = 0;
    };
    if (source.readyState === WebSocket.CONNECTING) source.once('open', flushPending);
    const lastInputAt = new Map<string, number>();
    viewer.on('message', (data, binary) => {
      if (preview || Buffer.byteLength(data.toString()) > 4_096) return;
      let message: { type?: string };
      try { message = JSON.parse(data.toString()) as typeof message; } catch { return; }
      if (message.type === 'handback') {
        channel.humanControl = false;
        pendingInput.length = 0;
        if (source.readyState === WebSocket.OPEN) source.send(JSON.stringify({ type: 'release' }));
        void noteComputerHandback(database, row);
        return;
      }
      if (message.type === 'end-share') { void endComputerSession(database, live, row); return; }
      if (message.type && ['touch', 'pointer', 'wheel', 'text', 'key', 'click'].includes(message.type)) {
        const category = message.type === 'wheel' ? 'scroll'
          : message.type === 'text' ? 'typing' : message.type === 'key' ? 'key' : 'pointer';
        const now = Date.now();
        if (now - (lastInputAt.get(category) ?? 0) >= 1_000) {
          lastInputAt.set(category, now);
          void recordComputerActivity(database, row, 'input', category).catch(() => {});
        }
      }
      if (source.readyState === WebSocket.OPEN) source.send(data, { binary });
      else if (source.readyState === WebSocket.CONNECTING && pendingInput.length < 8)
        pendingInput.push({ data: Buffer.from(data.toString()), binary });
    });
    viewer.once('close', () => {
      source.off('open', flushPending);
      pendingInput.length = 0;
      channel.viewers.delete(viewer);
      channel.interactiveViewers.delete(viewer);
      channel.previewSentAt.delete(viewer);
      if (!preview) void recordComputerActivity(database, row, 'viewer-closed').catch(() => {});
      if (!channel.interactiveViewers.size && channel.humanControl) {
        channel.humanControl = false;
        if (source.readyState === WebSocket.OPEN) source.send(JSON.stringify({ type: 'release' }));
      }
      if (!channel.viewers.size) {
        if (squireChannels.get(id) === channel) squireChannels.delete(id);
        source.close();
      }
    });
    if (!newTunnel) return;
    source.once('open', () => console.info(`[computer-share] squire tunnel open session=${id.slice(0, 8)} ms=${Date.now() - startedAt}`));
    let firstJpegLogged = false;
    source.on('message', (data, binary) => {
      let message: { type?: string; state?: string; url?: string } | undefined;
      try { message = JSON.parse(data.toString()) as typeof message; } catch { /* Forward unknown frames. */ }
      if (message?.type === 'control') {
        if (message.state === 'human' && !channel.humanControl) {
          channel.humanControl = true;
          void recordComputerActivity(database, row, 'takeover').catch(() => {});
        }
        if (message.state === 'agent') channel.humanControl = false;
      }
      if (message?.type === 'navigation') {
        let origin: string | undefined;
        try { if (message.url) origin = new URL(message.url).origin; } catch { /* No page content. */ }
        void recordComputerActivity(database, row, 'navigation', origin).catch(() => {});
      }
      const frame = isFrameMessage(data);
      if (message?.type === 'blank') channel.lastFrame = undefined;
      if (frame) {
        channel.lastFrame = { data: Buffer.from(data.toString()), binary };
        if (!firstJpegLogged) {
          firstJpegLogged = true;
          console.info(`[computer-share] squire first JPEG session=${id.slice(0, 8)} ms=${Date.now() - startedAt}`);
        }
      }
      for (const recipient of channel.viewers) {
        if (frame && !channel.interactiveViewers.has(recipient)) {
          const now = Date.now();
          if (now - (channel.previewSentAt.get(recipient) ?? 0) < 1_000) continue;
          channel.previewSentAt.set(recipient, now);
        }
        if (recipient.readyState !== WebSocket.OPEN) continue;
        if (recipient.bufferedAmount < MAX_VIEWER_BUFFERED_BYTES) recipient.send(data, { binary });
        else recipient.close(1013, 'screen backpressure');
      }
    });
    const closeViewers = () => { for (const recipient of channel.viewers) recipient.close(); };
    source.once('close', (code, reason) => {
      channel.upstreams.delete(source);
      if (squireChannels.get(id) === channel) squireChannels.delete(id);
      if (!channel.viewers.size) return;
      if (code === 1000 && reason.toString() === 'share ended') {
        void endComputerSession(database, live, row).finally(closeViewers);
        return;
      }
      // Tunnel loss is not share expiry. Reconcile the upstream status once.
      void fetch(row.upstream_url, { redirect: 'error', signal: AbortSignal.timeout(5_000) })
        .then(async (reply) => {
          if (reply.status === 404 || reply.status === 410) {
            for (const recipient of channel.viewers) if (recipient.readyState === WebSocket.OPEN)
              recipient.send(JSON.stringify({ type: 'ended' }));
            await endComputerSession(database, live, row);
          }
        }).finally(closeViewers).catch(() => {});
    });
    source.once('error', closeViewers);
  });
}
