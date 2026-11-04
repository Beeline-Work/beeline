import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

// Regression: desktop audit — Escape dismissed Add-agent and left Members.
// Found by $qa on 2026-11-04.
// Report: apps/mobile/evidence/desktop-surface-audit/README.md
describe.skipIf(!existsSync(CHROME))('Escape with a directly mounted Hull sheet', () => {
  it('dismisses the actual web Modal before a later Escape navigates back', async () => {
    const mobile = process.cwd();
    const proof = await runBrowserProof({
      mobile, width: 1280, height: 840,
      entry: path.join(mobile, 'scripts/modal-escape-navigation-proof.tsx'),
      shims: {
        ...webProofShims(mobile),
        '@/modal': 'export const useModal = () => ({ dismissTopModal: () => false });',
        '@/sync/storage': 'export const storage = { getState: () => ({ localSettings: { zenMode: false } }) };',
        'expo-router': `const router = { canGoBack: () => true, back: () => { window.modalEscapeFacts.routeBacks += 1; } };
          export const useRouter = () => router;
          export const usePathname = () => '/members';
          export const useGlobalSearchParams = () => ({});`,
      },
    });
    expect(proof.status, proof.stderr).toBe(0);
    expect(JSON.parse(proof.result)).toEqual({
      backsOnKeyDown: 0, closes: 1, modalClosed: true, routeBacks: 1,
    });
  }, 90_000);
});
