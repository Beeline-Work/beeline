import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(mobile, '../../evidence/computer-session');
mkdirSync(output, { recursive: true });
const shims = {
  'react-native-safe-area-context': 'export const useSafeAreaInsets = () => ({top:0,bottom:0,left:0,right:0});',
  'react-native-unistyles': `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}';
    const theme = { buzz: beelineThemes[new URLSearchParams(location.search).get('theme') === 'light' ? 'bone' : 'obsidian'] };
    export const StyleSheet = { create: factory => typeof factory === 'function' ? factory(theme) : factory };
    export const useUnistyles = () => ({ theme });`,
  '@/utils/open-external-url': 'export const openExternalUrl = async () => undefined;',
  '@/sync/transport/monolith-operation': 'export const monolithPhoneOperation = async () => { if (new URLSearchParams(location.search).get("frame")?.includes("read-only")) throw new Error("access denied"); return {access: "mock-viewer-access"}; };',
  '@/modal': 'export const Modal = {show: () => undefined};',
};
await build({
  entryPoints: [path.join(mobile, 'scripts/computer-session-frame.tsx')],
  outfile: path.join(output, 'bundle.js'), bundle: true, platform: 'browser', jsx: 'automatic',
  mainFields: ['browser', 'module', 'main'],
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
  loader: { '.js': 'jsx', '.png': 'dataurl', '.ttf': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true', global: 'globalThis' },
  plugins: [{ name: 'computer-frame-shims', setup(api) {
    api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
      if (requested in shims) return { path: requested, namespace: 'shim' };
      if (requested === 'react-native')
        return { path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') };
      if (requested.startsWith('@/')) {
        const candidate = path.join(mobile, 'sources', requested.slice(2));
        return { path: ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']
          .map((ext) => candidate + ext).find((file) => existsSync(file) && statSync(file).isFile()) };
      }
    });
    api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path: requested }) => ({
      contents: shims[requested], loader: 'tsx', resolveDir: mobile,
    }));
  } }],
});
writeFileSync(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/bundle.js"></script>');
writeFileSync(path.join(output, 'browser.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;background:#f6f4f1;color:#24212a;font:14px Arial,sans-serif}.bar{height:44px;background:#e9e7e3;border-bottom:1px solid #d5d1cc;padding:12px 14px;display:flex;gap:8px}.dot{width:10px;height:10px;border-radius:50%;background:#b5b0aa}.addr{height:23px;background:#fff;border-radius:5px;margin-top:-6px;flex:1;padding:5px 10px;color:#777;font-size:11px}.nav{height:68px;border-bottom:1px solid #dedad5;display:flex;align-items:center;justify-content:space-between;padding:0 22px;font-weight:700}.brand{font-size:22px;color:#342839}.nav small{font-weight:400}.content{padding:40px 26px;max-width:770px;margin:auto}.eyebrow{color:#a17745;letter-spacing:2px;font-size:10px;font-weight:bold}.title{font-size:31px;line-height:1.1;font-weight:700;margin:11px 0}.sub{line-height:1.5;color:#67616b}.panel{margin-top:32px;background:#fff;border:1px solid #e1dcd5;border-radius:12px;padding:24px;box-shadow:0 8px 24px #241b2110}.label{font-size:11px;font-weight:bold;margin:0 0 7px}.field{border:1px solid #cec8c0;border-radius:6px;padding:14px;color:#847b84;margin-bottom:16px}.button{display:block;background:#30263c;color:white;text-align:center;border:0;border-radius:6px;padding:14px;font-weight:bold;width:100%}.hint{font-size:11px;color:#817b82;margin-top:15px;text-align:center}
</style><div class="bar"><i class="dot"></i><i class="dot"></i><i class="dot"></i><div class="addr">secure.example.com / checkout</div></div><div class="nav"><span class="brand">Monarch</span><small>Order review &nbsp; · &nbsp; Secure checkout</small></div><div class="content"><div class="eyebrow">FINAL STEP</div><div class="title">Confirm your order</div><div class="sub">Review the details, then continue to complete your purchase.</div><div class="panel"><div class="label">ACCOUNT EMAIL</div><div class="field">name@example.com</div><div class="label">PAYMENT</div><div class="field">Add a payment method</div><button class="button" onclick="document.body.dataset.control='true';this.textContent='Payment method selected'">Continue</button><div class="hint">Your details stay in this secure browser session.</div></div></div><script>if(new URLSearchParams(location.search).has('control')){document.querySelector('.button').textContent='Payment method selected';document.querySelector('.field:last-of-type').textContent='•••• 4242';}</script>`);
process.stdout.write(`${output}\n`);
