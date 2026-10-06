import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';
for (const theme of ['obsidian', 'bone'])
  for (const width of [320, 1280])
    for (const large of [false, true]) {
      it.skipIf(!existsSync(CHROME))(
        `shows expandable two-line notices: ${theme}, ${width}px, large=${large}`,
        async () => {
          const mobile = process.cwd();
          const shims = webProofShims(mobile);
          shims['expo-router'] =
            'export const router = {}; export const useRouter = () => ({}); export const useLocalSearchParams = () => ({});';
          shims['./HullActionSheet'] =
            'export const HullActionSheetModal = () => null; export const HullActionSheetRow = () => null; export const HULL_SHEET_INSET = 22;';
          shims['react-native-unistyles'] = shims['react-native-unistyles']!.replace(
            'beelineThemes.obsidian',
            `beelineThemes.${theme}`,
          );
          const proof = await runBrowserProof({
            entry: path.join(mobile, 'scripts/system-lines-proof.tsx'),
            mobile,
            shims,
            width,
            query: `?${theme}${large ? '&large' : ''}`,
            screenshotPath: process.env.SYSTEM_LINES_SCREENSHOT_DIR
              ? path.join(
                  process.env.SYSTEM_LINES_SCREENSHOT_DIR,
                  `${theme}-${width}-${large ? 'large' : 'normal'}.png`,
                )
              : undefined,
          });
          console.log(proof.result);
          expect(proof.status, proof.stderr).toBe(0);
          expect(proof.result).toContain('PASS:');
        },
        90_000,
      );
    }
