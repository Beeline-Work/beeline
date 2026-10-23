import { build } from 'esbuild';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
const mobile = path.resolve(import.meta.dirname, '../..');
const out = '/tmp/jellybean-appearance/site';
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [path.join(import.meta.dirname, 'entry.ts')], outfile: `${out}/bundle.js`,
  bundle: true, platform: 'browser', mainFields: ['browser', 'module', 'main'],
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
  define: { 'process.env.NODE_ENV': '"development"', 'process.env.EXPO_OS': '"web"', __DEV__: 'true', global: 'globalThis' },
  alias: { 'react-native': `${mobile}/node_modules/react-native-web/dist/index.js`, '@': `${mobile}/sources` },
  plugins: [{ name: 'native-boundaries', setup(api) {
    const shims = {
      'react-native-mmkv': 'export class MMKV {}',
      'expo-modules-core': 'export const requireOptionalNativeModule = () => null;',
    };
    api.onResolve({ filter: /.*/ }, ({ path: name }) => name in shims ? { path: name, namespace: 'shim' } : null);
    api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path: name }) => ({ contents: shims[name], loader: 'js' }));
  } }],
});
writeFileSync(`${out}/index.html`, '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="bundle.js"></script>');
console.log(out);
