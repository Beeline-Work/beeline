import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { FlatList } from 'react-native';
import { LedgerSteer } from '../sources/components/buzz/Ledger';
import { useRoomMessageRenderItem } from '../sources/buzz/room-message-cell';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';

const chronological = new URLSearchParams(location.search).get('direction') === 'chronological';
const messages: ChatDisplayMessage[] = Array.from({ length: 48 }, (_, index) => ({
  id: `message-${index}`,
  text: `Transcript message ${index}`,
  isUser: true,
  timestamp: new Date(2026, 8, 10 + Math.floor(index / 6), 12, index % 6).getTime() / 1000,
}));
const preceding = new Map(messages.slice(1).map((message, index) => [message.id, messages[index]]));
const byId = new Map(messages.map((message) => [message.id, message]));
const render = (item: ChatDisplayMessage) => (
  <LedgerSteer
    itemId={item.id}
    bodyText={item.text}
    bodyTestID={`${item.id}-body`}
    chronological={chronological}
  />
);

function Transcript() {
  const renderItem = useRoomMessageRenderItem({
    render,
    continuedIds: new Set(),
    precedingMessageById: preceding,
    messageById: byId,
  });
  return (
    <FlatList
      testID="transcript"
      style={{ height: 320, flexGrow: 0 }}
      data={chronological ? messages : [...messages].reverse()}
      inverted={!chronological}
      renderItem={renderItem}
      keyExtractor={(item) => item.id}
      initialNumToRender={12}
      windowSize={3}
    />
  );
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
createRoot(document.getElementById('root')!).render(<Transcript />);
async function measure() {
  await pause();
  const list = document.querySelector<HTMLElement>('[data-testid="transcript"]')!;
  assert(list.scrollHeight > list.clientHeight, 'transcript must scroll');
  const caption = document.querySelector<HTMLElement>('[data-testid="ledger-day-caption"]')!;
  const body = caption.parentElement!.querySelector<HTMLElement>('[data-testid^="chat-message-"]')!;
  const rects = () => ({
    caption: caption.getBoundingClientRect(),
    body: body.getBoundingClientRect(),
  });
  const start = rects();
  assert(start.caption.height > 0 && start.body.height > 0, 'measure real caption and body');
  assert(start.caption.bottom <= start.body.top + 1, 'caption must precede its message');
  // A windowed list refines its content height once, as it measures real rows
  // instead of estimates. That first settle is the list working correctly; what
  // must not happen is the height moving again on every later scroll, which is
  // what reflowing captions would cause. So re-baseline after the first step
  // and hold the height fixed from there.
  let height = list.scrollHeight;
  let settled = false;
  const startOffset = list.scrollTop;
  for (const offset of [80, 180, 80, 0]) {
    list.scrollTop = offset;
    await pause();
    const current = rects();
    const expectedTop = start.body.top + (chronological ? -1 : 1) * (list.scrollTop - startOffset);
    assert(
      Math.abs(current.body.top - expectedTop) < 1,
      'message moved beyond the scroll displacement',
    );
    assert(Math.abs(current.body.height - start.body.height) < 1, 'body height changed');
    assert(Math.abs(current.caption.height - start.caption.height) < 1, 'caption height changed');
    assert(
      Math.abs(current.body.top - current.caption.top - (start.body.top - start.caption.top)) < 1,
      'caption shifted relative to message',
    );
    if (!settled) {
      height = list.scrollHeight;
      settled = true;
    } else {
      assert(
        Math.abs(list.scrollHeight - height) < 1,
        `transcript height changed on scroll: ${height} -> ${list.scrollHeight}`,
      );
    }
    if (offset === 80)
      assert(Math.abs(current.body.top - start.body.top) > 1, 'scroll must move the measured cell');
  }
  const end = rects();
  assert(
    Math.abs(end.body.top - start.body.top) < 1,
    'message failed to return to its measured position',
  );
  document.getElementById('result')!.textContent = 'PASS';
}
measure().catch((error) => {
  document.getElementById('result')!.textContent = String(error);
});
