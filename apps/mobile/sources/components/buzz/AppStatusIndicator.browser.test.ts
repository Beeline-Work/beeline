import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * The Workbench app status marks, proved in both themes at phone and desktop
 * widths with the real Workbench screen. Every run asserts a green check on
 * the connected app, an amber spinner with its glow on the connecting app,
 * and the red failed mark on the erroring app; the screenshots land in
 * `docs/evidence/workbench-status/`.
 *
 *   EVIDENCE=1 npx vitest run sources/components/buzz/AppStatusIndicator.browser
 */
const CHROME_TMP = '/var/tmp';
const OUT = path.join(process.cwd(), '../../docs/evidence/workbench-status');
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

function themeShims(mobile: string, theme: 'obsidian' | 'bone'): Record<string, string> {
  return {
    ...webProofShims(mobile),
    'react-native-unistyles': `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}';
    import * as legacy from '${path.join(mobile, 'sources/theme')}';
    const theme = { ...(legacy.${theme}Theme ?? {}), buzz: beelineThemes.${theme}, dark: beelineThemes.${theme}.dark };
    export const StyleSheet = { create: f => (typeof f === 'function' ? f(theme) : f), hairlineWidth: 1,
      absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } };
    export const useUnistyles = () => ({ theme });
    export const UnistylesRuntime = { setTheme() {}, setRootViewBackgroundColor() {} };`,
    'expo-router': `import React from 'react';
    export const router = { back: () => undefined, replace: () => undefined, push: () => undefined };
    export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => ({ workspaceId: 'workspace-1', viewerId: 'human-dani' });`,
    '@/utils/responsive': 'export const useIsDesktop = () => window.innerWidth >= 900;',
    '@expo/vector-icons': 'export const Ionicons = () => null;',
    '@/buzz/runtime-config':
      "export const getBuzzRuntimeConfig = () => ({ monolithUrl: 'https://server.test', monolithEnabled: true });",
  };
}

async function fontsCss(mobile: string) {
  let css = '';
  for (const font of ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular', 'IBMPlexMono-SemiBold', 'IBMPlexMono-Italic']) {
    const file = path.join(mobile, 'sources/assets/fonts', `${font}.ttf`);
    if (!existsSync(file)) continue;
    css += `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${(await readFile(file)).toString('base64')})}`;
  }
  return css;
}

async function capture(theme: 'obsidian' | 'bone', viewport: (typeof VIEWPORTS)[number], page: 'list' | 'detail') {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(CHROME_TMP, 'workbench-status-'));
  try {
    const shimmed = themeShims(mobile, theme);
    await build({
      entryPoints: [path.join(mobile, 'scripts/workbench-status-proof.tsx')],
      outfile: path.join(directory, 'bundle.js'),
      bundle: true,
      platform: 'browser',
      jsx: 'automatic',
      mainFields: ['browser', 'module', 'main'],
      resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
      loader: { '.js': 'jsx', '.png': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true', global: 'globalThis' },
      logLevel: 'error',
      plugins: [
        {
          name: 'workbench-status-proof',
          setup(api) {
            api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
              if (requested in shimmed) return { path: requested, namespace: 'shim' };
              if (requested === 'react-native')
                return { path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') };
              if (requested.startsWith('@/')) {
                const candidate = path.join(mobile, 'sources', requested.slice(2));
                const found = ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']
                  .map((extension) => candidate + extension)
                  .find((file) => existsSync(file) && statSync(file).isFile());
                if (found) return { path: found };
              }
              return undefined;
            });
            api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path: requested }) => ({
              contents: shimmed[requested],
              loader: 'tsx',
              resolveDir: mobile,
            }));
          },
        },
      ],
    });
    const html = path.join(directory, 'index.html');
    await writeFile(
      html,
      `<!doctype html><meta charset="utf-8"><style>html,body,#root{margin:0;min-height:100%}${await fontsCss(mobile)}</style><div id="root"></div><pre id="result" style="display:none">PENDING</pre><script>window.process={env:{NODE_ENV:'development'}};</script><script src="bundle.js"></script>`,
    );
    await mkdir(OUT, { recursive: true });
    const png = path.join(OUT, `${theme}-${viewport.name}-${page}.png`);
    const run = spawnSync(
      CHROME,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        `--window-size=${viewport.width},${viewport.height}`,
        `--user-data-dir=${path.join(directory, 'profile')}`,
        '--virtual-time-budget=6000',
        '--enable-logging=stderr',
        '--v=0',
        `--screenshot=${png}`,
        `${pathToFileURL(html).href}${page === 'detail' ? '?page=detail' : ''}`,
      ],
      { encoding: 'utf8', timeout: 90_000, env: { ...process.env, TMPDIR: CHROME_TMP } },
    );
    expect(run.error).toBeUndefined();
    const pageErrors = run.stderr.split('\n').filter((line) => line.includes('Uncaught'));
    expect(pageErrors, `${theme} ${viewport.name}`).toEqual([]);
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(png), `${png} was not written`).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe.skipIf(!existsSync(CHROME))('Workbench app status marks', () => {
  it.each(['obsidian', 'bone'] as const)('reports the three marks in %s', async (theme) => {
    const mobile = process.cwd();
    for (const viewport of VIEWPORTS) {
      const { result, status, stderr } = await runBrowserProof({
        entry: path.join(mobile, 'scripts/workbench-status-proof.tsx'),
        mobile,
        shims: themeShims(mobile, theme),
        width: viewport.width,
        height: viewport.height,
      });
      console.log(`${theme} ${viewport.name} list: ${result}`);
      expect(status, stderr).toBe(0);
      expect(result, result).toMatch(/^PASS /);
      expect(result).toContain('check=yes');
      expect(result).toContain('spinner=yes');
      expect(result).toContain('glow=yes');
      expect(result).toContain('failedMark=yes');
    }
    const detail = await runBrowserProof({
      entry: path.join(mobile, 'scripts/workbench-status-proof.tsx'),
      mobile,
      shims: themeShims(mobile, theme),
      width: 390,
      height: 600,
      query: '?page=detail',
    });
    console.log(`${theme} detail: ${detail.result}`);
    expect(detail.status, detail.stderr).toBe(0);
    expect(detail.result, detail.result).toMatch(/^PASS /);
    expect(detail.result).toContain('detailCheck=yes');
    expect(detail.result).toContain('detailSpinner=yes');
    expect(detail.result).toContain('detailFailed=yes');
  }, 240_000);

  it.runIf(process.env.EVIDENCE)('captures both themes at phone and desktop widths', async () => {
    for (const theme of ['obsidian', 'bone'] as const) {
      for (const viewport of VIEWPORTS) await capture(theme, viewport, 'list');
      await capture(theme, VIEWPORTS[0], 'detail');
    }
  }, 400_000);
});