// ICON-FONT-1: real installed Expo icon lifecycle + expo-font + FontFaceObserver.
// Platform/native drawing bridges are stand-ins; font promises and Chrome are real.
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const mobile = resolve(import.meta.dirname, '..');
const platformStub = `
  export const Platform = { OS: 'web', select: o => o.web ?? o.default };
  export class CodedError extends Error {}
  export class UnavailabilityError extends Error {}
  export const registerWebModule = C => new C();
  export const Asset = {};
`;
const bundle = await build({
  stdin: {
    contents: `
      import createIconSet from './node_modules/@expo/vector-icons/build/createIconSet.js';
      import * as Font from './node_modules/expo-font/src/Font.ts';
      const mode = location.pathname.slice(1);
      // Recreate the production timeout without guessing its unknown network state.
      if (mode === 'timeout') document.fonts.load = () => new Promise(() => {});
      const errors = [], warnings = [];
      addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
      console.warn = (...args) => warnings.push(args.map(String).join(' '));
      const Icon = createIconSet({ back: 65 }, 'Ionicons', mode === 'network' ? '/missing.ttf' : '/icon.ttf');
      const icon = new Icon({ name: 'back' });
      icon.setState = patch => Object.assign(icon.state, patch);
      // React ignores the async componentDidMount return value. Do not catch it here.
      icon.componentDidMount();
      let ready = false;
      Font.loadAsync({ 'SpaceGrotesk-Regular': '/prose.ttf' })
        .catch(() => {}).finally(() => { ready = true; });
      setTimeout(() => {
        document.body.textContent = JSON.stringify({ ready, errors, warnings, iconLoaded: icon.state.fontIsLoaded });
      }, 13000);
    `,
    resolveDir: mobile,
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  loader: { '.js': 'jsx' },
  resolveExtensions: ['.web.ts', '.ts', '.web.js', '.js', '.json'],
  define: { 'process.env.EXPO_OS': '"web"', __DEV__: 'false' },
  plugins: [
    {
      name: 'native-bridges',
      setup(b) {
        b.onResolve({ filter: /^(expo-font|expo-modules-core|expo-asset|react-native)$/ }, (a) => ({
          path: a.path,
          namespace: 'stub',
        }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
          if (a.path === 'expo-font')
            return {
              contents: `export * from '${mobile}/node_modules/expo-font/src/Font.ts';`,
              resolveDir: mobile,
            };
          if (a.path === 'react-native')
            return {
              contents: `${platformStub} export const Text = () => null; export const PixelRatio = { get: () => 1 };`,
            };
          return { contents: platformStub };
        });
        // Drawing and button composition do not own the lifecycle promise.
        b.onResolve(
          { filter: /vendor\/react-native-vector-icons\/lib\/(create-icon-set|icon-button)$/ },
          (a) => ({ path: a.path, namespace: 'drawing' }),
        );
        b.onLoad({ filter: /.*/, namespace: 'drawing' }, (a) => ({
          contents: a.path.endsWith('icon-button')
            ? 'export default () => () => null;'
            : 'export const DEFAULT_ICON_COLOR = "black", DEFAULT_ICON_SIZE = 12; export default () => () => null;',
        }));
      },
    },
  ],
});
const iconFont = await readFile(
  join(
    mobile,
    'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf',
  ),
);
const proseFont = await readFile(join(mobile, 'sources/assets/fonts/SpaceGrotesk-Regular.ttf'));
const server = createServer((req, res) => {
  if (req.url === '/icon.ttf' || req.url === '/prose.ttf') {
    res.setHeader('Content-Type', 'font/ttf');
    res.end(req.url === '/icon.ttf' ? iconFont : proseFont);
  } else if (req.url === '/missing.ttf') res.writeHead(404).end();
  else {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<body><script>${bundle.outputFiles[0].text}</script></body>`);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
try {
  for (const mode of ['timeout', 'network', 'success']) {
    const profile = await mkdtemp(join(tmpdir(), 'beeline-font-proof-'));
    try {
      const dom = await new Promise((resolveOutput, reject) => {
        const child = spawn(
          process.env.CHROME_BIN || '/usr/bin/google-chrome',
          [
            '--headless',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            `--user-data-dir=${profile}`,
            '--dump-dom',
            '--virtual-time-budget=14000',
            `http://127.0.0.1:${server.address().port}/${mode}`,
          ],
          { timeout: 20000 },
        );
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolveOutput(stdout) : reject(new Error(stderr)),
        );
      });
      const result = JSON.parse(dom.match(/<body>(.*?)<\/body>/s)?.[1]);
      assert.equal(result.ready, true, mode);
      assert.deepEqual(result.errors, [], mode);
      assert.equal(result.iconLoaded, mode === 'success', mode);
      assert.equal(result.warnings.length, mode === 'success' ? 0 : 1, mode);
      if (mode === 'timeout') assert.match(result.warnings[0], /12000ms timeout exceeded/);
      console.log(`ICON-FONT-1 ${mode}: ${JSON.stringify(result)}`);
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
} finally {
  server.close();
}
