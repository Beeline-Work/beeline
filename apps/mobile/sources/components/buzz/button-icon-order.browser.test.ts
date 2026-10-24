import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

for (const theme of ['bone', 'obsidian'])
  for (const width of [390, 1280]) {
    it.skipIf(!existsSync(CHROME))(`preserves migrated icon order: ${theme} ${width}px (SYSROWS-9)`, async () => {
      const mobile = process.cwd();
      const shims = webProofShims(mobile);
      shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
      // Only the native modal boundary and unrelated roster member cells are replaced.
      // All measured controls, text, glyphs and shared Buttons render their real code.
      shims['./HullActionSheet'] = `import React from 'react'; export const HullActionSheetModal = ({children}) => <div>{children}</div>;`;
      shims['./MemberRosterRow'] = 'export const MemberRosterRow = () => null;';
      const screenshotDir = process.env.CONTROL_APPEARANCE_SCREENSHOT_DIR;
      if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
      const fonts = ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold'];
      const proof = await runBrowserProof({
        entry: path.join(mobile, 'scripts/button-icon-order-browser-proof.tsx'),
        mobile, shims, width, height: 2000,
        head: `<style>#root{width:${width}px}#result{display:none}body{margin:0;background:${theme === 'bone' ? '#F3EEE4' : '#14091A'}}${fonts.map(font => `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', `${font}.ttf`)).toString('base64')})}`).join('')}</style>`,
        screenshotPath: screenshotDir ? path.join(screenshotDir, `icon-order-${width}-${theme}.png`) : undefined,
      });
      if (screenshotDir) writeFileSync(path.join(screenshotDir, `icon-order-${width}-${theme}.json`), proof.result);
      expect(proof.status, proof.stderr).toBe(0);
      expect(proof.result, proof.stderr).toContain('PASS BUTTON ICON ORDER');
    }, 90_000);
  }
