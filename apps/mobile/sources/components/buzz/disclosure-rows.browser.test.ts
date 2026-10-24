import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

for (const system of [false, true])
  for (const width of [390, 1280])
    for (const theme of ['obsidian', 'bone']) {
      it.skipIf(!existsSync(CHROME))(
        `disclosure edges and touch targets: ${width}px ${theme}, system=${system}`,
        async () => {
          const mobile = process.cwd();
          const shims = webProofShims(mobile);
          shims['react-native-unistyles'] = shims['react-native-unistyles'].replace(
            'beelineThemes.obsidian',
            `beelineThemes.${theme}`,
          );
          shims['./ToolOutputSheet'] = 'export const ToolOutputSheet = () => null;';
          shims['react-native-reanimated'] +=
            '\nexport const FadeOut = FadeInDown; export const interpolateColor = (_, __, colors) => colors[1];';
          shims['expo-router'] = 'export const router = {}; export const useRouter = () => ({});';
          shims['@/components/buzz/HullDialog'] = 'export const HullDialogInput = () => null;';
          shims['./HullDialog'] = 'export const HullDialogActions = () => null;';
          shims['./MonoMarkdown'] = 'export const MonoMarkdown = () => null;';
          const screenshotDir = process.env.DISCLOSURE_SCREENSHOT_DIR;
          if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
          const fonts = [
            'SpaceGrotesk-Regular',
            'SpaceGrotesk-Medium',
            'SpaceGrotesk-SemiBold',
            'IBMPlexMono-Regular',
          ];
          const head = `<style>#root{width:${width}px}#result{display:none}body{background:${theme === 'bone' ? '#F3EEE4' : '#14091A'};color:${theme === 'bone' ? '#171310' : '#f0f0f3'}}${fonts.map((font) => `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', `${font}.ttf`)).toString('base64')})}`).join('')}</style>`;
          const proof = await runBrowserProof({
            entry: path.join(mobile, 'scripts/disclosure-rows-browser-proof.tsx'),
            mobile,
            shims,
            width,
            height: system ? (process.env.SYSTEM_OPENED === '1' ? 1500 : 500) : 2300,
            head,
            query: `?${theme}${process.env.DISCLOSURE_BEFORE === '1' ? '&before' : ''}${system ? '&system' : ''}${process.env.SYSTEM_BASELINE === '1' ? '&baseline' : ''}${process.env.SYSTEM_OPENED === '1' ? '&opened' : ''}`,
            screenshotPath: screenshotDir
              ? path.join(screenshotDir, `web-${width}-${theme}${system ? '-system' : ''}.png`)
              : undefined,
          });
          expect(proof.status, proof.stderr).toBe(0);
          expect(proof.result, proof.stderr).toContain(
            system ? 'PASS SYSTEM-FIRST-LINE' : 'PASS DISCLOSURE-EDGE',
          );
          if (system) {
            const metrics = JSON.parse(proof.result.slice('PASS SYSTEM-FIRST-LINE '.length));
            const baselinePath = path.join(
              mobile,
              `evidence/system-first-line/before/web-${width}-${theme}.json`,
            );
            if (process.env.SYSTEM_BASELINE === '1') {
              mkdirSync(path.dirname(baselinePath), { recursive: true });
              writeFileSync(baselinePath, JSON.stringify(metrics, null, 2) + '\n');
            } else {
              expect(metrics).toEqual(JSON.parse(readFileSync(baselinePath, 'utf8')));
            }
          }
        },
        90_000,
      );
    }
