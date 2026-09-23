import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

const chrome = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';

it.skipIf(!existsSync(chrome))(
  'measures stable caption and message positions while scrolling the real transcript',
  async ({ skip }) => {
    const mobile = process.cwd();
    const directory = await mkdtemp(path.join(tmpdir(), 'transcript-dates-'));
    const shims: Record<string, string> = {
      'react-native-unistyles': `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}';
      export const StyleSheet = { create: factory => factory({ buzz: beelineThemes[new URLSearchParams(location.search).get('theme')] }) };`,
      // The transcript row now carries the arrival flash, so this bundle
      // needs the animation surface that rides with it: a shared value the
      // effect can write, a style hook that reads it, and the two timing
      // helpers. Held still — this proof measures caption and row POSITIONS,
      // and a running animation would move what it is trying to measure.
      'react-native-reanimated': `import React from 'react'; import { View } from 'react-native';
      export const useReducedMotion = () => true;
      export const useSharedValue = initial => ({ value: initial });
      export const useAnimatedStyle = factory => factory();
      export const withTiming = toValue => toValue;
      export const withDelay = (_delayMs, animation) => animation;
      export default { View: props => React.createElement(View, props) };`,
      '@expo/vector-icons': 'export const Ionicons = () => null;',
      'react-native-svg': `import React from 'react';
      export const Path = () => null;
      export default props => React.createElement('svg', props);`,
      './IdentityMark': 'export const IdentityMark = () => null;',
      './MonoMarkdown': `import React from 'react'; import { Text } from 'react-native';
      export const MonoMarkdown = props => React.createElement(Text, { style: props.textStyle }, props.markdown);`,
    };
    try {
      await build({
        entryPoints: [path.join(mobile, 'scripts/transcript-dates-proof.tsx')],
        outfile: path.join(directory, 'bundle.js'),
        bundle: true,
        platform: 'browser',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
        plugins: [
          {
            name: 'native-web-test',
            setup(api) {
              api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
                if (requested in shims) return { path: requested, namespace: 'shim' };
                if (requested === 'react-native')
                  return { path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') };
                if (requested.startsWith('@/')) {
                  const candidate = path.join(mobile, 'sources', requested.slice(2));
                  return {
                    path: ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
                      .map((ext) => candidate + ext)
                      .find(existsSync)!,
                  };
                }
              });
              api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path: requested }) => ({
                contents: shims[requested],
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
        '<!doctype html><div id="root" style="width:390px"></div><pre id="result">PENDING</pre><script src="bundle.js"></script>',
      );
      for (const theme of ['obsidian', 'bone']) {
        for (const direction of ['chronological', 'inverted']) {
          const browser = spawnSync(
            chrome,
            [
              '--headless=new',
              '--no-sandbox',
              '--disable-gpu',
              '--disable-dev-shm-usage',
              `--user-data-dir=${path.join(directory, `${theme}-${direction}`)}`,
              '--dump-dom',
              '--virtual-time-budget=5000',
              `${pathToFileURL(html)}?theme=${theme}&direction=${direction}`,
            ],
            { encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
          );
          if (browser.error) {
            skip(browser.error.message);
          }
          expect(browser.status, browser.stderr).toBe(0);
          expect(browser.stdout, `${theme} ${direction}`).toContain('<pre id="result">PASS</pre>');
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  90000,
);
