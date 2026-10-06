import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

function shims(mobile: string, theme: string) {
  const base = webProofShims(mobile);
  const fonts = ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold']
    .map(
      (name) =>
        `@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', `${name}.ttf`)).toString('base64')})}`,
    )
    .join('');
  const result: Record<string, string> = {
    ...base,
    'react-native-unistyles': `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}';
      const theme = { buzz: beelineThemes.${theme} };
      document.body.style.background = theme.buzz.bgBase;
      document.body.style.color = theme.buzz.textPrimary;
      document.body.style.fontFamily = 'SpaceGrotesk-Regular';
      document.head.appendChild(Object.assign(document.createElement('style'), {textContent: ${JSON.stringify(fonts)}}));
      export const StyleSheet = { create: f => typeof f === 'function' ? f(theme) : f, hairlineWidth: 1, absoluteFillObject: {position:'absolute',top:0,right:0,bottom:0,left:0} };
      export const useUnistyles = () => ({theme});`,
    '@/utils/responsive': 'export const useIsDesktop = () => true;',
    'expo-router': 'export const router = {push() {}};',
    '@/modal': 'export const Modal = {show() {},hide() {}};',
    '@/utils/open-external-url': 'export const openExternalUrl = async () => {};',
  };
  return result;
}

describe.skipIf(!existsSync(CHROME))('approved desktop UI fixes', () => {
  for (const theme of ['obsidian', 'bone']) {
    it(`${theme}: full labels, equal rails, consistent icons and keyboard actions`, async () => {
      const mobile = process.cwd();
      const proof = await runBrowserProof({
        entry: path.join(mobile, 'scripts/desktop-ui-fixes-proof.tsx'),
        mobile,
        shims: shims(mobile, theme),
        width: 1280,
        height: 780,
        screenshotPath: process.env.DESKTOP_UI_PROOF_OUT
          ? path.join(process.env.DESKTOP_UI_PROOF_OUT, `${theme}.png`)
          : undefined,
      });
      expect(proof.status, proof.stderr).toBe(0);
      expect(proof.result).toMatch(/^PASS/);
      expect(proof.result).toContain('rail insets 8/8');
      console.log(proof.result);
    }, 90_000);
  }
});
