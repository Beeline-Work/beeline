/**
 * Reproduction R1 (stand-in) for TAIL-ARRIVAL-READ-DOT.
 *
 * The user's real target is the shipped Android app: tap a DM row whose newest
 * message is an agent reply, and the row's unread dot must be gone when the
 * list shows again. This scene cannot carry a signed-in Android session, so it
 * exercises the exact mechanism the real screen uses, with the production
 * pieces rather than lookalikes:
 *
 * - `ConversationRow` is the shipped row component, drawn with the same
 *   `unread` input the server DTO feeds it;
 * - `ReadCursorAdvancer` is the shipped writer of the server read mark;
 * - `pinnedTailReadReport` is the shipped decision the chat surface now makes
 *   when an arrival changes the newest row under a reader already at the tail.
 *
 * Two runs start from the screenshot state — a DM row with an unread agent
 * reply, and a newer agent reply finalising while the DM is open at its tail.
 * The list's viewability pass does not run. The `stale` run sends no report
 * (the old surface), so the row's dot stays, which is the reported bug. The
 * `fixed` run sends the pinned-tail report, the advancer writes the mark, and
 * the row's dot clears.
 */
import React, { useEffect, useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { flushSync } from 'react-dom';
import { Text, View } from 'react-native';
import type { ChatListItem } from '@beeline/buzz-client';
import { ConversationRow } from '../sources/components/buzz/ConversationRow';
import { pinnedTailReadReport, ReadCursorAdvancer } from '../sources/buzz/read-cursor-advance';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';

const now = Math.floor(Date.now() / 1000);
const peer = { pubkey: 'niglet', kind: 'agent' as const, name: 'Niglet', handle: 'niglet' };

function row(unread: boolean): ChatListItem {
  return {
    room: { id: 'dm-niglet', name: 'Niglet', updatedAt: now },
    unread,
    directMessage: { peer },
    latestMessage: { id: 'reply', text: 'On it.', createdAt: now, author: peer },
  } as unknown as ChatListItem;
}

// The DM transcript as the phone holds it: an older read row, the reply that
// arrived while the reader was away, and the newer reply that finalises while
// the DM is open. The trailing live lane is provisional and must not be
// credited; the durable `reply` beneath it is the newest countable row.
const transcript: ChatDisplayMessage[] = [
  { id: 'older', text: 'Earlier.', isUser: false, timestamp: now - 600 },
  { id: 'reply', text: 'On it.', isUser: false, timestamp: now - 60 },
  { id: 'newer', text: 'Streaming…', isUser: false, timestamp: now, isAgentLiveTurn: true },
];

function Scene({ mode, report }: { mode: string; report: (value: boolean) => void }) {
  const [unread, setUnread] = useState(true);
  const unreadRef = React.useRef(unread);
  unreadRef.current = unread;
  useEffect(() => {
    const advancer = new ReadCursorAdvancer(() => {
      // The read mark reached the server; the list's next covering read paints
      // the same row read, exactly as a real read-mark invalidation does.
      setUnread(false);
    });
    if (mode === 'fixed') advancer.observe(transcript, pinnedTailReadReport(transcript));
    const settle = setTimeout(() => report(!unreadRef.current), 700);
    return () => {
      clearTimeout(settle);
      advancer.cancel();
    };
  }, []);
  return (
    <View testID={`scene-${mode}`} style={{ width: 360, padding: 12 }}>
      <Text testID={`${mode}-label`}>{mode}</Text>
      <ConversationRow item={row(unread)} now={now} onPress={() => {}} onPin={() => {}} testID={`${mode}-row`} />
    </View>
  );
}

const results: Record<string, boolean> = {};
flushSync(() =>
  createRoot(document.getElementById('root')!).render(
    <View style={{ flexDirection: 'row' }}>
      {(['stale', 'fixed'] as const).map((mode) => (
        <Scene
          key={mode}
          mode={mode}
          report={(cleared) => {
            results[mode] = cleared;
            if (Object.keys(results).length === 2) {
              // The old surface (no pinned-tail re-ask) leaves the dot lit; the
              // fix clears it. That difference IS the reproduction.
              const pass = results.stale === false && results.fixed === true;
              document.getElementById('result')!.textContent = `${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(
                results,
              )}`;
            }
          }}
        />
      ))}
    </View>,
  ),
);
