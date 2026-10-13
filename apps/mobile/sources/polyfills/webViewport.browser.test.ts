import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';
import { installWebViewport } from './webViewport';

it('does nothing in the native runtime without a document', () => {
  expect(installWebViewport()).toBeUndefined();
});

describe.skipIf(!existsSync(CHROME))('web Room/DM composer with Android browser chrome', () => {
  it.each([{ width: 390, height: 844, surface: 'room' }, { width: 412, height: 915, surface: 'dm' }])(
    '$surface at $width: visual viewport, keyboard, standalone and zoom', async ({ width, height, surface }) => {
      const mobile = process.cwd();
      const shims = {
        ...webProofShims(mobile),
        '@/constants/Typography': 'export const Typography = { default: () => ({}) };',
        './speech-recognition-adapter': 'export const getRecognitionModule = () => null;',
        './speech-locale': "export const getDeviceSpeechLocale = () => 'en-US';",
        './speech-transcription': 'export const dictationTranscriptionAvailable = () => false; export const startDictationUpload = () => null; export const discardDictationRecordings = async () => {};',
      };
      const { result, status, stderr } = await runBrowserProof({ mobile, shims, width, height,
        entry: path.join(mobile, 'scripts/room-viewport-proof.tsx'), query: `?surface=${surface}`,
        head: '<style>html,body{height:100%;overflow:hidden}#root{height:100%;display:flex}#result{display:none}</style>' });
      expect(status, stderr).toBe(0);
      expect(result).toContain('RESULT PASS');
    }, 60_000,
  );
});
