import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from './browserProof';

/** Reproduction R1: anchored newest corner card clears the rendered DM dot. */
it.skipIf(!existsSync(CHROME))(
  'R1: an anchored corner card clears the unread dot at the tail',
  async () => {
    const mobile = process.cwd();
    const shims = webProofShims(mobile);
    shims['@react-native-async-storage/async-storage'] =
      'export default { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };';
    shims['expo-font'] = 'export const useFonts = () => [true, null]; export const isLoaded = () => true; export const loadAsync = async () => {};';
    shims['@/utils/responsive'] = 'export const useIsDesktop = () => innerWidth >= 768;';
    const proof = await runBrowserProof({
      entry: path.join(mobile, 'scripts/anchored-corner-unread-proof.tsx'),
      mobile,
      shims,
      width: 1320,
      budgetMs: 8000,
    });
    console.log(proof.result);
    expect(proof.status, proof.stderr).toBe(0);
    expect(proof.result).toMatch(/^PASS/);
  },
  120_000,
);
