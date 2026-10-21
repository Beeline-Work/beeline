import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from './browserProof';

/**
 * Reproduction R1 (stand-in) for TAIL-ARRIVAL-READ-DOT: a DM row whose newest
 * agent reply is unread must lose its dot once that reply is on screen at the
 * tail. The shipped Android app needs a signed-in Workspace this suite cannot
 * carry, so the scene drives the production row component, read-mark writer and
 * pinned-tail decision; see `scripts/unread-dot-clear-proof.tsx` for the exact
 * surface it stands in for.
 */
it.skipIf(!existsSync(CHROME))(
  'a DM reply finalising at the tail clears the row unread dot',
  async () => {
    const mobile = process.cwd();
    const shims = webProofShims(mobile);
    shims['@react-native-async-storage/async-storage'] =
      'export default { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };';
    shims['expo-font'] = 'export const isLoaded = () => true; export const loadAsync = async () => {};';
    shims['@/utils/responsive'] = 'export const useIsDesktop = () => innerWidth >= 768;';
    const proof = await runBrowserProof({
      entry: path.join(mobile, 'scripts/unread-dot-clear-proof.tsx'),
      mobile,
      shims,
      width: 900,
      budgetMs: 8000,
    });
    console.log(proof.result);
    expect(proof.status, proof.stderr).toBe(0);
    expect(proof.result).toMatch(/^PASS/);
  },
  120_000,
);
