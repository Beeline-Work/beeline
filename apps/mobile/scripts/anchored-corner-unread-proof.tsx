/**
 * Reproduction R1 stand-in: the owner/Ruby production DM is not signed in on
 * this isolated checkout (adb has no attached device). Exercise the shipped
 * row, marker renderer, anchoring and read writer in a browser instead.
 * Only a cursor reaching the newest card clears the simulated server DTO.
 */
import React, { useEffect, useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { flushSync } from 'react-dom';
import { Text, View } from 'react-native';
import type { ChatListItem } from '@beeline/buzz-client';
import { ConversationRow } from '../sources/components/buzz/ConversationRow';
import { CornerOpenedMarkers } from '../sources/components/buzz/CornerOpenedMarker';
import { anchorCornerMarkers } from '../sources/buzz/corner-markers';
import { foldPrLifecycleRuns } from '../sources/buzz/pr-lifecycle';
import { pinnedTailReadReport, ReadCursorAdvancer } from '../sources/buzz/read-cursor-advance';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';

const peer = { pubkey: 'ruby', kind: 'agent' as const, name: 'Ruby', handle: 'ruby' };
const card: ChatDisplayMessage = {
  id: 'corner', text: '@ruby opened a corner welcome-video-onboarding', isUser: false, timestamp: 4,
  daemonFact: { type: 'corner-open', sourceMessageId: 'source', cornerId: 'welcome', name: 'welcome-video-onboarding', objective: '' },
};
const originalTranscript = anchorCornerMarkers([
  { id: 'source', text: 'Go on all…', isUser: true, timestamp: 1 },
  { id: 'middle', text: 'Earlier reply', isUser: false, timestamp: 2 },
  { id: 'tail', text: 'Last ordinary reply', isUser: false, timestamp: 3 },
  card,
]);
const modes = ['tail', 'host', 'middle', 'cold', 'folded', 'tie', 'after'] as const;
type Mode = typeof modes[number];
const results: Record<string, unknown> = {};

function Scene({ mode }: { mode: Mode }) {
  const isFolded = mode === 'folded' || mode === 'tie' || mode === 'after';
  const markerTime = mode === 'tie' ? 3900 : mode === 'after' ? 3950 : 3500;
  const marker = { ...card, id: mode === 'tie' ? 'aaa' : card.id, timestamp: 3, orderAtMs: markerTime };
  const lifecycle = (id: string, orderAtMs: number): ChatDisplayMessage => ({
    id, text: 'PR opened', isUser: false, timestamp: 3, orderAtMs,
    githubEvent: { type: 'pull-request', action: 'opened', actor: 'GitHub', title: 'Checks', url: 'https://github.com/test/repo/pull/1' },
  });
  const transcript = isFolded ? foldPrLifecycleRuns(anchorCornerMarkers([
    originalTranscript[0]!, lifecycle('first', 3000), marker, lifecycle('latest', 3900),
  ])) : originalTranscript;
  const newest = isFolded && mode !== 'after' ? 'latest' : card.id;
  const [unread, setUnread] = useState(true);
  useEffect(() => {
    const initiallyUnread = Boolean(document.querySelector(`[data-testid="${mode}-row-unread"]`));
    const published: string[] = [];
    const advancer = new ReadCursorAdvancer(id => {
      published.push(id);
      if (id === newest) setUnread(false);
    });
    if (isFolded && mode !== 'after') advancer.seed(marker.id);
    const visible = mode === 'host' ? transcript.slice(0, 2)
      : mode === 'middle' ? [transcript[1]!]
      : pinnedTailReadReport(transcript, { pinnedToTail: true, landing: false, hasObservedVisibility: mode !== 'cold' });
    advancer.observe(transcript, visible);
    const settle = setTimeout(() => {
      const dot = Boolean(document.querySelector(`[data-testid="${mode}-row-unread"]`));
      const marker = document.querySelector(`[data-testid="scene-${mode}"] [data-testid="corner-opened-marker-welcome"]`);
      const expectedDot = mode === 'middle' || mode === 'cold';
      const expectedId = mode === 'middle' ? 'middle' : mode === 'cold' ? undefined : newest;
      results[mode] = { initiallyUnread, dot, markerVisible: Boolean(marker), published };
      results[`${mode}Pass`] = initiallyUnread && dot === expectedDot && Boolean(marker) && published.at(-1) === expectedId;
      if (modes.every(value => `${value}Pass` in results)) {
        const pass = modes.every(value => results[`${value}Pass`]);
        document.getElementById('result')!.textContent = `${pass ? 'PASS' : 'FAIL'} R1 ${JSON.stringify(results)}`;
      }
    }, 700);
    return () => { clearTimeout(settle); advancer.cancel(); };
  }, []);
  const item = {
    room: { id: 'dm-ruby', name: 'Ruby', updatedAt: 4 }, unread, directMessage: { peer },
    latestMessage: { id: newest, text: newest === 'latest' ? 'PR opened' : card.text, createdAt: card.timestamp, author: peer },
  } as unknown as ChatListItem;
  return <View testID={`scene-${mode}`} style={{ width: 320 }}>
    <Text>{mode}</Text>
    <ConversationRow item={item} now={4} onPress={() => {}} onPin={() => {}} testID={`${mode}-row`} />
    <Text>{transcript[0]!.text}</Text>
    <CornerOpenedMarkers message={transcript[0]!} onOpenCorner={() => {}} onOpenUrl={() => {}} />
    {transcript.slice(1).map(message => <Text key={message.id}>{message.text}</Text>)}
  </View>;
}
flushSync(() => createRoot(document.getElementById('root')!).render(
  <View style={{ flexDirection: 'row' }}>{modes.map(mode => <Scene key={mode} mode={mode} />)}</View>,
));
