import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';
for (const width of [390, 1280])
  for (const reduced of [false, true]) {
    it.skipIf(!existsSync(CHROME))(
      `EVENT-ROWS-V2: ${width}px reduced=${reduced}`,
      async () => {
        const mobile = process.cwd();
        const shims = webProofShims(mobile);
        shims['react-native-reanimated'] = shims['react-native-reanimated'].replace(
          'useReducedMotion = () => true',
          `useReducedMotion = () => ${reduced}`,
        );
        shims['expo-router'] = 'export const router = {}; export const useRouter = () => ({}); export const useLocalSearchParams = () => ({});';
        shims['./HullActionSheet'] = 'export const HullActionSheetModal = () => null; export const HullActionSheetRow = () => null; export const HULL_SHEET_INSET = 22;';
        const proof = await runBrowserProof({
          entry: path.join(mobile, 'scripts/pr-accordion-proof.tsx'),
          mobile,
          shims,
          width,
          query: reduced ? '?reduced' : '',
          screenshotPath: process.env.PR_ACCORDION_SCREENSHOT_DIR
            ? path.join(process.env.PR_ACCORDION_SCREENSHOT_DIR, `${width}-${reduced}.png`)
            : undefined,
        });
        expect(proof.status, proof.stderr).toBe(0);
        expect(proof.result, proof.stderr).toContain('PASS EVENT-ROWS-V2');
      },
      90_000,
    );
  }
