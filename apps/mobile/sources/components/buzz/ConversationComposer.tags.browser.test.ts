import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

function composerTagsProofShims(mobile: string): Record<string, string> {
  return {
    ...webProofShims(mobile),
    // The page picks the theme from `?theme=`.
    'react-native-unistyles': `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}';
    const theme = { buzz: beelineThemes[new URLSearchParams(location.search).get('theme') ?? 'obsidian'] };
    export const StyleSheet = { create: factory => (typeof factory === 'function' ? factory(theme) : factory), hairlineWidth: 1,
      absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } };
    export const useUnistyles = () => ({ theme });`,
    '@/constants/Typography': 'export const Typography = { default: () => ({}) };',
    './speech-recognition-adapter': `import { speechProofRecognizer } from '${path.join(
      mobile,
      'scripts/composer-dictation-proof-recognizer',
    )}';
    export const getRecognitionModule = () => speechProofRecognizer.module;`,
    './speech-locale': "export const getDeviceSpeechLocale = () => 'en-US';",
    // Groq is the page's scripted upload (`__groqUpload` in the proof).
    './speech-transcription': `export const dictationTranscriptionAvailable = () => true;
    export const startDictationUpload = () => globalThis.__groqUpload();
    export const discardDictationRecordings = async () => {};`,
  };
}

// Set COMPOSER_TAGS_SCREENSHOTS to a directory to also save each frame.
const screenshots = process.env.COMPOSER_TAGS_SCREENSHOTS;
const FRAMES = ['idle', 'menu', 'many', 'reply-recording', 'reply-dashed', 'sending', 'groq'];

describe.skipIf(!existsSync(CHROME))('Composer agent tags in a browser', () => {
  for (const theme of ['obsidian', 'bone']) {
    it(`${theme}: chip, tag menu, many tags, a dictated quote reply that ■ can drop while it is sent, and an untagged Groq reply`, async () => {
      const mobile = process.cwd();
      const { result, status, stderr } = await runBrowserProof({
        entry: path.join(mobile, 'scripts/composer-tags-proof.tsx'),
        mobile,
        width: 390,
        height: 640,
        // The full walk takes about 9 s of page time.
        budgetMs: 20_000,
        query: `?theme=${theme}`,
        shims: composerTagsProofShims(mobile),
      });
      expect(status, stderr).toBe(0);
      console.log(result);
      expect(result).toContain('RESULT PASS');

      if (!screenshots) return;
      for (const frame of FRAMES) {
        await runBrowserProof({
          entry: path.join(mobile, 'scripts/composer-tags-proof.tsx'),
          mobile,
          width: 390,
          height: 640,
          budgetMs: 20_000,
          query: `?theme=${theme}&stop=${frame}`,
          shims: composerTagsProofShims(mobile),
          screenshotPath: path.join(screenshots, `${theme}-${frame}.png`),
        });
      }
    }, 300_000);
  }
});
