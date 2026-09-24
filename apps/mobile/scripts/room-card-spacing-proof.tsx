import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ChatListItem } from '@beeline/buzz-client';
// @ts-expect-error Supplied by the browser test as a shim: font name -> base64 TTF.
import fonts from 'room-card-fonts';
import { ConversationRow } from '../sources/components/buzz/ConversationRow';
import { RoomCornerSummary } from '../sources/components/buzz/RoomCornerSummary';

/**
 * Mobile Room list cards as the Room list draws them: the card surface around
 * the real row, with and without the corner summary. Reports the ink gap from
 * the card's inner top edge to the Room name's cap line, and from the last
 * line's baseline to the card's inner bottom edge, in the app's own fonts.
 * The desktop row (no card) reports the same two gaps so a change to it shows.
 */
const now = Date.now();
const item = (
  id: string,
  name: string,
  text: string,
  unread: boolean,
  cornerCount = 0,
  peer?: object,
) =>
  ({
    room: { id, name, updatedAt: now / 1000 - 120 },
    unread,
    cornerCount,
    waitingCornerCount: 0,
    latestMessage: {
      text,
      createdAt: now / 1000 - 120,
      author: { pubkey: 'bbc', name: 'bbc', handle: 'bbc' },
    },
    ...(peer ? { directMessage: { peer } } : {}),
  }) as unknown as ChatListItem;
const cards = [
  item('one-line', 'Design', 'Quiet header.', false),
  item(
    'two-line',
    'Engineering',
    'The changes are in. Tests passed and the release notes are ready for the Friday launch.',
    true,
  ),
  item('corners', 'Product', 'The new Room list is ready.', false, 3),
  item('message', 'Mina', 'See you tomorrow.', false, 0, {
    pubkey: 'mina',
    name: 'Mina',
    kind: 'human',
  }),
];

function Card({ entry, desktop }: { entry: ChatListItem; desktop: boolean }) {
  const { theme } = useUnistyles();
  const t = theme.buzz;
  const row = (
    <ConversationRow
      item={entry}
      viewer="you"
      now={now}
      desktop={desktop}
      onPress={() => undefined}
      onPin={() => undefined}
      testID={`room-${entry.room.id}`}
    />
  );
  if (desktop) return <View testID={`card-${entry.room.id}`}>{row}</View>;
  // channels.tsx rowSurface + roomCell: the card owns the fill, border, and inset.
  return (
    <View style={{ paddingHorizontal: t.roomCard.inset, paddingBottom: t.roomCard.gap }}>
      <View
        testID={`card-${entry.room.id}`}
        style={{
          backgroundColor: t.bgRaised,
          borderWidth: 1,
          borderColor: t.border,
          borderRadius: t.roomCard.cornerRadius,
          overflow: 'hidden',
        }}
      >
        {row}
        {!entry.directMessage && !!entry.cornerCount && (
          <RoomCornerSummary
            count={entry.cornerCount}
            onPress={() => undefined}
            testID={`room-corners-toggle-${entry.room.id}`}
          />
        )}
      </View>
    </View>
  );
}

const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};

/** Baseline of the line at `lineTop`, as CSS places it inside its line box. */
function baseline(node: HTMLElement, lineTop: number) {
  const style = getComputedStyle(node);
  const context = document.createElement('canvas').getContext('2d')!;
  // Canvas rounds metrics to whole pixels; measure at 1000px and scale down.
  context.font = `${style.fontWeight} 1000px ${style.fontFamily}`;
  const metrics = context.measureText('H');
  const scale = parseFloat(style.fontSize) / 1000;
  const ascent = metrics.fontBoundingBoxAscent * scale;
  const content = ascent + metrics.fontBoundingBoxDescent * scale;
  const lineHeight = parseFloat(style.lineHeight);
  return {
    baseline: lineTop + (lineHeight - content) / 2 + ascent,
    cap: metrics.actualBoundingBoxAscent * scale,
  };
}

function measure(id: string) {
  const card = document.querySelector<HTMLElement>(`[data-testid="card-${id}"]`)!;
  const box = card.getBoundingClientRect();
  const innerTop = box.top + card.clientTop;
  const innerBottom = innerTop + card.clientHeight;
  const name = document
    .querySelector<HTMLElement>(`[data-testid="room-${id}"]`)!
    .querySelector<HTMLElement>(`div[dir="auto"]:not([data-testid])`)!;
  const nameLine = baseline(name, name.getBoundingClientRect().top);
  const toggle = document.querySelector<HTMLElement>(`[data-testid="room-corners-toggle-${id}"]`);
  const last = toggle
    ? toggle.querySelector<HTMLElement>('div[dir="auto"]')!
    : document.querySelector<HTMLElement>(`[data-testid="room-${id}-preview"]`)!;
  const lastBox = last.getBoundingClientRect();
  const lastLine = baseline(last, lastBox.bottom - parseFloat(getComputedStyle(last).lineHeight));
  return {
    above: nameLine.baseline - nameLine.cap - innerTop,
    below: innerBottom - lastLine.baseline,
  };
}

async function run() {
  for (const [family, data] of Object.entries(fonts as Record<string, string>)) {
    const face = new FontFace(family, `url(data:font/ttf;base64,${data})`);
    document.fonts.add(await face.load());
  }
  const desktop = innerWidth >= 768;
  createRoot(document.getElementById('root')!).render(
    <View style={{ width: desktop ? 380 : innerWidth }}>
      {cards.map((entry) => (
        <Card key={entry.room.id} entry={entry} desktop={desktop} />
      ))}
    </View>,
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  let pass = true;
  const lines = cards.map((entry) => {
    const { above, below } = measure(entry.room.id);
    if (!desktop) pass &&= Math.abs(above - below) <= 1;
    return `${entry.room.id}: above=${above.toFixed(2)} below=${below.toFixed(2)} diff=${(above - below).toFixed(2)}`;
  });
  report(`${desktop ? 'DESKTOP' : pass ? 'PASS' : 'FAIL'}\n${lines.join('\n')}`);
}

run().catch((error) => report(`FAIL ${String(error)}`));
