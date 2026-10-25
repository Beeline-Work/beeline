import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrowserProof, webProofShims } from '../sources/test/browserProof.ts';
const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(mobile, '../../.beeline-proof/lifecycle-glyphs');
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
  const name = `web-${process.env.PROOF_PHASE ?? 'after'}-${theme}`;
  const { result, status } = await runBrowserProof({ entry: path.join(mobile, 'scripts/lifecycle-glyph-web-proof.tsx'), mobile, shims,
    width: 1280, height: 900, screenshotPath: path.join(output, name + '.png'), head: sceneHead, budgetMs: 3000 });
  if (status) throw new Error(`${name}: ${result}`);
  const receipt = JSON.parse(result);
  if (receipt.rows !== 3 || receipt.overflow || receipt.destination !== 'corner-2939') throw new Error(result);
  if (process.env.PROOF_PHASE !== 'before' && (receipt.glyphs.some(count => count !== 0) ||
    receipt.cornerPoints !== '4.5 4.5 4.5 19.5 19.5 19.5 15 15 9 15 9 9')) throw new Error(result);
  receipts.push({ name, ...receipt });
  console.log(name, result);
}
await writeFile(path.join(output, `web-${process.env.PROOF_PHASE ?? 'after'}-receipts.json`), JSON.stringify(receipts, null, 2) + '\n');
