import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

const OUT = process.env.COMPOSER_V4_OUT ?? 'after';
describe.skipIf(!existsSync(CHROME))('locked v4 composer slots in Chrome', () => {
  it.each(['bone', 'obsidian'].flatMap(theme => [390, 720].map(width => ({ theme, width }))))('$theme $width', async ({ theme, width }) => {
    const mobile = process.cwd();
    const shims = webProofShims(mobile);
    shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
    shims['@/constants/Typography'] = 'export const Typography = { default: () => ({}) };';
    // A recogniser that listens on start and hears one phrase.
    shims['@/buzz/speech-input'] = `import { useEffect, useRef, useState } from 'react';
      export const useSpeechInput = (onFinal) => {
        const final = useRef(onFinal); final.current = onFinal;
        const [state, setState] = useState('idle');
        const [volumeLevel, setVolume] = useState(0);
        useEffect(() => { if (state !== 'listening') return;
          let i = 0; const t = setInterval(() => setVolume(0.3 + 0.6 * Math.abs(Math.sin(i++ * 1.7))), 60);
          return () => clearInterval(t); }, [state]);
        return { capability: 'available', state, partialText: '', volumeLevel, modelDownloadOffered: false,
          start() { setState('listening'); },
          stop: async () => { final.current('the voice text'); setState('idle'); return 'the voice text'; },
          cancel() { setState('idle'); }, acceptModelDownload() {}, declineModelDownload() {} };
      };`;
    const evidence = path.join(mobile, 'evidence/composer-v4', OUT);
    mkdirSync(evidence, { recursive: true });
    const { result, status, stderr } = await runBrowserProof({ mobile, shims, width: width + 32, height: 300,
      entry: path.join(mobile, 'scripts/composer-v4-web-proof.tsx'), query: `?width=${width}&act=${process.env.COMPOSER_V4_ACT ?? '0'}`, budgetMs: 6000,
      head: `<style>body{margin:0;background:${theme === 'bone' ? '#F3EEE4' : '#14091A'}}#result{display:none}@font-face{font-family:SpaceGrotesk-Regular;src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts/SpaceGrotesk-Regular.ttf')).toString('base64')})}</style>`,
      screenshotPath: path.join(evidence, `${width}-${theme}.png`) });
    console.log(result);
    expect(status, stderr).toBe(0);
    if (OUT === 'after') expect(result).toContain('RESULT PASS');
  }, 90_000);
});
