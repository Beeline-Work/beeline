import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { cardButtonShims } from './card-button-proof-shims.ts';
const mobile = path.resolve(import.meta.dirname, '..'),
  root = path.resolve(mobile, '../..');
const out = path.resolve(root, '.beeline-proof/cards');
await mkdir(out, { recursive: true });
const phase = process.argv[2] ?? 'after';
const changed = new Set(
  execFileSync('git', ['diff', '--name-only', '9ea5827af'], { cwd: root, encoding: 'utf8' }).trim().split('\n'),
);
for (const theme of ['bone', 'obsidian']) {
  const shims = cardButtonShims(mobile, theme);
  Object.assign(shims, {
    'expo-router':
      'export const useLocalSearchParams=()=>({});export const router={setParams(){},push(){},replace(){}};export const useRouter=()=>router;export const usePathname=()=>"/";',
    '@/buzz/onboarding-rollout': 'export const useRepositoryOnboarding=()=>true;',
    '@/sync/transport/monolith-operation': 'export const monolithPhoneOperation=async()=>({});',
    '@/auth/monolith-session':
      'export const monolithSession={getState:()=>({}),subscribe:()=>()=>{}}; export const MONOLITH_REQUEST_TIMEOUT_MS=15000; export const monolithResponseTiming={}; export class MonolithRequestTimeoutError extends Error{};',
    '@/modal': 'export const Modal={alert(){},show(){},confirm:async()=>false};',
    '@/modal/ModalManager': 'export const Modal={alert(){},show(){},confirm:async()=>false};',
    '@/buzz/latency-route-hook': 'export const useLatencyRouteFrame=()=>{};',
    'react-native-view-shot': 'export const captureRef=async()=>null;export default {};',
    '@/components/buzz/ViewerConversationDock': 'export const ViewerConversationDock=()=>null;',
    '@/components/buzz/ArtifactViewer': 'export const ArtifactViewerScreen=()=>null;',
    '@/components/buzz/ArtifactPdfView': 'export const ArtifactPdfView=()=>null;',
    '@/components/buzz/MonoMarkdown': 'export const MonoMarkdown=()=>null;',
    '@/components/buzz/ArtifactMedia':
      'export const ArtifactImage=()=>null;export const ArtifactText=()=>null;',
    '@/buzz/artifact-preview-cache':
      'export const artifactPreviewCachePath=()=>"";export const probeArtifactPreview=async()=>null;export const snapshotArtifactPreview=async()=>null;',
    '@/buzz/artifact-link':
      'export const artifactBase64=async()=>"";export const artifactPdfLocalUri=async()=>"";export const fetchArtifactBytes=async()=>new Uint8Array();export const fetchArtifactText=async()=>"";export const openArtifactInBrowserOrExplain=async()=>{};',
  });
  const dir = path.join(out, `${phase}-${theme}`);
  await mkdir(dir, { recursive: true });
  await build({
    entryPoints: [path.join(mobile, 'scripts/card-button-gallery.tsx')],
    outfile: path.join(dir, 'bundle.js'),
    bundle: true,
    platform: 'browser',
    jsx: 'automatic',
    mainFields: ['browser', 'module', 'main'],
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
    loader: { '.js': 'jsx', '.ttf': 'dataurl', '.png': 'dataurl' },
    define: {
      'process.env.NODE_ENV': '"development"',
      'process.env.EXPO_OS': '"web"',
      __DEV__: 'true',
      global: 'globalThis',
    },
    plugins: [
      {
        name: 'proof',
        setup(api) {
          api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
            if (requested in shims) return { path: requested, namespace: 'shim' };
            if (requested === 'react-native')
              return { path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') };
            if (requested.startsWith('@/')) {
              const candidate = path.join(mobile, 'sources', requested.slice(2));
              return {
                path: ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']
                  .map((e) => candidate + e)
                  .find((f) => existsSync(f) && statSync(f).isFile()),
              };
            }
          });
          api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path: requested }) => ({
            contents: shims[requested],
            loader: 'tsx',
            resolveDir: mobile,
          }));
          if (phase === 'before')
            api.onLoad({ filter: /apps\/mobile\/sources\/.*\.[jt]sx?$/ }, async ({ path: file }) =>
              changed.has(path.relative(root, file))
                ? {
                    contents: execFileSync(
                      'git',
                      ['show', `9ea5827af:${path.relative(root, file)}`],
                      { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
                    ),
                    loader: file.endsWith('tsx') ? 'tsx' : 'ts',
                  }
                : undefined,
            );
        },
      },
    ],
  });
  await writeFile(
    path.join(dir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}#result{display:none}</style><div id="root"></div><pre id="result">PENDING</pre><script>window.process={env:{NODE_ENV:'development'}};window.__console=[];window.onerror=(...a)=>window.__console.push(a.map(String).join(' '));</script><script src="bundle.js"></script>`,
  );
  for (const width of [360, 411, 960]) {
    const png = path.join(out, `${phase}-${theme}-${width}.png`);
    const dom = execFileSync(
      '/usr/bin/google-chrome',
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        `--window-size=${Math.max(width, 520)},6500`,
        `--user-data-dir=/tmp/jellybean-card-${phase}-${theme}-${width}`,
        '--dump-dom',
        `--screenshot=${png}`,
        '--virtual-time-budget=5000',
        `file://${dir}/index.html?width=${width}`,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const result = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1];
    await writeFile(path.join(out, `${phase}-${theme}-${width}.json`), result ?? dom);
    console.log(`${phase} ${theme} ${width}: ${result?.slice(0, 120)}`);
  }
}
