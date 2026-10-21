import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

it('Reproduction android-foreground-push-tap: the in-app notice and tap result in Obsidian and Bone', async () => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/foreground-push-toast-'));
  const evidence = path.join(mobile, 'evidence/android-foreground-push-tap');
  try {
    const entry = path.join(directory, 'proof.jsx');
    await writeFile(
      entry,
      `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { Text, View } from 'react-native';
      import { useUnistyles } from 'react-native-unistyles';
      import { ForegroundPushToast } from '@/components/buzz/ForegroundPushToast';
      import {
        presentForegroundPushNotice,
        resetForegroundPushNoticeForTests,
        setForegroundPushOpenHandler,
        tapForegroundPushNotice,
      } from '@/push/foreground-push-notice';
      import regularFont from '@/assets/fonts/SpaceGrotesk-Regular.ttf';
      import mediumFont from '@/assets/fonts/SpaceGrotesk-Medium.ttf';
      import semiboldFont from '@/assets/fonts/SpaceGrotesk-SemiBold.ttf';
      import monoFont from '@/assets/fonts/IBMPlexMono-Regular.ttf';
      const fontStyle = document.createElement('style');
      fontStyle.textContent = [[ 'SpaceGrotesk-Regular', regularFont ], [ 'SpaceGrotesk-Medium', mediumFont ],
        [ 'SpaceGrotesk-SemiBold', semiboldFont ], [ 'IBMPlexMono-Regular', monoFont ]]
        .map(([name, url]) => '@font-face{font-family:' + name + ';src:url(' + url + ')}').join('') + '#result{display:none}';
      document.head.appendChild(fontStyle);
      const phase = new URLSearchParams(location.search).get('phase');
      const notice = {
        identifier: 'msg-9',
        title: 'Beeline',
        body: 'hello from general',
        data: { channelId: 'room-general' },
      };
      function Proof() {
        const { theme } = useUnistyles();
        const [opened, setOpened] = React.useState(null);
        document.body.style.background = theme.buzz.bgBase;
        React.useEffect(() => {
          resetForegroundPushNoticeForTests();
          setForegroundPushOpenHandler((tapped) => setOpened(tapped.data.channelId));
          presentForegroundPushNotice(notice);
          if (phase === 'after-tap') tapForegroundPushNotice();
        }, []);
        const roomName = opened === 'room-general' ? '#general' : '#proof';
        return <div style={{width: 390, height: 844, position: 'relative', background: theme.buzz.bgBase, overflow: 'hidden'}}>
          <View style={{height: 160}} />
          <View style={{paddingHorizontal: 16, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: theme.buzz.border}}>
            <Text style={{...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary}}>{opened ? roomName : 'Rooms'}</Text>
          </View>
          {!opened ? ['#proof', '#general'].map((name) =>
            <View key={name} style={{padding: 16, borderBottomWidth: 1, borderBottomColor: theme.buzz.border}}>
              <Text style={{...theme.buzz.type.body, color: theme.buzz.textPrimary}}>{name}</Text>
            </View>
          ) : <View style={{padding: 16}}>
            <Text style={{...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet}}>That message is no longer available</Text>
          </View>}
          <ForegroundPushToast />
        </div>;
      }
      document.fonts.load('16px SpaceGrotesk-Regular').then(() =>
        createRoot(document.getElementById('root')).render(<Proof/>));
      setTimeout(() => {
        const plate = document.querySelector('[data-testid="foreground-push-notice"]');
        document.getElementById('result').textContent = JSON.stringify({
          phase,
          plate: plate ? plate.textContent : null,
          titleColor: plate && getComputedStyle(plate.querySelector('div,span,p') || plate).color,
          canvas: getComputedStyle(document.body).backgroundColor,
        });
      }, 1500);`,
    );
    for (const theme of ['obsidian', 'bone'] as const) {
      for (const phase of ['notice', 'after-tap'] as const) {
        const shims = webProofShims(mobile);
        shims['react-native-safe-area-context'] =
          'export const useSafeAreaInsets = () => ({ top: 47, bottom: 34, left: 0, right: 0 });';
        shims['react-native-unistyles'] = shims['react-native-unistyles']!.replace(
          'beelineThemes.obsidian',
          `beelineThemes.${theme}`,
        );
        const proof = await runBrowserProof({
          entry,
          mobile,
          width: 390,
          height: 844,
          query: `?phase=${phase}`,
          shims,
          screenshotPath: path.join(
            evidence,
            `${phase === 'notice' ? 'in-app-notice' : 'after-tap'}-web-${theme}.png`,
          ),
        });
        expect(proof.status, proof.stderr).toBe(0);
        const result = JSON.parse(proof.result);
        if (phase === 'notice') {
          expect(result.plate ?? '').toContain('Beeline');
          expect(result.plate ?? '').toContain('hello from general');
        } else {
          expect(result.plate).toBeNull();
        }
        console.log(
          `Reproduction android-foreground-push-tap Demonstrated ${theme} ${phase}: ${JSON.stringify(result)}`,
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
