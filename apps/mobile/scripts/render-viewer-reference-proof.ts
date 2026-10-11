import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runBrowserProof } from '../sources/test/browserProof';
async function main() {
  const mobile = process.cwd();
  const fonts = ['IBMPlexMono-Regular', 'SpaceGrotesk-Regular'];
  const head = `<style>html,body,#root{height:100%}#result{display:none}${fonts.map((n) => `@font-face{font-family:'${n}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', n + '.ttf')).toString('base64')})}`).join('')}</style>`;
  for (const mode of ['light', 'dark'])
    for (const before of [true, false]) {
      const result = await runBrowserProof({
        mobile,
        entry: path.join(mobile, 'scripts/viewer-reference-proof.tsx'),
        shims: {
          'react-native-unistyles': `import {beelineThemes} from '${mobile}/sources/buzz/groknight';const theme={buzz:beelineThemes.${mode === 'light' ? 'bone' : 'obsidian'}};export const StyleSheet={create:f=>f(theme)};export const useUnistyles=()=>({theme});`,
        },
        width: 700,
        height: 400,
        head,
        query: before ? '?before' : '',
        screenshotPath: path.resolve(
          mobile,
          '../../evidence/context-reference/web-' + (before ? 'before-' : 'after-') + mode + '.png',
        ),
      });
      if (result.result !== 'PASS') throw Error(result.result);
      console.log(mode, before ? 'before' : 'after', result.result);
    }
}
main();
