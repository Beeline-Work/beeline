import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';
const baselineRef = process.env.VIEWER_DOCK_BASELINE_REF;
describe.skipIf(!existsSync(CHROME))('viewer conversation layout', () => {
  it.each([...(baselineRef ? ['baseline'] : []), 'top', 'newest', 'slow-reply'])('viewer-dock-overflow: %s', async state => {
    const mobile = process.cwd(), shims = webProofShims(mobile);
    shims['react-native-keyboard-controller'] = 'export const useKeyboardState = select => select({height: 0});';
    // Delivery and the native composer are fixture boundaries; layout and markdown stay real.
    shims['./ConversationComposer'] = `import React from 'react'; import { Pressable, Text } from 'react-native';
      export const COMPOSER_SINGLE_LINE_INPUT_HEIGHT = 26;
      export function ConversationComposer({onSend,onChangeText}) { return <Pressable testID="proof-send" onPress={() => { onChangeText('Explain these states'); onSend(); }}><Text>Send</Text></Pressable>; }`;
    shims['expo-router'] = 'export const router = { push() {}, navigate() {} }; export const useRouter = () => router;';
    shims['./AttachmentPickerSheet'] = 'export const AttachmentPickerSheet = () => null;';
    shims['@/components/buzz/ConversationComposer'] = shims['./ConversationComposer'];
    if (state === 'baseline') {
      shims['../sources/components/buzz/ViewerConversationDock'] = execFileSync('git', ['show', `${baselineRef}:apps/mobile/sources/components/buzz/ViewerConversationDock.tsx`], { encoding: 'utf8' }).replaceAll("from './", "from '@/components/buzz/");
      shims['@/components/buzz/AttachmentPickerSheet'] = shims['./AttachmentPickerSheet'];
    }
    const evidence = path.join(mobile, 'evidence/viewer-dock-overflow'); mkdirSync(evidence, { recursive: true });
    const proof = await runBrowserProof({ mobile, shims, width: 390, height: state === 'newest' ? 600 : 900,
      entry: path.join(mobile, 'scripts/viewer-dock-overflow-proof.tsx'), query: `?${state}`, budgetMs: 12000,
      head: `<style>#result{display:none}${['SpaceGrotesk-Regular', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular'].map(font => `@font-face{font-family:${font};src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', font + '.ttf')).toString('base64')})}`).join('')}</style><script>window.addEventListener('error',e=>{document.getElementById('result').textContent=e.message+' '+e.error?.stack;});</script>`, screenshotPath: path.join(evidence, `${state}.png`) });
    console.log(proof.result); expect(proof.status, proof.stderr).toBe(0); expect(proof.result).toContain('RESULT PASS');
  }, 90_000);

});
