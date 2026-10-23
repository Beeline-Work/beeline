import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

for (const width of [390, 1280]) for (const theme of ['bone', 'obsidian'])
  it.skipIf(!existsSync(CHROME))(`transcript dividers: ${width} ${theme}`, async () => {
    const mobile = process.cwd();
    const shims = webProofShims(mobile);
    shims['react-native-reanimated'] += '\nexport const FadeOut = FadeInDown; export const interpolateColor = (_, __, colors) => colors[1];';
    shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
    shims['./ToolOutputSheet'] = 'export const ToolOutputSheet = () => null;';
    shims['./Ledger'] = 'export const LedgerBylineView = () => null; export const ledgerEntryRhythm = () => ({}); export const provisionalProseStyle = () => ({}); export const settledAgentProseStyle = () => ({});';
    shims['./MonoMarkdown'] = 'export const MonoMarkdown = () => null;';
    const directory = 'evidence/transcript-dividers';
    mkdirSync(directory, { recursive: true });
    const fonts = ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular'];
    const head = `<style>#result{display:none}body{background:${theme === 'bone' ? '#F3EEE4' : '#14091A'}}${fonts.map(font => `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', `${font}.ttf`)).toString('base64')})}`).join('')}</style>`;
    const proof = await runBrowserProof({ entry: path.join(mobile, 'scripts/transcript-dividers-browser-proof.tsx'), mobile, shims, width, head, screenshotPath: path.join(directory, `web-${width}-${theme}.png`) });
    expect(proof.status, proof.stderr).toBe(0);
    expect(proof.result, proof.stderr).toContain('PASS DIVIDERS');
  }, 90_000);
