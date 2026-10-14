import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';
describe.skipIf(!existsSync(CHROME))('separate waveform entry in Chrome', () => {
  it.each(['obsidian', 'bone'].flatMap(theme => ['empty', 'typed'].map(state => ({ theme, state }))))('$theme $state', async ({ theme, state }) => {
    const mobile = process.cwd();
    const shims = webProofShims(mobile);
    shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
    shims['@/constants/Typography'] = 'export const Typography = { default: () => ({}) };';
    shims['@/buzz/speech-input'] = `export const useSpeechInput = () => ({ capability: 'available', state: 'idle',
      partialText: '', volumeLevel: 0, modelDownloadOffered: false,
      start: () => { globalThis.__dictationStarts = (globalThis.__dictationStarts || 0) + 1; },
      stop: async () => null, cancel() {}, acceptModelDownload() {}, declineModelDownload() {} });`;
    const evidence = path.join(mobile, 'evidence/composer-waveform');
    mkdirSync(evidence, { recursive: true });
    const { result, status, stderr } = await runBrowserProof({ mobile, shims, width: 1280, height: 240,
      entry: path.join(mobile, 'scripts/composer-waveform-web-proof.tsx'), query: `?state=${state}`, budgetMs: 6000,
      head: `<style>body{margin:0;background:${theme === 'bone' ? '#F3EEE4' : '#14091A'}}#result{display:none}@font-face{font-family:SpaceGrotesk-Regular;src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts/SpaceGrotesk-Regular.ttf')).toString('base64')})}</style>`,
      screenshotPath: path.join(evidence, `desktop-${theme}-${state}.png`) });
    console.log(result);
    expect(status, stderr).toBe(0);
    expect(result).toContain('RESULT PASS');
  }, 90_000);
});
