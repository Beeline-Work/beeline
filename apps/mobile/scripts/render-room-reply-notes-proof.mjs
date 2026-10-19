import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrowserProof, webProofShims } from '../sources/test/browserProof.ts';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(mobile, '../../.verification/room-reply-notes');
await mkdir(out, { recursive: true });
let head = '<style>';
for (const font of [
  'SpaceGrotesk-Regular',
  'SpaceGrotesk-Medium',
  'SpaceGrotesk-SemiBold',
  'IBMPlexMono-Regular',
  'IBMPlexSans-Regular',
  'IBMPlexSans-SemiBold',
]) {
  const bytes = await readFile(path.join(mobile, 'sources/assets/fonts', `${font}.ttf`));
  head += `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${bytes.toString('base64')})}`;
}
head += '</style>';
const shims = webProofShims(mobile);
// The output sheet reaches React Navigation, which wants the full context API.
shims['react-native-safe-area-context'] = `import React from 'react';
export const initialWindowMetrics = null;
export const SafeAreaInsetsContext = React.createContext({ top: 0, bottom: 0, left: 0, right: 0 });
export const SafeAreaProvider = ({ children }) => children;
export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });`;
for (const scene of ['collapsed', 'expanded', 'answer-first']) {
  const screenshotPath = path.join(out, `${scene}.png`);
  const { result } = await runBrowserProof({
    entry: path.join(mobile, 'scripts/room-reply-notes-proof.tsx'),
    mobile,
    shims,
    width: 452,
    height: scene === 'expanded' ? 760 : 420,
    query: `?scene=${scene}`,
    screenshotPath,
    head,
  });
  console.log(scene, result.trim(), screenshotPath);
}
