import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

describe.skipIf(!existsSync(CHROME))('Composer # suggestions in a browser', () => {
  it('lists Rooms and corners for #exp and inserts the tapped corner', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/channel-suggestion-proof.tsx'),
      mobile,
      width: 420,
      height: 520,
      shims: {
        ...webProofShims(mobile),
        '@/constants/Typography': 'export const Typography = { default: () => ({}) };',
        './speech-recognition-adapter': 'export const getRecognitionModule = () => null;',
        './speech-locale': "export const getDeviceSpeechLocale = () => 'en-US';",
        './speech-transcription': `export const dictationTranscriptionAvailable = () => false;
        export const startDictationUpload = () => null;
        export const discardDictationRecordings = async () => {};`,
      },
      ...(process.env.CHANNEL_SUGGESTION_SCREENSHOT
        ? { screenshotPath: process.env.CHANNEL_SUGGESTION_SCREENSHOT, query: '?stop=menu' }
        : {}),
    });
    expect(status, stderr).toBe(0);
    console.log(result);
    expect(result).toContain('RESULT PASS');
  }, 90_000);
});
