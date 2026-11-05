import { createServer, AddressInfo, spawn, existsSync, mkdtemp, readFile, rm, join, describe, expect, it, WebSocket, WebSocketServer, findChromiumPage, shareChromiumPage, waitForComputerHandback, computerViewToken, computerViewerHtml, createComputerSession, endComputerSession, getComputerSession, HUMAN, OTHER, AGENT, ROOM, testSquire, opened, next, nextType, until, fixtureScope1 } from './computer-session.test-support.js';

describe('computer session handoff', () => {
const scope1 = fixtureScope1();


  it('delivers a screenshot when Chromium accepts screencast but emits no frames', async () => {
    const debuggerServer = createServer();
    const debuggerSockets = new WebSocketServer({ noServer: true });
    debuggerServer.on('upgrade', (request, socket, head) =>
      debuggerSockets.handleUpgrade(request, socket, head, (client) => debuggerSockets.emit('connection', client, request)));
    debuggerSockets.on('connection', (socket) => socket.on('message', (data) => {
      const command = JSON.parse(data.toString()) as { id: number; method: string };
      if (command.method === 'Page.captureScreenshot')
        socket.send(JSON.stringify({ id: command.id, result: { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') } }));
      else socket.send(JSON.stringify({ id: command.id, result: {} }));
    }));
    await new Promise<void>((resolve) => debuggerServer.listen(0, '127.0.0.1', resolve));
    try {
      const share = await createComputerSession(scope1.database, scope1.live, {
        roomId: ROOM, agentId: AGENT, sessionId: 'silent-cdp', upstreamUrl: 'body:',
      });
      const port = (debuggerServer.address() as AddressInfo).port;
      await shareChromiumPage({ page: { id: 'silent-cdp', type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/` },
        serverBaseUrl: scope1.origin, shareId: share.id, daemonToken: 'test-token', onEnded: async () => {} });
      const access = await computerViewToken(scope1.database, share.id, HUMAN);
      const viewer = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
      const message = next(viewer);
      await opened(viewer);
      expect(JSON.parse(await message)).toMatchObject({ method: 'Page.screencastFrame', params: { data: '/9j/2Q==' } });
      viewer.close();
      for (const client of debuggerSockets.clients) client.close();
      await until(async () => (await getComputerSession(scope1.database, share.id))?.status === 'ended' ? true : undefined);
    } finally {
      for (const client of debuggerSockets.clients) client.close();
      await new Promise<void>((resolve) => debuggerSockets.close(() => resolve()));
      await new Promise<void>((resolve) => debuggerServer.close(() => resolve()));
    }
  });

  it.skipIf(!existsSync(scope1.chromeBinary))('hands an actual agent-owned Chromium tab to a viewer and waits for handback', async () => {
    let profile = '';
    let chrome!: ReturnType<typeof spawn>;
    let spawnFailed = false;
    try {
      let port = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        profile = await mkdtemp(join(process.cwd(), '.computer-e2e-'));
        chrome = spawn(scope1.chromeBinary, [
          '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
          '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
          `--user-data-dir=${profile}`, `${scope1.origin}/page`,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        spawnFailed = false;
        let startupError = '';
        chrome.stderr?.on('data', (data: Buffer) => { startupError = (startupError + data.toString()).slice(-4_000); });
        chrome.on('error', (error) => { startupError = error.message; spawnFailed = true; });
        try {
          port = await until(async () => {
            try {
              const found = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
              return found > 0 ? found : undefined;
            } catch { return undefined; }
          }, 15_000);
          break;
        } catch (error) {
          if (!spawnFailed && chrome.exitCode === null && chrome.signalCode === null) {
            chrome.kill('SIGTERM');
            await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
          }
          await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
          profile = '';
          if (attempt === 3) throw new Error(`Chromium startup failed after 3 attempts: ${startupError || String(error)}`);
        }
      }
      const debugUrl = `http://127.0.0.1:${port}`;
      const page = await until(async () => {
        try { return await findChromiumPage(debugUrl, '/page'); } catch { return undefined; }
      });
      // A browser automation client may already be attached to the shared tab.
      const existingDevtools = new WebSocket(page.webSocketDebuggerUrl!);
      await opened(existingDevtools);
      existingDevtools.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
      const share = await createComputerSession(scope1.database, scope1.live, {
        roomId: ROOM, agentId: AGENT, sessionId: page.id, upstreamUrl: 'body:', title: 'Live Chrome',
      });
      const access = await computerViewToken(scope1.database, share.id, HUMAN);
      await shareChromiumPage({ page, serverBaseUrl: scope1.origin, shareId: share.id,
        daemonToken: 'test-token', onEnded: async () => {} });
      const viewer = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
      // The server can send its cached frame in the same packet as the upgrade.
      // Listen before open so a static page's only frame cannot be missed.
      let receivedScreen: { decoded: { method?: string; params?: { data?: string } }; binary: boolean } | undefined;
      const receiveScreen = (data: WebSocket.RawData, binary: boolean) => {
        const decoded = JSON.parse(data.toString()) as { method?: string; params?: { data?: string } };
        if (decoded.method === 'Page.screencastFrame' && decoded.params?.data)
          receivedScreen = { decoded, binary };
      };
      viewer.on('message', receiveScreen);
      await opened(viewer);
      const screen = await until(async () => receivedScreen);
      viewer.off('message', receiveScreen);
      expect(screen.binary).toBe(false);
      expect(Buffer.from(screen.decoded.params!.data!, 'base64').subarray(0, 3).toString('hex')).toBe('ffd8ff');
      const agentWait = waitForComputerHandback({ serverBaseUrl: scope1.origin, shareId: share.id, daemonToken: 'test-token' });
      viewer.send(JSON.stringify({ type: 'takeover' }));
      viewer.send(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 30, y: 20, button: 'left', clickCount: 1 } }));
      viewer.send(JSON.stringify({ id: 2, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 30, y: 20, button: 'left', clickCount: 1 } }));
      await until(async () => (await findChromiumPage(debugUrl, page.id)).title === 'clicked' ? true : undefined);
      // Copy returns the shared tab's selection to the controlling viewer.
      existingDevtools.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: 'getSelection().selectAllChildren(document.body)' } }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const copied = nextType(viewer, 'clipboard');
      viewer.send(JSON.stringify({ type: 'copy' }));
      expect(await copied).toEqual({ type: 'clipboard', text: 'Click' });
      viewer.send(JSON.stringify({ type: 'handback' }));
      viewer.close();
      const answer = await agentWait;
      expect(answer).toMatchObject({ type: 'handoff' });
      expect(answer.events.map((event) => event.name)).toEqual(expect.arrayContaining(['viewer-opened', 'takeover', 'input', 'handback']));
      expect(answer.events.every((event) => Number.isFinite(Date.parse(event.at)))).toBe(true);
      expect((await getComputerSession(scope1.database, share.id))?.status).toBe('live');
      chrome.kill('SIGTERM');
      await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
      await until(async () => (await getComputerSession(scope1.database, share.id))?.status === 'ended' ? true : undefined);
      const ended = await fetch(`${scope1.origin}/s/${share.id}?access=${access}`);
      expect(ended.status).toBe(410);
      expect((await fetch(`${scope1.origin}/s/${share.id}/last.jpg`)).status).toBe(404);
      existingDevtools.close();
    } finally {
      if (chrome && !spawnFailed && chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill('SIGTERM');
        await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
      }
      if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);


  it('Reproduction SB-CENTER-1 and SB-ZOOM-1: opens centred, zooms from the whole page to 4x and stays centred', () => {
    const { viewerLayout, viewerZoomAt } = scope1.viewerLayoutMath;
    // A 1279x936 Squire page in a 900x700 desktop frame opens filling the
    // frame, with the overflow split evenly instead of pinned to the left.
    const opened = viewerLayout({ zoom: 1, left: 0, top: 0, fitted: false }, 900, 700, 1279, 936);
    expect(opened.height).toBeCloseTo(700);
    expect(opened.left).toBeCloseTo((900 - opened.width) / 2);
    expect(opened.top).toBe(0);
    // Zooming out stops at the whole page in view, centred horizontally and pinned to the top.
    const out = viewerLayout(viewerZoomAt(opened, 0.01, 450, 350), 900, 700, 1279, 936);
    expect(out.zoom).toBeCloseTo(opened.minZoom);
    expect(out.zoom).toBeLessThan(1);
    expect(out.width).toBeCloseTo(900);
    expect(out.height).toBeLessThan(700);
    expect(out.left).toBeCloseTo(0);
    expect(out.top).toBe(0);
    // Zooming in keeps the point under the cursor and stops at 4x.
    const inside = viewerLayout(viewerZoomAt(opened, 2, 300, 200), 900, 700, 1279, 936);
    expect((300 - inside.left) / inside.scale).toBeCloseTo((300 - opened.left) / opened.scale);
    expect(viewerLayout(viewerZoomAt(inside, 50, 300, 200), 900, 700, 1279, 936).zoom).toBe(4);
    // A narrower frame or a phone rotation keeps the page centred.
    const narrower = viewerLayout(opened, 760, 700, 1279, 936);
    expect(narrower.left).toBeCloseTo((760 - narrower.width) / 2);
    const phone = viewerLayout({ zoom: 1, left: 0, top: 0, fitted: false }, 390, 800, 1279, 936);
    expect(phone.left).toBeCloseTo((390 - phone.width) / 2);
    const rotated = viewerLayout(phone, 800, 390, 1279, 936);
    expect(rotated.left).toBeCloseTo((800 - rotated.width) / 2);
    // A new remote size opens centred again.
    const resized = viewerLayout({ ...inside }, 900, 700, 1600, 900);
    expect(resized.left).toBeCloseTo((900 - resized.width) / 2);
  });


  it('returns copied page text only to the controlling body viewer', async () => {
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'body-copy', upstreamUrl: 'body:', title: 'Body copy',
    });
    const source = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/source`);
    await opened(source);
    const toSource: Record<string, unknown>[] = [];
    source.on('message', (data) => toSource.push(JSON.parse(data.toString()) as Record<string, unknown>));
    const controller = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${await computerViewToken(scope1.database, share.id, HUMAN)}`);
    const watcher = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${await computerViewToken(scope1.database, share.id, OTHER)}`);
    await Promise.all([opened(controller), opened(watcher)]);
    const watched: string[] = [];
    watcher.on('message', (data) => watched.push(data.toString()));
    try {
      watcher.send(JSON.stringify({ type: 'copy' }));
      controller.send(JSON.stringify({ type: 'takeover' }));
      controller.send(JSON.stringify({ type: 'copy' }));
      await until(async () => toSource.some((message) => message.type === 'copy') ? true : undefined);
      expect(toSource.filter((message) => message.type === 'copy')).toHaveLength(1);
      const copied = nextType(controller, 'clipboard');
      source.send(JSON.stringify({ type: 'clipboard', text: 'selected words' }));
      expect(await copied).toEqual({ type: 'clipboard', text: 'selected words' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(watched.some((raw) => raw.includes('selected words'))).toBe(false);
    } finally {
      controller.close(); watcher.close(); source.close();
      await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
    }
  });


  it.skipIf(!existsSync(scope1.chromeBinary))('Reproduction SB-PASTE-1 and SB-ZOOM-1: pastes the viewer clipboard and zooms on trackpad pinch in the Squire bridge', async () => {
    // The input handlers below follow Squire's live viewer page: it forwards
    // Ctrl/Cmd+letter as a key, pastes clipboard text and forwards wheels.
    // The page answers late, so the test must wait for the viewer canvas.
    const squire = createServer(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        html,body{margin:0;width:100%;height:100%}body{display:flex;flex-direction:column}#screen{flex:1;min-height:0}</style></head><body>
        <div id="bar"><span id="state"></span><button id="focus"></button></div>
        <div id="screen"><canvas id="canvas" tabindex="0" width="1279" height="936"></canvas></div>
        <input id="keyboard" type="text">
        <script>const canvas=document.getElementById('canvas');const socket = new WebSocket(new URL("stream", location.href));
        function send(message){if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));}
        function sendText(value){send({type:'text',text:value});}
        function point(event){const r=canvas.getBoundingClientRect();return {x:(event.clientX-r.left)/r.width,y:(event.clientY-r.top)/r.height};}
        canvas.addEventListener('pointerdown',event=>{event.preventDefault();canvas.focus();send({type:'pointer',phase:'down',...point(event)});});
        canvas.addEventListener('wheel',event=>{event.preventDefault();send({type:'wheel',delta_x:event.deltaX,delta_y:event.deltaY,...point(event)});},{passive:false});
        canvas.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey||event.altKey)&&/^[a-z]$/i.test(event.key)){
          event.preventDefault();send({type:'key',key:event.key,ctrl:event.ctrlKey,meta:event.metaKey});}});
        document.addEventListener('paste',event=>{if(document.activeElement!==canvas)return;const text=event.clipboardData?.getData('text/plain');
          if(text){event.preventDefault();sendText(text);}});</script></body>`);
    });
    const streams = new WebSocketServer({ noServer: true });
    const forwarded: Record<string, unknown>[] = [];
    squire.on('upgrade', (request, socket, head) => streams.handleUpgrade(request, socket, head, (client) => streams.emit('connection', client, request)));
    streams.on('connection', (socket) => socket.on('message', (data) => forwarded.push(JSON.parse(data.toString()) as Record<string, unknown>)));
    await new Promise<void>((resolve) => squire.listen(0, '127.0.0.1', resolve));
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'squire-paste',
      upstreamUrl: `http://127.0.0.1:${(squire.address() as AddressInfo).port}/s/${'p'.repeat(43)}/`,
    }, testSquire);
    const access = await computerViewToken(scope1.database, share.id, HUMAN);
    const profile = await mkdtemp(join(process.cwd(), '.paste-e2e-'));
    const chrome = spawn(scope1.chromeBinary, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, `${scope1.origin}/s/${share.id}/?access=${access}&embedded=1`,
    ], { stdio: 'ignore' });
    try {
      const port = await until(async () => {
        try {
          const found = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
          return found > 0 ? found : undefined;
        } catch { return undefined; }
      }, 15_000);
      const page = await until(async () => {
        try { return await findChromiumPage(`http://127.0.0.1:${port}`, share.id); } catch { return undefined; }
      });
      const socket = new WebSocket(page.webSocketDebuggerUrl!);
      await opened(socket);
      let serial = 0;
      const pending = new Map<number, (value: { result?: Record<string, unknown>; error?: unknown }) => void>();
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { id?: number; result?: Record<string, unknown>; error?: unknown };
        if (message.id && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
      });
      const command = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = ++serial;
        pending.set(id, (message) => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result ?? {}));
        socket.send(JSON.stringify({ id, method, params }));
      });
      const evaluate = async <T>(expression: string) => {
        const reply = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }) as
          { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
        if (reply.exceptionDetails) throw new Error(`Page script failed: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
        return reply.result?.value as T;
      };
      type Box = { left: number; width: number; height: number; view: number; viewHeight: number };
      // Null until the viewer document has loaded and laid out its canvas.
      const layoutBox = () => evaluate<Box | null>(
        `(() => { const c = document.getElementById('canvas'), s = document.getElementById('screen');
          if (document.readyState !== 'complete' || !c || !s || !c.style.width) return null;
          const r = c.getBoundingClientRect();
          return { left: r.left, width: r.width, height: r.height, view: s.clientWidth, viewHeight: s.clientHeight }; })()`);
      const canvasBox = async () => {
        const box = await layoutBox();
        if (!box) throw new Error('Viewer canvas is not laid out');
        return box;
      };
      const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
        command('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
      await command('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
      await command('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
      // The document can still be navigating, so a failed read is retried
      // and reported only if the canvas never appears.
      let lastError: unknown;
      const start = await until(async () => {
        try { const box = await layoutBox(); return box && box.height === box.viewHeight ? box : undefined; }
        catch (error) { lastError = error; return undefined; }
      }, 30_000).catch((error: Error) => { throw lastError ? new Error(`${error.message}: ${String(lastError)}`) : error; });
      expect(start.left).toBeCloseTo((start.view - start.width) / 2, 0);
      // Trackpad pinch zooms in and back out to the whole page, centred, and
      // never reaches the remote page as a wheel.
      for (let index = 0; index < 4; index++) await mouse('mouseWheel', 450, 350, { deltaX: 0, deltaY: -60, modifiers: 2, button: 'none' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await canvasBox()).width).toBeGreaterThan(start.width);
      for (let index = 0; index < 30; index++) await mouse('mouseWheel', 450, 350, { deltaX: 0, deltaY: 120, modifiers: 2, button: 'none' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const zoomedOut = await canvasBox();
      expect(zoomedOut.width).toBeLessThanOrEqual(zoomedOut.view + 1);
      expect(zoomedOut.height).toBeLessThan(zoomedOut.viewHeight);
      expect(zoomedOut.left).toBeCloseTo((zoomedOut.view - zoomedOut.width) / 2, 0);
      expect(forwarded.filter((message) => message.type === 'wheel')).toHaveLength(0);
      // Ctrl+V pastes this device's clipboard as text, never the remote's.
      await mouse('mousePressed', 450, 300); await mouse('mouseReleased', 450, 300);
      const pasteShortcut = async () => {
        await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2, commands: ['paste'] });
        await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
      };
      // Reproduction SB-PASTE-2: with no text on this device's clipboard
      // (empty, or only an image) the shortcut sends nothing, so the remote
      // page cannot paste the remote machine's clipboard.
      await evaluate(`window.pastes = 0; document.addEventListener('paste', () => window.pastes++, true)`);
      await evaluate(`navigator.clipboard.writeText('')`);
      await pasteShortcut();
      await evaluate(`(async () => { const image = new OffscreenCanvas(2, 2); image.getContext('2d').fillRect(0, 0, 2, 2);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': await image.convertToBlob({ type: 'image/png' }) })]); })()`);
      expect(await evaluate<string>(`navigator.clipboard.read().then((items) => items.flatMap((item) => item.types).join())`)).toBe('image/png');
      await pasteShortcut();
      await until(async () => await evaluate<number>('window.pastes') === 2 ? true : undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(forwarded.filter((message) => message.type === 'key' || message.type === 'text')).toEqual([]);
      expect(await evaluate<string>('document.activeElement.id')).toBe('canvas');
      await evaluate(`navigator.clipboard.writeText('from the viewer clipboard')`);
      await pasteShortcut();
      await until(async () => forwarded.some((message) => message.type === 'text') ? true : undefined);
      expect(forwarded.filter((message) => message.type === 'text')).toEqual([{ type: 'text', text: 'from the viewer clipboard' }]);
      expect(forwarded.some((message) => message.type === 'key' && message.key === 'v')).toBe(false);
      // Focus returns to the page view, so other shortcuts still reach the remote.
      expect(await evaluate<string>('document.activeElement.id')).toBe('canvas');
      // UI-AUDIT-1: only the remote sign-in window owns a keyboard control.
      // The existing structured navigation message selects that mode.
      await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 750, deviceScaleFactor: 1, mobile: true });
      await command('Emulation.setTouchEmulationEnabled', { enabled: true });
      expect(await evaluate<boolean>(`document.getElementById('beeline-paste') === null`)).toBe(true);
      await evaluate(`socket.dispatchEvent(new MessageEvent('message', {data:JSON.stringify({type:'navigation',url:'https://login.example/vnc.html'})}))`);
      expect(await evaluate<string>(`getComputedStyle(document.getElementById('bar')).display`)).toBe('none');
      await evaluate(`socket.dispatchEvent(new MessageEvent('message', {data:JSON.stringify({type:'navigation',url:'https://example.com/'})}))`);
      expect(await evaluate<string>(`getComputedStyle(document.getElementById('bar')).display`)).not.toBe('none');
      socket.close();
    } finally {
      if (chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill('SIGTERM');
        await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      for (const client of streams.clients) client.close();
      await new Promise<void>((resolve) => streams.close(() => resolve()));
      await new Promise<void>((resolve) => squire.close(() => resolve()));
      await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
    }
  }, 120_000);


  it('locks the body viewer document so a native host cannot page-zoom it', () => {
    const html = computerViewerHtml('lock-id');
    expect(html).toContain('maximum-scale=1,user-scalable=no');
    expect(html).toContain('touch-action:none;overscroll-behavior:none');
  });


  it.skipIf(!existsSync(scope1.chromeBinary))('pinches, pans and maps a tap in the body-hosted viewer without forwarding the gesture', async () => {
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'body-pinch', upstreamUrl: 'body:', title: 'Body viewer',
    });
    const access = await computerViewToken(scope1.database, share.id, HUMAN);
    const source = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/source`);
    await opened(source);
    const forwarded: string[] = [];
    source.on('message', (data) => forwarded.push(data.toString()));
    source.send(JSON.stringify({ method: 'Page.screencastFrame',
      params: { data: '/9j/2Q==', sessionId: 1, metadata: { deviceWidth: 800, deviceHeight: 600 } } }));
    const inputCounts: Record<string, number> = {};
    try {
      const gesture = await scope1.gestureViewer(`${scope1.origin}/s/${share.id}?access=${access}&embedded=1`, {
        pinch: [{ x: 150, y: 400 }, { x: 250, y: 400 }],
        remote: { width: 800, height: 600 },
        onPhase: (name) => { inputCounts[name] = forwarded.filter(scope1.isForwardedInput).length; },
      });
      scope1.expectViewerGesture(gesture, forwarded, inputCounts);
    } finally {
      source.close();
      await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
    }
  }, 120_000);


  it.skipIf(!existsSync(scope1.chromeBinary))('pinches, pans and maps a tap in the Squire bridge viewer without forwarding the gesture', async () => {
    const squire = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        html,body{margin:0;width:100%;height:100%}#screen{width:100vw;height:100vh}</style></head><body>
        <div id="bar"><button id="focus"></button></div>
        <div id="screen"><canvas id="canvas" width="800" height="600"></canvas></div>
        <script>const socket = new WebSocket(new URL("stream", location.href));
        function send(message){if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));}
        function point(event){const canvas=document.getElementById('canvas');const r=canvas.getBoundingClientRect();
          const scale=r.width/canvas.width;return {x:(event.clientX-r.left)/scale,y:(event.clientY-r.top)/scale};}</script></body>`);
    });
    const streams = new WebSocketServer({ noServer: true });
    const forwarded: string[] = [];
    squire.on('upgrade', (request, socket, head) => streams.handleUpgrade(request, socket, head, (client) => streams.emit('connection', client, request)));
    streams.on('connection', (socket) => socket.on('message', (data) => forwarded.push(data.toString())));
    await new Promise<void>((resolve) => squire.listen(0, '127.0.0.1', resolve));
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'squire-pinch',
      upstreamUrl: `http://127.0.0.1:${(squire.address() as AddressInfo).port}/s/${'s'.repeat(43)}/`,
    }, testSquire);
    const access = await computerViewToken(scope1.database, share.id, HUMAN);
    const inputCounts: Record<string, number> = {};
    try {
      const gesture = await scope1.gestureViewer(`${scope1.origin}/s/${share.id}/?access=${access}&embedded=1`, {
        pinch: [{ x: 150, y: 250 }, { x: 250, y: 250 }],
        onPhase: (name) => { inputCounts[name] = forwarded.filter(scope1.isForwardedInput).length; },
      });
      scope1.expectViewerGesture(gesture, forwarded, inputCounts);
    } finally {
      for (const client of streams.clients) client.close();
      await new Promise<void>((resolve) => streams.close(() => resolve()));
      await new Promise<void>((resolve) => squire.close(() => resolve()));
      await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
    }
  }, 120_000);
});
