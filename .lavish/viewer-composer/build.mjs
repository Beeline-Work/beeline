import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '../../apps/mobile');
const mobileRequire = createRequire(path.join(mobile, 'package.json'));
mkdirSync(here, { recursive: true });
const shims = {
  'react-native-safe-area-context': 'export const useSafeAreaInsets = () => ({top:24,bottom:location.pathname.includes("built-frame")?0:24,left:0,right:0});',
  'react-native-unistyles': `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}';
    const theme = { buzz: beelineThemes[new URLSearchParams(location.search).get('theme') === 'bone' ? 'bone' : 'obsidian'] };
    export const StyleSheet = { create: factory => typeof factory === 'function' ? factory(theme) : factory };
    export const useUnistyles = () => ({ theme });`,
  '@/utils/open-external-url': 'export const openExternalUrl = async () => undefined;',
  '@/sync/transport/monolith-operation': 'export const monolithPhoneOperation = async () => ({access: "mock-viewer-access"});',
  '@/modal': 'export const Modal = {show: () => undefined, alert: () => undefined};',
  '@/buzz/artifact-link': 'export const artifactPdfLocalUri = async () => ""; export const fetchArtifactBytes = async () => new Uint8Array(); export const fetchArtifactText = async () => "";',
  '@/components/buzz/artifact-webview': 'export const artifactWebViewProps = () => ({});',
  '@/components/buzz/sandbox-webview': 'export const useSandboxWebView = () => null; export const useSandboxWebViewStatus = () => "ready";',
  '@/components/buzz/ArtifactMedia': 'export const ArtifactText = () => null;',
  '@/components/buzz/ZoomableArtifactImage': 'export const ZoomableArtifactImage = () => null;',
  '@/components/buzz/ChevronGlyph': 'export const CHEVRON_ROW_SIZE = 24; export const ChevronGlyph = () => null;',
  '@/components/buzz/ArtifactPdfView': 'export const ArtifactPdfView = () => null;',
  '@/components/buzz/MonoMarkdown': 'export const MonoMarkdown = () => null;',
  '@/components/buzz/CodeHighlighter': 'export const CodeHighlighter = () => null;',
  '@/buzz/picture-actions': 'export const copyPicture = async () => true; export const sharePicture = async () => undefined;',
  '@/components/buzz/CopiedToast': 'export const useCopiedToast = () => ({showCopied:()=>{},showCopyFailed:()=>{},toast:null});',
  '@/components/buzz/HullDialog': 'export const HullDialog = () => null;',
  '@/components/buzz/AttachmentPickerSheet': 'export const AttachmentPickerSheet = () => null;',
  '@/components/buzz/ViewerConversationDock': 'export const ViewerConversationDock = () => null;',
  '@/components/buzz/BeelineMarkSpinner': 'export const BeelineMarkSpinner = () => null;',
  '@/buzz/speech-input': `import * as React from 'react';
    export function useSpeechInput(onResult) {
      const [state,setState] = React.useState(new URLSearchParams(location.search).get('frame')?.endsWith('voice') ? 'listening' : 'idle');
      const [volumeLevel,setVolumeLevel] = React.useState(0.7);
      React.useEffect(() => { if (state !== 'listening') return;
        const timer = setInterval(() => setVolumeLevel(v => v > 0.75 ? 0.3 : v + 0.25), 180);
        return () => clearInterval(timer); }, [state]);
      return { capability:'available', state, partialText:state === 'listening' ? 'voice message' : '', volumeLevel,
        modelDownloadOffered:false, acceptModelDownload(){}, async declineModelDownload(){},
        async start(){ setState('listening'); }, async stop(){ onResult('What do I do on this screen?'); setState('idle'); return true; },
        cancel(){ setState('idle'); } };
    }`,
  'expo-clipboard': 'export const setStringAsync = async () => true;',
};
async function buildFrame(built) { await build({
  entryPoints: [path.join(here, 'frame.tsx')],
  outfile: path.join(here, built ? 'built-bundle.js' : 'bundle.js'), bundle: true, platform: 'browser', jsx: 'automatic',
  mainFields: ['browser', 'module', 'main'],
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
  loader: { '.js': 'jsx', '.png': 'dataurl', '.ttf': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true', global: 'globalThis' },
  plugins: [{ name: 'viewer-composer-shims', setup(api) {
    api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
      if (requested === './HullDialog') return { path: '@/components/buzz/HullDialog', namespace: 'shim' };
      if (requested === './BeelineMarkSpinner') return { path: '@/components/buzz/BeelineMarkSpinner', namespace: 'shim' };
      if (requested === './AttachmentPickerSheet') return { path: '@/components/buzz/AttachmentPickerSheet', namespace: 'shim' };
      if (!built && requested === './ViewerConversationDock') return { path: '@/components/buzz/ViewerConversationDock', namespace: 'shim' };
      if (requested in shims && !(built && requested === '@/components/buzz/ViewerConversationDock'))
        return { path: requested, namespace: 'shim' };
      if (requested === 'react' || requested.startsWith('react/') || requested === 'react-dom' || requested.startsWith('react-dom/'))
        return { path: mobileRequire.resolve(requested) };
      if (requested === 'react-native')
        return { path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') };
      if (requested.startsWith('@/')) {
        const candidate = path.join(mobile, 'sources', requested.slice(2));
        const resolved = ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']
          .map((ext) => candidate + ext).find((file) => existsSync(file) && statSync(file).isFile());
        if (resolved) return { path: resolved };
      }
    });
    api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path: requested }) => ({
      contents: shims[requested], loader: 'tsx', resolveDir: mobile,
    }));
  } }],
}); }
await buildFrame(false);
await buildFrame(true);
writeFileSync(path.join(here, 'frame.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script>window.process={env:{NODE_ENV:"development"}}</script><script src="/bundle.js"></script>');
writeFileSync(path.join(here, 'built-frame.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script>window.process={env:{NODE_ENV:"development"}}</script><script src="/built-bundle.js"></script>');
writeFileSync(path.join(here, 'browser.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;background:#f6f4f1;color:#24212a;font:14px Arial,sans-serif}.bar{height:44px;background:#e9e7e3;border-bottom:1px solid #d5d1cc;padding:12px 14px;display:flex;gap:8px}.dot{width:10px;height:10px;border-radius:50%;background:#b5b0aa}.addr{height:23px;background:#fff;border-radius:5px;margin-top:-6px;flex:1;padding:5px 10px;color:#777;font-size:11px}.nav{height:68px;border-bottom:1px solid #dedad5;display:flex;align-items:center;justify-content:space-between;padding:0 22px;font-weight:700}.brand{font-size:22px;color:#342839}.nav small{font-weight:400}.content{padding:40px 26px;max-width:770px;margin:auto}.eyebrow{color:#a17745;letter-spacing:2px;font-size:10px;font-weight:bold}.title{font-size:31px;line-height:1.1;font-weight:700;margin:11px 0}.sub{line-height:1.5;color:#67616b}.panel{margin-top:32px;background:#fff;border:1px solid #e1dcd5;border-radius:12px;padding:24px;box-shadow:0 8px 24px #241b2110}.label{font-size:11px;font-weight:bold;margin:0 0 7px}.field{border:1px solid #cec8c0;border-radius:6px;padding:14px;color:#847b84;margin-bottom:16px}.button{display:block;background:#30263c;color:white;text-align:center;border:0;border-radius:6px;padding:14px;font-weight:bold;width:100%}.hint{font-size:11px;color:#817b82;margin-top:15px;text-align:center}.keyboard{position:fixed;right:12px;bottom:12px;width:42px;height:42px;z-index:10;border:1px solid #3b3048;border-radius:14px;background:#14091a;color:#f0f0f3;display:grid;place-items:center;box-shadow:0 2px 12px #0004}
</style><div class="bar"><i class="dot"></i><i class="dot"></i><i class="dot"></i><div class="addr">secure.example.com / checkout</div></div><div class="nav"><span class="brand">Monarch</span><small>Order review &nbsp; · &nbsp; Secure checkout</small></div><div class="content"><div class="eyebrow">FINAL STEP</div><div class="title">Confirm your order</div><div class="sub">Review the details, then continue to complete your purchase.</div><div class="panel"><div class="label">ACCOUNT EMAIL</div><div class="field">name@example.com</div><div class="label">PAYMENT</div><div class="field">Add a payment method</div><button class="button">Continue</button><div class="hint">Your details stay in this secure browser session.</div></div></div><button class="keyboard" aria-label="Show keyboard"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="4" width="17" height="12" rx="2"/><path d="M4 7h1m2 0h1m2 0h1m2 0h1M4 10h1m2 0h1m2 0h1m2 0h1M5.5 13h9" stroke-linecap="round"/></svg></button><script>addEventListener('message',event=>{if(event.data?.type==='viewer-snapshot-request')const answer={type:'computer-snapshot',id:event.data.id,requestId:event.data.requestId,image:'AA=='};parent.postMessage(answer,event.origin);window.ReactNativeWebView?.postMessage(JSON.stringify(answer));});</script>`);
process.stdout.write(`${here}\n`);
