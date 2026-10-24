import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';
for (const theme of ['bone', 'obsidian']) for (const width of [390, 1280]) {
  it.skipIf(!existsSync(CHROME))(`delivery failure actions: ${theme} ${width}px`, async () => {
    const mobile = process.cwd(), shims = webProofShims(mobile);
    shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
    const directory = process.env.SWEEP_SCREENSHOT_DIR;
    const fonts = ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'IBMPlexMono-SemiBold'];
    const fontStyles = fonts.map(font => `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', font + '.ttf')).toString('base64')})}`).join('');
    if (directory) mkdirSync(directory, { recursive: true });
    const proof = await runBrowserProof({ mobile, shims, entry: path.join(mobile, 'scripts/error-banner-browser-proof.tsx'),
      width, height: 400, query: process.env.SWEEP_BEFORE ? '?before' : '', head: `<style>${fontStyles}#root{width:${width}px}#result{display:none}body{background:${theme === 'bone' ? '#F3EEE4' : '#14091A'}}</style>`,
      screenshotPath: directory ? path.join(directory, `delivery-${process.env.SWEEP_BEFORE ? 'main' : 'pr'}-web-${width}-${theme}.png`) : undefined });
    console.log(proof.result);
    expect(proof.status, proof.stderr).toBe(0);
    expect(proof.result, proof.stderr).toContain(process.env.SWEEP_BEFORE ? 'PASS main' : 'PASS delivery');
  }, 90_000);
}
