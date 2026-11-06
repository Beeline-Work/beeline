const esbuild = require('esbuild'),
  path = require('path'),
  fs = require('fs');
const mobile = path.resolve('apps/mobile');
esbuild.build({
  entryPoints: ['apps/mobile/evidence/title-alignment/proof-kit/scene.jsx'],
  outfile: '.beeline-proof/title-alignment/bundle.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  nodePaths: [mobile + '/node_modules'],
  alias: {
    'react-native': mobile + '/node_modules/react-native-web',
    react: mobile + '/node_modules/react',
    'react-dom': mobile + '/node_modules/react-dom',
    '@': mobile + '/sources',
  },
  define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
  plugins: [
    {
      name: 'proof',
      setup(b) {
        b.onResolve({ filter: /^react-native-svg$/ }, () => ({ path: 'svg', namespace: 'proof' }));
        b.onResolve({ filter: /^react-native-unistyles$/ }, () => ({
          path: 'theme',
          namespace: 'proof',
        }));
        b.onResolve({ filter: /^\.\/(Button|HullSwitch|StateDot)$/ }, () => ({
          path: 'unused',
          namespace: 'proof',
        }));
        b.onResolve({ filter: /^\.\/decorative-glyph$/ }, () => ({
          path: mobile + '/sources/components/buzz/decorative-glyph.web.ts',
        }));
        b.onLoad({ filter: /.*/, namespace: 'proof' }, (a) => ({
          contents:
            a.path === 'svg'
              ? `import React from '${mobile}/node_modules/react/index.js';export default p=>React.createElement('svg',p);export const Polygon=p=>React.createElement('polygon',p);export const Polyline=p=>React.createElement('polyline',p);`
              : a.path === 'theme'
                ? `import {beelineThemes} from '${mobile}/sources/buzz/groknight.ts';const theme={buzz:beelineThemes[new URLSearchParams(location.search).get('theme')||'bone']};export const StyleSheet={create:f=>typeof f==='function'?f(theme):f,hairlineWidth:1};export const useUnistyles=()=>({theme});`
                : 'export const Button=()=>null;export const HullSwitch=()=>null;export const StateDot=()=>null;',
          resolveDir: mobile,
          loader: 'js',
        }));
      },
    },
  ],
});

let html = '<style>body{margin:0}';
for (const f of ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium'])
  html += `@font-face{font-family:${f};src:url(data:font/ttf;base64,${fs.readFileSync('apps/mobile/sources/assets/fonts/' + f + '.ttf').toString('base64')})}`;
html += '</style><div id="root"></div><script src="bundle.js"></script>';
fs.writeFileSync('.beeline-proof/title-alignment/index.html', html);
