import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

const phase = process.env.RETRY_WRAP_PHASE === 'before' ? 'before' : 'after';

function fontFace(mobile: string, family: string, file: string) {
  const bytes = readFileSync(path.join(mobile, 'sources/assets/fonts', file)).toString('base64');
  return `@font-face{font-family:${family};src:url(data:font/ttf;base64,${bytes})}`;
}

describe.skipIf(!existsSync(CHROME))('RETRY-WRAP-1 failed-upload Retry stays on one line', () => {
  it.each([360, 390].flatMap((width) => (['bone', 'obsidian'] as const).map((theme) => ({ theme, width }))))(
    '$theme at $width px',
    async ({ theme, width }) => {
      const mobile = process.cwd();
      const shims = webProofShims(mobile);
      shims['react-native-unistyles'] = shims['react-native-unistyles'].replace(
        'beelineThemes.obsidian',
        `beelineThemes.${theme}`,
      );
      shims['@/constants/Typography'] = 'export const Typography = { default: () => ({}) };';
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
      const evidence = path.join(mobile, 'evidence/composer-retry-wrap', phase);
      mkdirSync(evidence, { recursive: true });
      const proof = await runBrowserProof({
        mobile,
        shims,
        width: Math.max(width, 500),
        height: 520,
        entry: path.join(mobile, 'scripts/composer-retry-wrap-web-proof.tsx'),
        query: `?width=${width}`,
        budgetMs: 8000,
        head: `<style>body{margin:0;background:${theme === 'bone' ? '#F3EEE4' : '#14091A'}}#result{display:none}${
          fontFace(mobile, 'SpaceGrotesk-Regular', 'SpaceGrotesk-Regular.ttf')
        }${fontFace(mobile, 'SpaceGrotesk-Medium', 'SpaceGrotesk-Medium.ttf')}${
          fontFace(mobile, 'IBMPlexMono-Regular', 'IBMPlexMono-Regular.ttf')
        }</style>`,
        screenshotPath: path.join(evidence, `web-${width}-${theme}.png`),
      });
      expect(proof.status, proof.stderr).toBe(0);
      const result = JSON.parse(proof.result) as {
        width: number;
        retryText: string;
        retryLines: number;
        retryFlexShrink: string;
        oneLine: boolean;
        unshrunk: boolean;
        truncated: boolean;
        error?: string;
      };
      console.log(`RETRY-WRAP-1 ${phase} ${theme} ${width}: ${proof.result}`);
      expect(result.error).toBeUndefined();
      expect(result.width).toBe(width);
      expect(result.retryText).toBe('Retry');
      // Web paints the shrunk label as overflow instead of a second line.
      // Android wraps that same shrunk box into "Retr" / "y".
      if (phase === 'before') {
        expect(result.unshrunk).toBe(false);
        expect(result.retryFlexShrink).toBe('1');
        return;
      }
      expect(result.oneLine).toBe(true);
      expect(result.retryLines).toBe(1);
      expect(result.unshrunk).toBe(true);
      expect(result.retryFlexShrink).toBe('0');
      expect(result.truncated).toBe(true);
    },
    90_000,
  );
});
