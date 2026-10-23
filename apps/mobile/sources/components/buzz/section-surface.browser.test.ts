import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';
for (const theme of ['bone', 'obsidian'])
  for (const surface of ['sheet', 'page', 'repos', 'workbench', 'service'])
    it.skipIf(!existsSync(CHROME))(
      `R1: desktop ${theme} ${surface}`,
      async () => {
        const mobile = process.cwd(),
          shims = webProofShims(mobile);
        shims['react-native-unistyles'] = shims['react-native-unistyles'].replace(
          'beelineThemes.obsidian',
          `beelineThemes.${theme}`,
        );
        shims['react-native-reanimated'] +=
          '\nexport const FadeOut = FadeInDown; export const interpolateColor = (_, __, values) => values[0];';
        shims['expo-web-browser'] += '\nexport const openBrowserAsync = async () => {};';
        const fixture = readFileSync(path.join(mobile, 'surface-proof/fixtures.js'), 'utf8');
        for (const name of [
          '@/buzz/app-reconnect',
          '@/buzz/use-active-community',
          'expo-router',
          '@/buzz/workbench-source',
          '@/buzz/workbench-surface',
          '@/buzz/company-connection-actions',
          '@/buzz/latency-route-hook',
          '@/components/buzz/ServiceMark',
          '@/buzz/android-modal-navigation-bar',
          '@/buzz/use-text-draft',
        ])
          shims[name] = fixture;
        const head =
          '<style>' +
          [
            'SpaceGrotesk-Regular',
            'SpaceGrotesk-Medium',
            'SpaceGrotesk-SemiBold',
            'IBMPlexMono-Regular',
          ]
            .map(
              (font) =>
                `@font-face{font-family:${font};src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', font + '.ttf')).toString('base64')})}`,
            )
            .join('') +
          '</style>';
        const dir = process.env.SURFACE_SCREENSHOT_DIR;
        if (dir) mkdirSync(dir, { recursive: true });
        const proof = await runBrowserProof({
          mobile,
          entry: path.join(mobile, 'surface-proof/browser.tsx'),
          shims,
          head,
          width: 1280,
          height: 900,
          query: `?theme=${theme}&surface=${surface}`,
          screenshotPath: dir ? path.join(dir, `desktop-${theme}-${surface}.png`) : undefined,
        });
        expect(proof.status, proof.stderr).toBe(0);
        const result = JSON.parse(proof.result);
        expect(result.errors).toEqual([]);
        if (!process.env.SURFACE_BASELINE) {
          expect(result.fill).toBe('rgba(0, 0, 0, 0)');
          if (surface === 'repos')
            expect(result.rowFill).toBe(
              theme === 'bone' ? 'rgb(228, 217, 196)' : 'rgb(30, 19, 38)',
            );
        } else expect(result.fill).not.toBe('missing');
      },
      90000,
    );
