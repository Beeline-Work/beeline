import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

async function renderPicker(busy: string | null, screenshotPath?: string) {
  const mobile = process.cwd();
  const shims = webProofShims(mobile);
  shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', 'beelineThemes.bone');
  // Render the sheet in place of the native Modal so the page can measure it.
  shims['./HullDialog'] = `import React from 'react';
    export * from '${path.join(mobile, 'sources/components/buzz/HullDialog.tsx')}';
    export const HullModal = ({ children }) => <>{children}</>;`;
  shims['@/utils/responsive'] = 'export const useIsDesktop = () => false;';
  const proof = await runBrowserProof({
    mobile, shims, width: 390, query: busy ? `?busy=${busy}` : '',
    entry: path.join(mobile, 'scripts/direct-message-picker-proof.tsx'),
    head: `<style>#result{display:none}html,body{background:#F3EEE4}${['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold'].map(name => `@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', `${name}.ttf`)).toString('base64')})}`).join('')}</style>`,
    screenshotPath,
  });
  expect(proof.status, proof.stderr).toBe(0);
  const result = JSON.parse(proof.result);
  if (process.env.PRINT_PROOF) console.log(result);
  return result as { titleInset: number; searchLeftInset: number; searchRightInset: number; rowCount: number;
    nestedButtons: number;
    rowLeadInsets: number[];
    headerInsets: number[];
    busyValues: boolean[];
  };
}

describe.skipIf(!existsSync(CHROME))('Message member picker', () => {
  it('insets the search field on the title axis', async () => {
    const result = await renderPicker(null, process.env.DM_PICKER_SCREENSHOT);
    expect(result.searchLeftInset).toBe(result.titleInset);
    expect(result.searchRightInset).toBe(result.titleInset);
  });

  it('puts rows and headers on the title edge, with the whole row as the only tap target', async () => {
    const result = await renderPicker('pubkey-chloro', process.env.DM_PICKER_BUSY_SCREENSHOT);
    expect(result.rowCount).toBe(3);
    expect(result.nestedButtons).toBe(0);
    expect(result.headerInsets).toHaveLength(2);
    for (const inset of [...result.rowLeadInsets, ...result.headerInsets]) expect(inset).toBe(result.titleInset);
    expect(result.busyValues).toEqual([false, true, false]);
  });
});
