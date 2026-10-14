import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

it.skipIf(!existsSync(CHROME))('desktop-voice-gate-1: existing composer enters and ends Conversation in Chrome', async () => {
  const mobile = process.cwd();
  const { result, status, stderr } = await runBrowserProof({
    mobile, entry: path.join(mobile, 'scripts/composer-desktop-voice-entry-proof.tsx'),
    width: 1280, budgetMs: 6000,
    shims: {
      ...webProofShims(mobile),
      '@/constants/Typography': 'export const Typography = { default: () => ({}) };',
      '@/buzz/speech-input': `export const useSpeechInput = () => ({ capability: 'available', state: 'idle',
        partialText: '', volumeLevel: 0, modelDownloadOffered: false,
        start: () => { globalThis.__dictationStarts = (globalThis.__dictationStarts || 0) + 1; },
        stop: async () => null, cancel() {}, acceptModelDownload() {}, declineModelDownload() {} });`,
    },
  });
  console.log(result);
  expect(status, stderr).toBe(0);
  expect(result).toContain('RESULT PASS');
}, 90_000);
