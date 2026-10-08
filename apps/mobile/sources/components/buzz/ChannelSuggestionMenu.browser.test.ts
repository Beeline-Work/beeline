import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

describe.skipIf(!existsSync(CHROME))('Composer # suggestions in a browser', () => {
  it.each(['obsidian', 'bone'])(
    'lists Rooms and corners for #exp and inserts the tapped corner: %s',
    async (theme) => {
      const mobile = process.cwd();
      const shims = webProofShims(mobile);
      const { result, status, stderr } = await runBrowserProof({
        entry: path.join(mobile, 'scripts/channel-suggestion-proof.tsx'),
        mobile,
        width: 420,
        height: 520,
        shims: {
          ...shims,
          'react-native-unistyles': shims['react-native-unistyles']!.replace(
            'beelineThemes.obsidian',
            `beelineThemes.${theme}`,
          ),
          '@/constants/Typography': 'export const Typography = { default: () => ({}) };',
          './speech-recognition-adapter': 'export const getRecognitionModule = () => null;',
          './speech-locale': "export const getDeviceSpeechLocale = () => 'en-US';",
          './speech-transcription': `export const dictationTranscriptionAvailable = () => false;
        export const startDictationUpload = () => null;
        export const discardDictationRecordings = async () => {};`,
        },
        query: `?theme=${theme}${process.env.CHANNEL_SUGGESTION_SCREENSHOT_DIR ? `&stop=${process.env.CHANNEL_SUGGESTION_STOP ?? 'menu'}` : ''}`,
        ...(process.env.CHANNEL_SUGGESTION_SCREENSHOT_DIR
          ? {
              screenshotPath: path.join(
                process.env.CHANNEL_SUGGESTION_SCREENSHOT_DIR,
                `${theme}-${process.env.CHANNEL_SUGGESTION_STOP ?? 'menu'}.png`,
              ),
            }
          : {}),
      });
      expect(status, stderr).toBe(0);
      console.log(result);
      expect(result).toContain('RESULT PASS');
    },
    90_000,
  );
});
