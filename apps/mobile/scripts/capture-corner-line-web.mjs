import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrowserProof, webProofShims } from '../sources/test/browserProof.ts';
const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(mobile, '../../.verification/corner-line');
await mkdir(output, { recursive: true });
let head = '<meta name="viewport" content="width=device-width,initial-scale=1"><style>#result{display:none}html,body,#root{height:100%;margin:0}';
for (const font of ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular']) {
  const data = await readFile(path.join(mobile, 'sources/assets/fonts', font + '.ttf'));
  head += `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${data.toString('base64')})}`;
}
head += '</style>';
const receipts = [];
for (const theme of ['bone', 'obsidian']) {
  const shims = webProofShims(mobile);
  shims['./Ledger'] = 'export const LEDGER_MARGINALIA_WIDTH = 36;';
  shims['react-native-unistyles'] = `import { beelineThemes } from '${mobile}/sources/buzz/groknight';
    const theme = { buzz: beelineThemes.${theme} }; export const StyleSheet = { create: fn => typeof fn === 'function' ? fn(theme) : fn, hairlineWidth: 1 };
    export const useUnistyles = () => ({ theme }); export const UnistylesRuntime = { setTheme: () => {} };`;
  const sceneHead = head + `<style>html,body,#root{background:${theme === 'bone' ? '#F4EFE5' : '#0E0E0F'}}</style>`;
  for (const surface of ['room', 'dm', 'parent']) for (const state of ['opened', 'merged', 'closed']) {
    const name = `web-${theme}-${surface}-${state}`;
    const { result, status } = await runBrowserProof({ entry: path.join(mobile, 'scripts/corner-line-web-proof.tsx'), mobile, shims,
      width: 1280, height: 900, query: `?surface=${surface}&state=${state}`, screenshotPath: path.join(output, name + '.png'), head: sceneHead, budgetMs: 3000 });
    if (status || !result.includes('"status":"PASS"')) throw new Error(`${name}: ${result}`);
    const receipt = JSON.parse(result);
    if (receipt.overflow) throw new Error(`${name}: horizontal overflow`);
    receipts.push({ name, ...receipt });
    console.log(name, 'PASS');
  }
}
await writeFile(path.join(output, 'web-receipts.json'), JSON.stringify(receipts, null, 2) + '\n');
