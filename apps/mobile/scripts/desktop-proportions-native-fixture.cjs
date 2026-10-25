// Local API fixture and bootstrap for the real Tauri webview. Use an isolated proof identifier.
const http = require('http'),
  fs = require('fs'),
  path = require('path');
let out = process.env.BEELINE_PROOF_WEB_DIR || '/tmp/jellybean-desktop-web',
  scene = 'chat',
  observation = {};
const viewer = {
  pubkey: 'a'.repeat(64),
  kind: 'human',
  name: 'Desktop reviewer',
  handle: 'reviewer',
};
const agent = { pubkey: 'b'.repeat(64), kind: 'agent', name: 'Ruby', handle: 'ruby' };
const ws = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Beeline',
  role: 'owner',
  updatedAt: 1,
};
const room = {
  id: '22222222-2222-4222-8222-222222222222',
  workspaceId: ws.id,
  name: 'Desktop layout',
  archived: false,
  createdAt: 1,
  updatedAt: 1,
};
const corner = { ...room, id: '33333333-3333-4333-8333-333333333333', name: 'Desktop proportions' };
const brief = {
  revision: 1,
  authorHandle: 'ruby',
  spec: '# Desktop layout proportions\n\n## Reading together\nMessages and documents share the available space. The chat stays readable while a file or brief sits beside it.\n\n### Useful space\nA centred reading column keeps each line comfortable.\n\n- Read the brief beside the conversation\n- Close the pane to return to the room list',
  attachments: [],
};
const attachment = {
  id: 'doc',
  kind: 'artifact',
  name: 'desktop-notes.md',
  title: 'Desktop notes',
  mimeType: 'text/markdown',
  size: 420,
  url: 'https://server.usebeeline.app/v1/media/44444444-4444-4444-8444-444444444444',
};
const messages = [
  {
    id: 'c'.repeat(64),
    roomId: room.id,
    author: viewer,
    createdAt: 1,
    text: 'Let’s keep the conversation readable while we open the project brief beside it.',
    tags: [],
  },
  {
    id: 'd'.repeat(64),
    roomId: room.id,
    author: agent,
    createdAt: 2,
    text: 'The reading column gives messages a comfortable measure. Opening a file uses the space beside the conversation, and closing it brings the room list back.',
    tags: [],
    attachments: [attachment],
  },
];
function roomView(isCorner = false) {
  return {
    room: isCorner ? corner : room,
    messages: isCorner ? [] : messages,
    members: [
      { identity: viewer, role: 'owner' },
      { identity: agent, role: 'member' },
    ],
    viewer: { identity: viewer, role: 'owner', permissions: { send: true, manage: true } },
    latestAgentTurns: [],
    pendingAgentCommands: [],
    watchFilters: [],
    ...(isCorner ? { parent: room, cornerBrief: brief } : {}),
  };
}

function answer(p) {
  if (p.includes('/history'))
    return { roomId: room.id, messages: [], hasMore: false, watchFilters: [] };
  if (p.endsWith('/operations/readIdentitySettings'))
    return {
      identity: {
        personId: viewer.pubkey,
        name: viewer.name,
        handle: viewer.handle,
        pushLevel: 'attention',
        providers: [],
      },
      workspaces: { viewer, workspaces: [ws], watchFilters: [] },
    };
  if (p === '/v1/phone/workspaces') return { viewer, workspaces: [ws], watchFilters: [] };
  if (p.endsWith('/chats'))
    return {
      viewer,
      workspace: ws,
      chats: [{ room, cornerCount: 1, latestMessage: messages[1] }],
      watchFilters: [],
    };
  if (p.includes('/corners'))
    return {
      room,
      viewer: { identity: viewer, role: 'owner', permissions: { send: true, manage: true } },
      corners: [
        {
          corner,
          state: 'working',
          mine: true,
          briefRevision: 1,
          lifecycle: { lifecycle: 'open', checks: 'unknown' },
        },
      ],
      watchFilters: [],
    };
  if (p.includes('/phone/rooms/')) return roomView(p.includes(corner.id));
  if (p.endsWith('/' + ws.id))
    return {
      workspace: ws,
      viewer: { identity: viewer, role: 'owner' },
      members: [],
      rooms: [room],
      watchFilters: [],
    };
  return { viewer, identity: viewer, items: [], members: [], runs: [], watchFilters: [] };
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8766');
  const p = url.pathname;
  res.setHeader('access-control-allow-origin', '*');
  if (p === '/proof/scene') {
    if (req.method === 'POST') {
      let b = '';
      for await (const chunk of req) b += chunk;
      scene = b;
      observation = {};
    }
    res.end(scene);
    return;
  }
  if (p === '/proof/observation') {
    if (req.method === 'POST') {
      let b = '';
      for await (const chunk of req) b += chunk;
      observation = JSON.parse(b);
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(observation));
    return;
  }
  if (p.startsWith('/v1/')) {
    res.setHeader('content-type', p.includes('/media/') ? 'text/markdown' : 'application/json');
    res.end(p.includes('/media/') ? brief.spec : JSON.stringify(answer(p)));
    return;
  }
  let file = path.join(out, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(out, 'index.html');
  const types = {
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
  };
  res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
  if (path.extname(file) === '.js') {
    res.end(
      fs
        .readFileSync(file, 'utf8')
        .replaceAll('https://server.usebeeline.app', 'http://localhost:8766'),
    );
    return;
  }
  if (path.extname(file) === '.html') {
    let html = fs.readFileSync(file, 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
    html = html.replace(/<script src="([^"]+)" defer><\/script>/g, '');
    const target =
      scene === 'settings'
        ? 'settings'
        : scene === 'corners'
          ? 'corners/' + room.id
          : 'chat/' + (scene === 'brief' ? corner.id : room.id);
    const boot = `<script>(async()=>{
    const scene=${JSON.stringify(scene)};
    const store={'buzzy.monolith.identity.v1':${JSON.stringify(viewer.pubkey)},'buzzy.monolith.refresh.v1':'fixture-refresh','buzzy.monolith.access.v1':JSON.stringify({token:'fixture',expiresAt:Date.now()+86400000,identityId:${JSON.stringify(viewer.pubkey)}})};
    if(window.__TAURI_INTERNALS__){
      const identifier=await window.__TAURI_INTERNALS__.invoke('plugin:app|identifier');
      if(identifier!=='app.usebeeline.desktop.proof')throw Error('Use the isolated app.usebeeline.desktop.proof identifier');
      for(const [key,value] of Object.entries(store))await window.__TAURI_INTERNALS__.invoke('desktop_secure_set',{key,value});
    }
    Object.entries(store).forEach(([key,value])=>localStorage.setItem(key,value));
    history.replaceState({},'', '/beeline/${target}?communityId=${ws.id}');
    for(const src of ${JSON.stringify(scripts)})await new Promise((resolve,reject)=>{const tag=document.createElement('script');tag.src=src;tag.onload=resolve;tag.onerror=reject;document.body.appendChild(tag);});
    let clicked=false;
    setInterval(async()=>{
      const latest=await fetch('/proof/scene').then(r=>r.text());if(latest!==scene){location.href='/';return;}
      const selector=scene==='file'?'[data-testid="artifact-preview-desktop-notes.md"]':scene==='brief'?'[aria-label="Read brief"]':null;
      if(selector&&!clicked){const button=document.querySelector(selector);if(button){button.click();clicked=true;}}
      const pane=document.querySelector('[data-testid="desktop-artifact-pane"]');
      await fetch('/proof/observation',{method:'POST',body:JSON.stringify({scene,text:document.body.innerText,pane:pane?.getBoundingClientRect().toJSON(),url:location.href,storageError:window.__proofStorageError,ipcWritable:Object.getOwnPropertyDescriptor(window.__TAURI_INTERNALS__||{},'invoke')?.writable})});
    },350);
  })().catch(e=>document.body.innerText='PROOF BOOT ERROR '+e.stack);</script>`;
    res.end(html.replace('</body>', boot + '</body>'));
    return;
  }
  fs.createReadStream(file).pipe(res);
});
server.listen(8766, () => console.log('Native fixture ready on localhost:8766'));
