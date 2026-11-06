import type { WebSocket } from "ws";
import type { SqlDatabase } from "./database.js";
import type { LiveHub } from "./live.js";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { VIEWER_LAYOUT_SCRIPT, getComputerSession, mayViewComputer, endComputerSession, ComputerSessionRow, computerWebSockets, recordComputerActivity, noteComputerHandback } from './computer-session.js';





/** Viewer for an agent-owned CDP tab; Squire serves its own canvas viewer through the proxy. */
export function computerViewerHtml(id: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>Browser · Beeline</title><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#1b1320;color:#f6edf4;font-family:system-ui,sans-serif;touch-action:none;overscroll-behavior:none}
  #stage{position:absolute;inset:0;overflow:hidden;background:#1b1320}
  #screen{position:absolute;display:block;max-width:none;object-fit:fill;touch-action:none}
  #ended{display:none;position:absolute;inset:0;place-items:center;font-size:16px}
  #controls{position:absolute;top:env(safe-area-inset-top,12px);right:12px;display:flex;gap:8px}
  button,a{border:1px solid #ffffff44;border-radius:999px;background:#261a2ad9;color:#f6edf4;padding:10px 14px;font:500 13px system-ui,sans-serif;text-decoration:none;cursor:pointer}
  body.embedded #controls{display:none}
  #keys{position:absolute;opacity:0;width:1px;height:1px;left:0;bottom:0}
  </style></head><body><div id="stage"><img id="screen" alt="Live browser"></div><div id="ended">Browser session ended</div><input id="keys" autocomplete="off" autocapitalize="off"><div id="controls"><button id="back" aria-label="Close browser">✕</button></div><script>
  const query=new URLSearchParams(location.search);let preview=query.has('preview')||query.has('warm');
  if(query.has('embedded')) document.body.classList.add('embedded');
  const image=document.getElementById('screen'), stage=document.getElementById('stage'), ended=document.getElementById('ended'), keys=document.getElementById('keys');
  addEventListener('message',event=>{if(event.data?.type!=='viewer-snapshot-request'||event.data.id!=='${id}')return;
    const answer={type:'computer-snapshot',id:'${id}',requestId:event.data.requestId,
      image:image.src.startsWith('data:image/jpeg;base64,')?image.src.slice('data:image/jpeg;base64,'.length):null};
    if(event.source!==window)event.source?.postMessage(answer,event.origin);window.ReactNativeWebView?.postMessage(JSON.stringify(answer));});
  const socketUrl=(location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/s/${id}/ws'+location.search;
  let wire, serial=1, controlling=false, width=1, height=1, leaving=false, endedSession=false, reconnected=false;
  let view={zoom:1,left:0,top:0,fitted:false};
  const pointers=new Map();
  ${VIEWER_LAYOUT_SCRIPT}
  function fit(){if(width<=1||height<=1)return;
    view=viewerLayout(view,stage.clientWidth,stage.clientHeight,width,height);
    image.style.width=Math.ceil(view.width)+'px';image.style.height=Math.ceil(view.height)+'px';
    image.style.left=Math.round(view.left)+'px';image.style.top=Math.round(view.top)+'px';}
  function pans(dx,dy){return view.zoom>1||(Math.abs(dx)>Math.abs(dy)&&view.width>stage.clientWidth);}
  addEventListener('resize',fit);
  addEventListener('message',event=>{if(event.data?.type!=='viewer-mode'||event.data.id!=='${id}'||!query.has('warm'))return;
    preview=!event.data.interactive;if(preview)controlling=false;send({type:'viewer-mode',interactive:!preview});});
  function send(value){if(wire.readyState===WebSocket.OPEN) wire.send(JSON.stringify(value));}
  function cdp(method,params={}){send({id:serial++,method,params});}
  function takeover(){if(!controlling){controlling=true;send({type:'takeover'});}}
  function finish(){if(leaving)return;leaving=true;if(!preview)send({type:'leave'});}
  function showEnded(){endedSession=true;image.style.display='none';ended.textContent='Browser session ended';ended.style.display='grid';
    const notice=JSON.stringify({type:'computer-ended',id:'${id}'});parent.postMessage({type:'computer-ended',id:'${id}'},'*');window.ReactNativeWebView?.postMessage(notice);}
  function showLost(){ended.textContent='Connection lost · reopen to retry';ended.style.display='grid';}
  function connect(){wire=new WebSocket(socketUrl);
    wire.onopen=()=>{if(query.has('warm'))send({type:'viewer-mode',interactive:!preview});if(document.hidden)send({type:'pause-view'});};
    wire.onmessage=event=>{try{const message=JSON.parse(event.data);
      if(message.type==='ended'){showEnded();return;}
      if(message.type==='clipboard'){copied?.(typeof message.text==='string'?message.text:'');copied=undefined;return;}
      if(message.method==='Page.screencastFrame'){const p=message.params;image.src='data:image/jpeg;base64,'+p.data;width=p.metadata?.deviceWidth||width;height=p.metadata?.deviceHeight||height;fit();}
    }catch{}};
    wire.onclose=async()=>{if(leaving||endedSession)return;controlling=false;
      if(reconnected){showLost();return;}reconnected=true;
      try{const response=await fetch('/s/${id}/status'+location.search,{cache:'no-store'});const status=await response.json();
        if(status.status==='ended'){showEnded();return;}
        if(status.status!=='live'){showLost();return;}
        if(!leaving)connect();
      }catch{showLost();}};
  }
  connect();
  let firstFrame=false;
  image.onload=()=>{if(width<=1||height<=1){width=image.naturalWidth;height=image.naturalHeight;}fit();
    if(!firstFrame){firstFrame=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{
      const value={type:'computer-first-frame',id:'${id}',at:Date.now()};
      parent.postMessage(value,'*');window.ReactNativeWebView?.postMessage(JSON.stringify(value));}));}};
  document.addEventListener('visibilitychange',()=>send({type:document.hidden?'pause-view':'resume-view'}));
  function point(event){const r=image.getBoundingClientRect(),scale=r.width/width;return {x:Math.max(0,Math.min(width,(event.clientX-r.left)/scale)),y:Math.max(0,Math.min(height,(event.clientY-r.top)/scale))};}
  let touch,pinch;
  function mid(a,b){return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,d:Math.hypot(a.x-b.x,a.y-b.y)};}
  image.addEventListener('pointerdown',event=>{if(preview)return;takeover();const p=point(event);image.setPointerCapture(event.pointerId);
    if(event.pointerType==='touch'){
      event.preventDefault();pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
      if(pointers.size===1)touch={id:event.pointerId,clientX:event.clientX,clientY:event.clientY,moved:false};
      if(pointers.size===2){const pair=[...pointers.values()],m=mid(pair[0],pair[1]);
        pinch={d:m.d,zoom:view.zoom,left:view.left,top:view.top,x:m.x-stage.getBoundingClientRect().left,y:m.y-stage.getBoundingClientRect().top};
        if(touch)touch.moved=true;}
      return;}
    keys.focus();cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});});
  image.addEventListener('pointermove',event=>{if(!controlling)return;
    if(event.pointerType==='touch'&&pointers.has(event.pointerId)){
      event.preventDefault();pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
      if(pinch&&pointers.size>=2){const pair=[...pointers.values()],m=mid(pair[0],pair[1]),ratio=Math.max(.25,m.d/pinch.d);
        view.zoom=Math.min(4,Math.max(view.minZoom??1,pinch.zoom*ratio));const z=view.zoom/pinch.zoom;
        view.left=m.x-stage.getBoundingClientRect().left-(pinch.x-pinch.left)*z;
        view.top=m.y-stage.getBoundingClientRect().top-(pinch.y-pinch.top)*z;fit();return;}
      if(touch?.id===event.pointerId){const dx=touch.clientX-event.clientX,dy=touch.clientY-event.clientY;
        if(Math.abs(dx)+Math.abs(dy)>3){touch.moved=true;
          if(pans(dx,dy)){view.left-=dx;view.top-=dy;fit();}
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
    // A trackpad pinch arrives as ctrl+wheel. Zoomed in, the wheel pans the page view.
    if(event.ctrlKey){const box=stage.getBoundingClientRect();
      view=viewerZoomAt(view,view.zoom*Math.exp(-event.deltaY/300),event.clientX-box.left,event.clientY-box.top);fit();return;}
    if(pans(event.deltaX,event.deltaY)){view.left-=event.deltaX;view.top-=event.deltaY;fit();return;}
    const p=point(event);cdp('Input.dispatchMouseEvent',{type:'mouseWheel',x:p.x,y:p.y,deltaX:event.deltaX,deltaY:event.deltaY});},{passive:false});
  keys.addEventListener('input',()=>{if(keys.value){takeover();cdp('Input.insertText',{text:keys.value});keys.value='';}});
  // Copy the remote selection to this device. The clipboard write starts
  // inside the key press, which browsers require, and resolves on the answer.
  let copied;
  function copySelection(){if(preview)return;takeover();const text=new Promise(resolve=>{copied=resolve;});
    send({type:'copy'});
    if(window.ReactNativeWebView){text.then(value=>{if(value)window.ReactNativeWebView.postMessage(JSON.stringify({type:'computer-copy',id:'${id}',text:value}));});return;}
    try{navigator.clipboard.write([new ClipboardItem({'text/plain':text.then(value=>{if(!value)throw new Error('nothing selected');return new Blob([value],{type:'text/plain'});})})]).catch(()=>{});}
    catch{text.then(value=>{if(value)return navigator.clipboard?.writeText(value);}).catch(()=>{});}}
  keys.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='c'){event.preventDefault();copySelection();return;}
    if(['Enter','Backspace','Tab','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){takeover();cdp('Input.dispatchKeyEvent',{type:'keyDown',key:event.key,code:event.code});cdp('Input.dispatchKeyEvent',{type:'keyUp',key:event.key,code:event.code});event.preventDefault();}});
  document.getElementById('back').onclick=()=>{finish();window.close();history.back();};
  addEventListener('pagehide',finish);
  </script></body></html>`;
}


export type BodyChannel = { source?: WebSocket; lastFrame?: { data: Buffer; binary: boolean }; viewers: Set<WebSocket>; interactiveViewers: Set<WebSocket>; pausedViewers: Set<WebSocket>; previewSentAt: Map<WebSocket, number>; controller?: WebSocket; ending?: boolean };


export const bodyChannels = new Map<string, BodyChannel>();


export type SquireChannel = { viewers: Set<WebSocket>; interactiveViewers: Set<WebSocket>; upstreams: Set<WebSocket>; humanControl: boolean; humanViewerId?: string; pendingHumanInput?: { viewerId: string; category: string }; html?: string; lastFrame?: { data: Buffer; binary: boolean }; previewSentAt: Map<WebSocket, number> };


export const squireChannels = new Map<string, SquireChannel>();


export function squireChannel(id: string): SquireChannel {
  let channel = squireChannels.get(id);
  if (!channel) {
    channel = { viewers: new Set(), interactiveViewers: new Set(), upstreams: new Set(), humanControl: false, previewSentAt: new Map() };
    squireChannels.set(id, channel);
  }
  return channel;
}



export async function endComputerSessionByViewer(database: SqlDatabase, live: LiveHub | undefined, id: string, viewerId: string): Promise<void> {
  const row = await getComputerSession(database, id);
  if (!row || row.status !== 'live' || !(await mayViewComputer(database, row, viewerId)))
    throw new Error('computer session access denied');
  await endComputerSession(database, live, row);
}



export function bodyChannel(id: string): BodyChannel {
  let channel = bodyChannels.get(id);
  if (!channel) { channel = { viewers: new Set(), interactiveViewers: new Set(), pausedViewers: new Set(), previewSentAt: new Map() }; bodyChannels.set(id, channel); }
  return channel;
}



export function replayToSourceMachine(socket: Duplex, row: ComputerSessionRow): boolean {
  if (!row.relay_instance_id || !process.env.FLY_MACHINE_ID || row.relay_instance_id === process.env.FLY_MACHINE_ID)
    return false;
  socket.write(`HTTP/1.1 307 Temporary Redirect\r\nfly-replay: instance=${row.relay_instance_id}\r\ncontent-length: 0\r\n\r\n`);
  socket.end();
  return true;
}



export function upgradeBodyViewer(request: IncomingMessage, socket: Duplex, head: Buffer, database: SqlDatabase, live: LiveHub, row: ComputerSessionRow): void {
  const query = new URL(request.url ?? '/', 'http://beeline.local').searchParams;
  const fixedPreview = query.has('preview');
  const warm = query.has('warm');
  let preview = fixedPreview || warm;
  const viewerId = query.get('access')!.split('.')[0]!;
  computerWebSockets.handleUpgrade(request, socket, head, (viewer) => {
    const channel = bodyChannel(row.id);
    channel.viewers.add(viewer);
    if (!preview) channel.interactiveViewers.add(viewer);
    if (channel.lastFrame) viewer.send(channel.lastFrame.data, { binary: channel.lastFrame.binary });
    if (!preview) void recordComputerActivity(database, row, 'viewer-opened', undefined, viewerId).catch(() => {});
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
      if (warm && message.type === 'viewer-mode') {
        preview = fixedPreview || !(message as { interactive?: boolean }).interactive;
        if (preview) {
          channel.interactiveViewers.delete(viewer);
          if (channel.controller === viewer) {
            channel.controller = undefined;
            channel.source?.send(JSON.stringify({ type: 'release' }));
          }
        } else {
          channel.interactiveViewers.add(viewer);
          if (channel.lastFrame) viewer.send(channel.lastFrame.data, { binary: channel.lastFrame.binary });
        }
        return;
      }
      if (preview && message.type !== 'pause-view' && message.type !== 'resume-view') return;
      if (message.type === 'pause-view') channel.pausedViewers.add(viewer);
      else if (message.type === 'resume-view') {
        channel.pausedViewers.delete(viewer);
      } else if (message.type === 'takeover' && !channel.controller) {
        channel.controller = viewer;
        channel.source?.send(data);
        void recordComputerActivity(database, row, 'takeover', undefined, viewerId).catch(() => {});
      } else if (message.type === 'release' && channel.controller === viewer) {
        channel.controller = undefined;
        channel.source?.send(data);
        handBack();
      } else if (message.type === 'copy' && channel.controller === viewer) {
        channel.source?.send(JSON.stringify({ type: 'copy' }));
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
          void recordComputerActivity(database, row, 'input', category, viewerId).catch(() => {});
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
      if (!preview) void recordComputerActivity(database, row, 'viewer-closed', undefined, viewerId).catch(() => {});
    });
  });
}
