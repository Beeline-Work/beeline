import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

function composerDictationProofShims(mobile: string): Record<string, string> {
  return {
    ...webProofShims(mobile),
    '@/constants/Typography': 'export const Typography = { default: () => ({}) };',
    './speech-recognition-adapter': `import { speechProofRecognizer } from '${path.join(
      mobile,
      'scripts/composer-dictation-proof-recognizer',
    )}';
    export const getRecognitionModule = () => speechProofRecognizer.module;`,
    './speech-locale': "export const getDeviceSpeechLocale = () => 'en-US';",
  };
}

describe.skipIf(!existsSync(CHROME))('Composer dictation in a browser', () => {
  it('asks for the voice model in a Beeline dialog and keeps the newest words in view', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/composer-dictation-proof.tsx'),
      mobile,
      width: 420,
      shims: composerDictationProofShims(mobile),
    });
    expect(status, stderr).toBe(0);
    console.log(result);
    expect(result).toContain('RESULT PASS');
  }, 90_000);
});
