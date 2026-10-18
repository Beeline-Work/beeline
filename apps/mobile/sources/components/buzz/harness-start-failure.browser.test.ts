import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

it.skipIf(!existsSync(CHROME))(
  'harness-node-missing-path: renders the actionable failure in the Room ledger',
  async () => {
    const mobile = process.cwd();
    const shims = webProofShims(mobile);
    shims['expo-router'] =
      'export const router = {}; export const useRouter = () => ({}); export const useLocalSearchParams = () => ({});';
    shims['./HullActionSheet'] =
      'export const HullActionSheetModal = () => null; export const HullActionSheetRow = () => null; export const HULL_SHEET_INSET = 22;';
    const proof = await runBrowserProof({
      entry: path.join(mobile, 'scripts/harness-start-failure-proof.tsx'),
      mobile,
      shims,
      width: 320,
    });
    console.log(proof.result);
    expect(proof.status, proof.stderr).toBe(0);
    expect(proof.result).toContain('PASS: harness-node-missing-path');
  },
  90_000,
);
