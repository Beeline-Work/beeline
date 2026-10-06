import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';
for (const theme of ['obsidian', 'bone'])
  for (const width of [390, 1280])
    for (const reduced of [false, true]) {
      it.skipIf(!existsSync(CHROME))(
        `CI-ACCORDION-1: ${theme} ${width}px reduced=${reduced}`,
        async () => {
          const mobile = process.cwd();
          const shims = webProofShims(mobile);
          shims['react-native-reanimated'] = shims['react-native-reanimated'].replace(
            'useReducedMotion = () => true',
            `useReducedMotion = () => ${reduced}`,
          );
          shims['react-native-unistyles'] = shims['react-native-unistyles'].replace(
            'beelineThemes.obsidian',
            `beelineThemes.${theme}`,
          );
          shims['expo-router'] =
            'export const router = {}; export const useRouter = () => ({}); export const useLocalSearchParams = () => ({});';
          shims['./HullActionSheet'] =
            'export const HullActionSheetModal = () => null; export const HullActionSheetRow = () => null; export const HULL_SHEET_INSET = 22;';
          const reproduce = process.env.CI_ACCORDION_REPRODUCE === '1';
          const proof = await runBrowserProof({
            entry: path.join(mobile, 'scripts/ci-accordion-proof.tsx'),
            mobile,
            shims,
            width,
            query: `?${theme}${reduced ? '&reduced' : ''}${reproduce ? '&reproduce' : ''}`,
            screenshotPath: process.env.CI_ACCORDION_SCREENSHOT_DIR
              ? path.join(
                  process.env.CI_ACCORDION_SCREENSHOT_DIR,
                  `${theme}-${width}-${reduced}.png`,
                )
              : undefined,
          });
          console.log(proof.result);
          expect(proof.status, proof.stderr).toBe(0);
          expect(proof.result, proof.stderr).toContain(
            reproduce ? 'Reproduction CI-ACCORDION-1' : 'PASS CI-ACCORDION-1',
          );
        },
        90_000,
      );
    }
