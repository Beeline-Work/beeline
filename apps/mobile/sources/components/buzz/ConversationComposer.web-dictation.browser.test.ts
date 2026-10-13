import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

describe.skipIf(!existsSync(CHROME))('Web composer dictation', () => {
  for (const api of ['prefixed', 'standard', 'unsupported']) {
    it(`${api}: capability and browser transcript, stop, denial and retry`, async () => {
      const mobile = process.cwd();
      const { result, status, stderr } = await runBrowserProof({
        mobile, entry: path.join(mobile, 'scripts/composer-web-dictation-proof.tsx'),
        width: 390, budgetMs: 9000, query: `?api=${api}`,
        shims: {
          ...webProofShims(mobile),
          '@/constants/Typography': 'export const Typography = { default: () => ({}) };',
          './speech-locale': "export const getDeviceSpeechLocale = () => 'en-US';",
          './speech-transcription': `export const dictationTranscriptionAvailable = () => false;
            export const startDictationUpload = () => null; export const discardDictationRecordings = async () => {};`,
          // Expo's web registry normally provides this module base. Keep the
          // library's real speech module and browser event conversion.
          expo: `export class NativeModule { addListener() { return { remove() {} }; } }
            export const registerWebModule = Module => new Module(); export const useEventListener = () => {};`,
        },
      });
      console.log(result);
      expect(status, stderr).toBe(0);
      expect(result).toContain('RESULT PASS');
    }, 90_000);
  }
});
