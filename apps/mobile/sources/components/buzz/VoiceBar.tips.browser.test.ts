import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';
describe.skipIf(!existsSync(CHROME))('Call controls in Chrome', () => {
  it.each(['obsidian', 'bone'].flatMap(theme => ['controls', 'countdown'].map(shot => ({ theme, shot }))))('$theme $shot', async ({ theme, shot }) => {
    const mobile = process.cwd();
    const shims = webProofShims(mobile);
    shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
    shims['@/constants/Typography'] = 'export const Typography = { default: () => ({}) };';
    shims['@/buzz/speech-input'] = `export const useSpeechInput = () => ({ capability: 'available', state: 'idle',
      partialText: '', volumeLevel: 0, modelDownloadOffered: false, start() {}, stop: async () => null, cancel() {},
      acceptModelDownload() {}, declineModelDownload() {} });`;
    const evidence = path.join(mobile, 'evidence/voice-multi-tips');
    mkdirSync(evidence, { recursive: true });
    const { result, status, stderr } = await runBrowserProof({ mobile, shims, width: 480, height: 240,
      entry: path.join(mobile, 'scripts/voice-multi-tips-web-proof.tsx'), query: `?shot=${shot}`, budgetMs: 3000,
      head: `<style>body{margin:0;background:${theme === 'bone' ? '#F3EEE4' : '#14091A'}}#result{display:none}@font-face{font-family:SpaceGrotesk-Regular;src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts/SpaceGrotesk-Regular.ttf')).toString('base64')})}</style>`,
      screenshotPath: path.join(evidence, `chrome-${theme}-two-humans-${shot}.png`) });
    console.log(result);
    expect(status, stderr).toBe(0);
    expect(result).toContain('RESULT PASS');
  }, 90_000);
});
