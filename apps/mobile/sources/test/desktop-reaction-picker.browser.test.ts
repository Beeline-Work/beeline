import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { CHROME, webProofShims, withOneBrowser } from './browserProof';

// Render the actual private row wrapper and its styles, as in onboarding-edge.
// The surrounding rows retain RN Web's real stacking contexts and clipping.
async function buildFixture(directory: string) {
  const mobile = process.cwd();
  const source = readFileSync(path.join(mobile, 'sources/app/(app)/beeline/chat/RoomMessageVariants.tsx'), 'utf8');
  const file = ts.createSourceFile('row.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const swipe = file.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'SwipeToReply')!;
  const names = new Set([...swipe.getText(file).matchAll(/styles\.(\w+)/g)].map(m => m[1]));
  let properties: ts.ObjectLiteralElementLike[] = [];
  function visit(n: ts.Node) {
    if (ts.isVariableDeclaration(n) && n.name.getText(file) === 'styles' && n.initializer && ts.isCallExpression(n.initializer)) {
      const arrow = n.initializer.arguments[0];
      if (ts.isArrowFunction(arrow) && ts.isParenthesizedExpression(arrow.body) && ts.isObjectLiteralExpression(arrow.body.expression)) properties = [...arrow.body.expression.properties];
    }
    ts.forEachChild(n, visit);
  }
  visit(file);
  const styles = properties.filter(p => p.name && names.has(p.name.getText(file))).map(p => p.getText(file)).join(',');
  const entry = path.join(directory, 'entry.tsx');
  await writeFile(entry, `
import React,{useCallback,useEffect,useLayoutEffect,useRef,useState}from'react';
import{createRoot}from'react-dom/client';
import{View,Text,Pressable,Platform}from'react-native';
import{StyleSheet}from'react-native-unistyles';
import{DesktopMessageAction}from'@/components/buzz/DesktopMessageAction';
import{ButtonRowFrame}from'@/components/buzz/ButtonRow';
import{DesktopWorkspacePortal}from'@/components/buzz/DesktopWorkspacePortal';
import{MESSAGE_REACTION_EMOJIS}from'@beeline/buzz-client';
import{emojiTextStyle}from'@/buzz/emoji-text';
import{GestureHandlerRootView}from'react-native-gesture-handler';
import ReanimatedSwipeable from'react-native-gesture-handler/ReanimatedSwipeable';
const CORNER_LABEL='corner',ALIVE_RING_PAD=4;const CornerGlyph=()=>null;
const styles=StyleSheet.create(theme=>({${styles}}));
${swipe.getText(file)}
function App(){
 const[reactions,setReactions]=useState({});
 const desktop=innerWidth>=800;
 const row=id=><SwipeToReply key={id} messageId={id} isDesktop={desktop} onReply={()=>{throw Error('Wrong reply target: '+id)}} onLongPress={()=>{}} onActions={()=>{document.getElementById('actions').textContent='phone:'+id}} onReact={emoji=>setReactions(r=>({...r,[id]:emoji}))} onForward={()=>{}}>
 <Text style={{color:'#eee',paddingVertical:12}}>Message {id} {reactions[id]||''}</Text></SwipeToReply>;
 return <GestureHandlerRootView style={{height:'100vh',padding:32,backgroundColor:'#14091a'}}>
 <View testID="transcript" style={{height:160,overflow:'scroll'}}>{['original','next','third'].map(id=><View key={id} style={{marginBottom:8}}>{row(id)}</View>)}</View>
 <View style={{flex:1}}/>{row('bottom')}
 <Text testID="reactions" style={{color:'#eee'}}>{JSON.stringify(reactions)}</Text><Text nativeID="actions"/>
 </GestureHandlerRootView>;
}createRoot(document.getElementById('root')).render(<App/>);`);
  const shims = webProofShims(mobile);
  await build({
    entryPoints: [entry], outfile: path.join(directory, 'bundle.js'), bundle: true,
    platform: 'browser', jsx: 'automatic', mainFields: ['browser', 'module', 'main'],
    nodePaths: [path.join(mobile, 'node_modules'), path.resolve(mobile, '../../node_modules')],
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
    loader: { '.js': 'jsx', '.ttf': 'dataurl', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"', 'process.env.EXPO_OS': '"web"', __DEV__: 'true', global: 'globalThis' },
    plugins: [{ name: 'reaction-proof', setup(api) {
      api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
        if (requested in shims) return { path: requested, namespace: 'shim' };
        if (requested === 'react-native') return { path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') };
        if (requested.startsWith('@/')) {
          const candidate = path.join(mobile, 'sources', requested.slice(2));
          return { path: ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.json', '/index.ts'].map(ext => candidate + ext).find(p => existsSync(p) && statSync(p).isFile())! };
        }
      });
      api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path: requested }) => ({ contents: shims[requested], loader: 'tsx', resolveDir: mobile }));
    } }],
  });
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}</style><div id="root"></div><script src="bundle.js"></script>');
}

it.skipIf(!existsSync(CHROME))('desktop pointer React → every emoji → 👍 click keeps the original target, including viewport edges', () => withOneBrowser(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'reaction-picker-'));
  let socket: WebSocket | undefined;
  let browser: ReturnType<typeof spawn> | undefined;
  try {
    await buildFixture(directory);
    browser = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${path.join(directory, 'profile')}`, 'about:blank'], { stdio: 'ignore' });
    const portFile = path.join(directory, 'profile/DevToolsActivePort');
    const deadline = Date.now() + 20_000;
    while (!existsSync(portFile)) {
      if (browser.exitCode !== null || Date.now() > deadline) throw new Error('Chrome did not start');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()) as { type: string; webSocketDebuggerUrl: string }[];
    socket = new WebSocket(targets.find(t => t.type === 'page')!.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject; });
    let id = 0;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        if (message.error) call.reject(new Error(JSON.stringify(message.error)));
        else call.resolve(message.result);
      }
    };
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
      const callId = ++id;
      pending.set(callId, { resolve, reject });
      socket!.send(JSON.stringify({ id: callId, method, params }));
    });
    const evaluate = async (expression: string) => {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    const settle = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const rect = (testId: string) => evaluate(`document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)}).getBoundingClientRect().toJSON()`);
    const move = (x: number, y: number) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    const click = async (x: number, y: number) => {
      await move(x, y);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x, y });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x, y });
      await settle();
    };
    const open = async (message: string) => {
      const trigger = await rect(`react-button-${message}`);
      await click(trigger.x + trigger.width / 2, trigger.y + trigger.height / 2);
      return { x: trigger.x + trigger.width / 2, y: trigger.y + trigger.height / 2 };
    };
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 840, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: pathToFileURL(path.join(directory, 'index.html')).href });
    while (!await evaluate('!!document.querySelector("[data-testid=copy-message-original]")')) {
      if (Date.now() > deadline) throw new Error('Fixture did not render');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    for (const message of ['original', 'third', 'bottom']) {
      let previous = await open(message);
      const emojis: string[] = await evaluate(`Array.from(document.querySelectorAll('[data-testid="reaction-picker-${message}"] [role=button]')).map(e=>e.textContent)`);
      expect(emojis).toContain('👍');
      for (const emoji of [...emojis, '👍']) {
        const choice = `reaction-choice-${message}-${emoji}`;
        const bounds = await rect(choice);
        const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        for (let step = 1; step <= 8; step++) await move(previous.x + (point.x - previous.x) * step / 8, previous.y + (point.y - previous.y) * step / 8);
        await settle();
        expect(await evaluate(`document.elementFromPoint(${point.x},${point.y})?.closest('[data-testid]')?.dataset.testid`)).toBe(choice);
        const picker = await rect(`reaction-picker-${message}`);
        expect(picker.top).toBeGreaterThanOrEqual(8);
        expect(picker.bottom).toBeLessThanOrEqual(832);
        expect(picker.left).toBeGreaterThanOrEqual(8);
        expect(picker.right).toBeLessThanOrEqual(1272);
        previous = point;
      }
      await click(previous.x, previous.y);
      expect(await evaluate(`JSON.parse(document.querySelector('[data-testid=reactions]').textContent)[${JSON.stringify(message)}]`)).toBe('👍');
      expect(await evaluate(`!!document.querySelector('[data-testid="reaction-picker-${message}"]')`)).toBe(false);
    }
    // Dismissal leaves no detached action surface over a newly scrolled row.
    await open('original');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
    await settle();
    expect(await evaluate('!!document.querySelector("[data-testid=reaction-picker-original]")')).toBe(false);
    await open('original');
    await click(20, 400);
    expect(await evaluate('!!document.querySelector("[data-testid=reaction-picker-original]")')).toBe(false);
    await open('original');
    await evaluate('document.querySelector("[data-testid=transcript]").dispatchEvent(new Event("scroll"))');
    await settle();
    expect(await evaluate('!!document.querySelector("[data-testid=reaction-picker-original]")')).toBe(false);
    // Compact web retains the phone long-press action sheet path, without a desktop picker.
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Page.navigate', { url: pathToFileURL(path.join(directory, 'index.html')).href + '?compact' });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(await evaluate('document.querySelectorAll("[data-testid^=react-button-]").length')).toBe(0);
    const phone = await rect('copy-message-original');
    await move(phone.x + 40, phone.y + 20);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: phone.x + 40, y: phone.y + 20 });
    await new Promise(resolve => setTimeout(resolve, 600));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: phone.x + 40, y: phone.y + 20 });
    expect(await evaluate('document.getElementById("actions").textContent')).toBe('phone:original');
  } finally {
    socket?.close();
    browser?.kill('SIGTERM');
    if (browser && browser.exitCode === null) await new Promise(resolve => browser!.once('exit', resolve));
    // Chrome helpers can finish flushing their profile just after the parent exits.
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}), 120_000);
