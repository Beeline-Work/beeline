import React from 'react';
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
        for (const id of ["room-corners-add-busy","corner-open-row-pending","corner-open-pending","corner-open-row-failed","corner-open-failed","corner-open-pending","room-saved-copy-notice","corner-app-screen","tray-approval-grant","tray-approval-squire","tray-approval-choice"]) {
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
      }, 1500);