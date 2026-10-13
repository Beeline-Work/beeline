/** Build actual mobile voice controls for chrome-devtools-axi. Local fixtures only. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import { webProofShims } from '../apps/mobile/sources/test/browserProof.js';

const mobile = resolve('apps/mobile');
const shims = {
  ...webProofShims(mobile),
  '@/constants/Typography': 'export const Typography = { default: () => ({}) };',
  '@/auth/monolith-session': `export const monolithSession = { fetch: async (url, init) => {
    const session = await (await fetch('/proof-session'+window.location.search)).json();
    return fetch(url, {...init, headers: {...init?.headers, authorization: 'Bearer '+session.token}});
  } };`,
  './runtime-config': 'export const getBuzzRuntimeConfig = () => ({monolithUrl:window.__voiceProof.origin});',
  '@/buzz/speech-input': `export const useSpeechInput = () => ({capability:'available',state:'idle',partialText:'',volumeLevel:0,modelDownloadOffered:false,
    start:async()=>{},stop:async()=>null,cancel(){},acceptModelDownload(){},declineModelDownload:async()=>{}});`,
};
async function main() {
await build({ entryPoints: [join(mobile, 'scripts/voice-call-proof.tsx')], outfile: '.voice-proof/ui.js', bundle: true,
  platform: 'browser', jsx: 'automatic', mainFields: ['browser', 'module', 'main'],
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
  loader: { '.js': 'jsx', '.png': 'dataurl', '.ttf': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'process.env.EXPO_OS': '"web"', __DEV__: 'true', global: 'globalThis' },
  plugins: [{ name: 'voice-proof-web', setup(api) {
    api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
      if (requested in shims) return { path: requested, namespace: 'shim' };
      if (requested === 'react-native') return { path: join(mobile, 'node_modules/react-native-web/dist/index.js') };
      if (requested.startsWith('@/')) {
        const candidate = join(mobile, 'sources', requested.slice(2));
        return { path: ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']
          .map(extension => candidate + extension).find(p => existsSync(p) && statSync(p).isFile())! };
      }
    });
    api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path }) => ({ contents: shims[path as keyof typeof shims], loader: 'tsx', resolveDir: mobile }));
  } }],
});
const server = createServer(async (req, res) => {
  try {
    const fonts = ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular'];
    const font = fonts.find(name => req.url === `/fonts/${name}.ttf`);
    if (font) { res.setHeader('content-type', 'font/ttf'); res.end(await readFile(join(mobile, `sources/assets/fonts/${font}.ttf`))); return; }
    if (req.url === '/ui.js') { res.setHeader('content-type', 'application/javascript'); res.end(await readFile('.voice-proof/ui.js')); return; }
    const session = JSON.parse(await readFile('.voice-proof/local/session.json', 'utf8'));
    const config = { origin: session.origin, roomId: session.roomId,
      token: req.url?.includes('viewer=alex') ? session.firstToken : session.secondToken };
    if (req.url?.startsWith('/proof-session')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(config)); return; }
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>html,body{margin:0;background:#14091A}${fonts.map(name => `@font-face{font-family:'${name}';src:url('/fonts/${name}.ttf')}`).join('')}</style><div id="root"></div>
      <script>window.__voiceProof=${JSON.stringify(config)};</script><script src="/ui.js"></script>`;
    res.setHeader('content-type', 'text/html'); res.end(html);
  } catch { res.writeHead(503); res.end('Start the isolated voice proof first'); }
});
server.listen(18090, '127.0.0.1', () => console.log('Voice UI proof: http://127.0.0.1:18090'));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
