import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

/**
 * The shipped corner-open notices, offline band, Corner App failure and Task
 * Tray approval rows, rendered in Chrome at phone width in both themes and
 * read back from the DOM. With BEELINE_DESIGN_PROOF_DIR set each frame is
 * also saved as a screenshot for comparison with the approved mocks.
 */
const FRAMES = {
  'corners-pending': {
    'room-corners-add-busy': 1,
    // Started 4 s before paint; the row counts up while the page settles.
    'corner-open-row-pending': /^Opening corner…Waiting for server · [4-6]s$/,
    'corner-open-pending': null,
  },
  'corners-failed': {
    'corner-open-row-failed': 'Corner not openedNo response from server after 15s',
    'corner-open-failed': "Couldn't reach BeelineCheck your connection, then retry.Retry",
  },
  'room-list-pending': {
    'corner-open-pending': 'Opening corner…Still opening…',
  },
  'room-offline': {
    'room-saved-copy-notice':
      'Offline — showing the last saved response. TypeError: Network request failedRetry',
  },
  'corner-app-error': {
    'corner-app-screen': "Corner AppCould not load this app. Couldn't reach Beeline.",
  },
  tray: {
    'tray-approval-grant': 'BBC asks to run2dgit push --force-with-leasePush ledger fixes to feat/ledger.for Johnny · experiments / sec-filing-desk',
    'tray-approval-squire': 'Ruby needs your passkey for40mReveal GROQ_API_KEYWrite it into the Fly secret for push-gateway.Trusty Squire · expires in 20m',
    'tray-approval-choice': 'Candy asks you to choose1hShip the OTA tonight?Ship now · Wait for #2238 voice fixbeeline / release-corner · closes in 6h',
  },
} as const;

it('renders corner-open notices, the offline band, a Corner App failure and tray approval rows in both themes', async () => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/corner-open-tray-'));
  try {
    const entry = path.join(directory, 'proof.jsx');
    await writeFile(
      entry,
      `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { View, Text } from 'react-native';
      import { useUnistyles } from 'react-native-unistyles';
      import { RoomCornersHeader } from '@/components/buzz/RoomCornersHeader';
      import { CornerOpenRow, CornerOpenToast } from '@/components/buzz/CornerOpenToast';
      import { RoomSavedCopyNotice } from '@/components/buzz/RoomSavedCopyNotice';
      import { CornerAppScreen } from '@/components/buzz/CornerAppScreen';
      import { NeedsYouCell } from '@/components/buzz/NeedsYouCell';
      import { cornerOpenStarted, cornerOpenTappedAgain, cornerOpenUnreachable } from '@/buzz/corner-open-status';
      import regularFont from '@/assets/fonts/SpaceGrotesk-Regular.ttf';
      import mediumFont from '@/assets/fonts/SpaceGrotesk-Medium.ttf';
      import semiboldFont from '@/assets/fonts/SpaceGrotesk-SemiBold.ttf';
      import monoFont from '@/assets/fonts/IBMPlexMono-Regular.ttf';
      const fontStyle = document.createElement('style');
      fontStyle.textContent = [[ 'SpaceGrotesk-Regular', regularFont ], [ 'SpaceGrotesk-Medium', mediumFont ],
        [ 'SpaceGrotesk-SemiBold', semiboldFont ], [ 'IBMPlexMono-Regular', monoFont ]]
        .map(([name, url]) => '@font-face{font-family:' + name + ';src:url(' + url + ')}').join('') + '#result{display:none}';
      document.head.appendChild(fontStyle);
      const frame = new URLSearchParams(location.search).get('frame');
      const now = Date.now();
      if (frame === 'corners-pending') cornerOpenStarted('room-a', now - 4000);
      if (frame === 'corners-failed') cornerOpenUnreachable('room-a', true, () => undefined);
      if (frame === 'room-list-pending') { cornerOpenStarted('room-a', now); cornerOpenTappedAgain(); }
      const corner = (name, sub) => <View style={{flexDirection: 'row', gap: 10, padding: 14, paddingHorizontal: 16}}>
        <Text style={{fontFamily: 'SpaceGrotesk-SemiBold', fontSize: 16}}>{name}</Text></View>;
      const approval = (id, kind, actor, ask, subject, literal, detail, roomKind, roomName, parentRoomName, ageSeconds, extra = {}) => ({
        messageId: id, workspaceId: 'w', roomId: 'r-' + id, roomName, roomKind, parentRoomName,
        text: subject, createdAt: Math.floor(now / 1000) - ageSeconds,
        approval: { kind, actor, ask, subject, literal, ...(detail ? { detail } : {}), ...extra.approval },
        ...(extra.expiresAt ? { expiresAt: extra.expiresAt } : {}),
      });
      const tray = [
        approval('grant', 'grant', 'BBC', 'asks to run', 'git push --force-with-lease', true,
          'Push ledger fixes to feat/ledger.', 'corner', 'sec-filing-desk', 'experiments', 2 * 86400,
          { approval: { forName: 'Johnny' } }),
        approval('squire', 'squire', 'Ruby', 'needs your passkey for', 'Reveal GROQ_API_KEY', true,
          'Write it into the Fly secret for push-gateway.', 'direct', 'Trusty Squire', undefined, 40 * 60,
          { expiresAt: Math.floor(now / 1000) + 20 * 60 }),
        approval('choice', 'choice', 'Candy', 'asks you to choose', 'Ship the OTA tonight?', false,
          'Ship now · Wait for #2238 voice fix', 'corner', 'release-corner', 'beeline', 3600,
          { expiresAt: Math.floor(now / 1000) + 6 * 3600 }),
      ];
      function Proof() {
        const { theme } = useUnistyles();
        document.body.style.background = theme.buzz.bgTerminal;
        const ink = { color: theme.buzz.textPrimary, fontFamily: 'SpaceGrotesk-SemiBold', fontSize: 16 };
        const quiet = { color: theme.buzz.textMuted, fontFamily: 'SpaceGrotesk-Regular', fontSize: 13 };
        const existing = <View style={{padding: 16, borderBottomWidth: 1, borderColor: theme.buzz.border}}>
          <Text style={ink}>warm-notification-landing</Text><Text style={quiet}>Speedy · PR #2236</Text></View>;
        return <View style={{height: 640, backgroundColor: theme.buzz.bgTerminal}}>
          {(frame === 'corners-pending' || frame === 'corners-failed') && <>
            <RoomCornersHeader title="beeline" onBack={() => undefined} onAdd={() => undefined}
              busy={frame === 'corners-pending'} />
            <CornerOpenRow roomId="room-a" />
            {existing}
          </>}
          {frame === 'room-list-pending' && <>{existing}{existing}</>}
          {frame === 'room-offline' && <>
            <View style={{padding: 16, borderBottomWidth: 1, borderColor: theme.buzz.border}}><Text style={ink}>release-corner</Text></View>
            <RoomSavedCopyNotice message="Offline — showing the last saved response. TypeError: Network request failed" onRetry={() => undefined} />
            <View style={{padding: 16}}><Text style={quiet}>Candy · 20:48</Text><Text style={ink}>OTA promoted to production channel.</Text></View>
          </>}
          {frame === 'corner-app-error' && <CornerAppScreen onBack={() => undefined}
            unavailableMessage="Could not load this app. Couldn't reach Beeline." />}
          {frame === 'tray' && tray.map(item => <View key={item.messageId} testID={'tray-approval-' + item.messageId}>
            <NeedsYouCell item={item} now={now} desktop={false} onOpen={() => undefined} onDismiss={() => undefined} />
          </View>)}
          <CornerOpenToast />
        </View>;
      }
      createRoot(document.getElementById('root')).render(<Proof/>);
      setTimeout(() => {
        const read = {};
        for (const id of ${JSON.stringify(Object.values(FRAMES).flatMap((frame) => Object.keys(frame)))}) {
          const nodes = document.querySelectorAll('[data-testid="' + id + '"]');
          read[id] = nodes.length ? nodes[0].textContent : null;
          if (id === 'room-corners-add-busy') read[id] = nodes.length;
        }
        const mono = [...document.querySelectorAll('[data-testid^="tray-approval-"] *')]
          .filter(node => node.childElementCount === 0 && /IBMPlexMono/.test(getComputedStyle(node).fontFamily))
          .map(node => node.textContent);
        read.mono = mono;
        read.overflow = document.documentElement.scrollWidth > innerWidth;
        read.console = window.__console;
        document.getElementById('result').textContent = JSON.stringify(read);
      }, 1500);`,
    );
    for (const theme of ['obsidian', 'bone']) {
      for (const [frame, expected] of Object.entries(FRAMES)) {
        const shims = webProofShims(mobile);
        shims['react-native-unistyles'] = shims['react-native-unistyles']!.replace(
          'beelineThemes.obsidian',
          `beelineThemes.${theme}`,
        );
        // The tray cell's count hook reaches the session through its operation.
        shims['@/auth/monolith-session'] = 'export const monolithSession = {};';
        shims['react-native-gesture-handler'] = `import React from 'react';
          export const Swipeable = props => props.children;`;
        shims['@expo/vector-icons'] = 'export const Ionicons = () => null;';
        const proof = await runBrowserProof({
          entry,
          mobile,
          width: 390,
          height: 640,
          query: `?frame=${frame}`,
          shims,
          ...(process.env.BEELINE_DESIGN_PROOF_DIR
            ? {
                screenshotPath: path.join(
                  process.env.BEELINE_DESIGN_PROOF_DIR,
                  `corner-open-tray-${frame}-${theme}.png`,
                ),
              }
            : {}),
        });
        expect(proof.status, proof.stderr).toBe(0);
        const result = JSON.parse(proof.result);
        for (const [id, value] of Object.entries(expected)) {
          if (value instanceof RegExp) expect(result[id], id).toMatch(value);
          else expect(result[id], id).toBe(value);
        }
        expect(result.overflow).toBe(false);
        if (frame === 'tray')
          expect(result.mono).toEqual(['git push --force-with-lease', 'Reveal GROQ_API_KEY']);
        console.log(`Demonstrated ${frame} ${theme}: ${JSON.stringify(result)}`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 240_000);
