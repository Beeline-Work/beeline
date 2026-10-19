import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

describe.skipIf(!existsSync(CHROME))('R1: request answer reaches the visible composer', () => {
  it('prefills Charles only for the human whose message woke him', async () => {
    const mobile = process.cwd();
    const shims = webProofShims(mobile);
    shims['@/constants/Typography'] = 'export const Typography = { default: () => ({}) };';
    shims['@/buzz/speech-input'] = `export const useSpeechInput = () => ({
      capability: 'unavailable', state: 'idle', partialText: '', volumeLevel: 0,
      modelDownloadOffered: false, start() {}, stop: async () => '', cancel() {},
      acceptModelDownload() {}, declineModelDownload() {} });`;
    const evidence = path.join(mobile, 'evidence/answer-prefill');
    mkdirSync(evidence, { recursive: true });
    const { result, status, stderr } = await runBrowserProof({ mobile, shims,
      width: 720, height: 500, budgetMs: 2500,
      entry: path.join(mobile, 'scripts/answer-prefill-proof.tsx'),
      screenshotPath: path.join(evidence, `${process.env.PREFILL_PROOF_STAGE ?? 'after'}.png`),
      head: '<script>window.addEventListener("error", e => document.getElementById("result").textContent = e.message);</script><style>body{background:#14091A;color:#f0f0f3;font-family:sans-serif}section{padding:16px}</style>',
    });
    console.log(result);
    expect(status, stderr).toBe(0);
    expect(result).toContain('RESULT PASS');
  }, 90_000);
});
