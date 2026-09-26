import React, { useState } from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ChatListItem } from '@beeline/buzz-client';
import { ConversationRow } from '../sources/components/buzz/ConversationRow';
import { cornerHref } from '../sources/buzz/corner-navigation';
import { openRoomListCorner } from '../sources/buzz/room-list-new-corner';

/**
 * Drives the REAL Room-list corner glyph in a browser through a real pointer
 * gesture:
 *
 * - a tap keeps its corner-list toggle and creates nothing;
 * - a >450ms press creates a named human corner through `openRoomListCorner`
 *   and opens it via the same `cornerHref` the phone deck passes to
 *   `router.push`;
 * - a press with no transport explains itself and opens nothing.
 *
 * The transport itself is the one stubbed edge (there is no monolith server in
 * a browser proof); the gesture handling, the row wiring, and the create→open
 * flow are the shipped modules.
 */

const now = Date.now();
const item = (id: string, name: string, cornerCount: number) =>
  ({
    room: { id, name, updatedAt: now / 1000 - 60 },
    unread: false,
    cornerCount,
    waitingCornerCount: 0,
    openCorners: [],
    latestMessage: {
      text: 'The new Room list is ready for your review.',
      createdAt: now / 1000 - 60,
      author: { pubkey: 'emberus', name: 'emberus', handle: 'emberus' },
    },
  }) as unknown as ChatListItem;

const lines: string[] = [];
function say(line: string) {
  lines.push(line);
  const result = document.getElementById('result');
  if (result) result.textContent = lines.join('\n');
}

type Calls = {
  create: Array<[string, string]>;
  opened: Array<[string, string]>;
  toggles: number;
  navigations: string[];
};

const calls: Calls = { create: [], opened: [], toggles: 0, navigations: [] };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function glyphFor(roomId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="room-${roomId}-corners"]`);
  if (!element) throw new Error(`no corner glyph for ${roomId}`);
  return element;
}

/**
 * A pointer press held past the row's 450ms long-press delay. The browser
 * fires a `click` after the release, and `PressResponder` suppresses `onPress`
 * for it — so a faithful gesture must dispatch that click too.
 */
async function longPress(roomId: string, holdMs = 600) {
  const glyph = glyphFor(roomId);
  glyph.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, buttons: 1 }));
  await sleep(holdMs);
  glyph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
  glyph.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  await sleep(80);
}

/** A quick pointer tap with no hold, including the browser's click. */
async function tap(roomId: string) {
  const glyph = glyphFor(roomId);
  glyph.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, buttons: 1 }));
  await sleep(30);
  glyph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
  glyph.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  await sleep(80);
}

function Probe({
  roomId,
  desktop,
  wired,
}: {
  roomId: string;
  desktop: boolean;
  wired: boolean;
}) {
  const { theme } = useUnistyles();
  const t = theme.buzz;
  const [expanded, setExpanded] = useState(false);
  return (
    <View testID={`row-${roomId}`} style={{ borderBottomWidth: 1, borderBottomColor: t.border }}>
      <ConversationRow
        item={item(roomId, roomId === 'room-a' ? 'Product' : 'Launch planning', 2)}
        viewer="you"
        now={now}
        desktop={desktop}
        cornersExpanded={expanded}
        onPress={() => undefined}
        onPin={() => undefined}
        onToggleCorners={() => {
          calls.toggles += 1;
          setExpanded((value) => !value);
        }}
        onLongPressCorners={
          wired
            ? () =>
                void openRoomListCorner({
                  roomId,
                  createCorner: async (id, title) => {
                    calls.create.push([id, title]);
                    return `corner-${id}`;
                  },
                  openCorner: (cornerId, title) => {
                    calls.opened.push([cornerId, title]);
                    calls.navigations.push(
                      JSON.stringify(cornerHref(cornerId, roomId, title, 'room-list')),
                    );
                  },
                })
            : undefined
        }
        testID={`room-${roomId}`}
      />
      <Text testID={`expanded-${roomId}`} style={{ ...t.type.meta, color: t.textSecondary }}>
        {expanded ? 'corners open' : 'corners closed'}
      </Text>
    </View>
  );
}

function Proof() {
  const { theme } = useUnistyles();
  return (
    <View style={{ flexDirection: 'row' }}>
      <View style={{ width: 360 }}>
        <Probe roomId="room-a" desktop={false} wired />
        <Probe roomId="room-b" desktop wired />
      </View>
      <View style={{ flex: 1, padding: 24 }}>
        <Text testID="opened" style={{ ...theme.buzz.type.body, color: theme.buzz.accent }}>
          {calls.opened.length ? `OPENED ${calls.opened[0]![1]}` : 'NOTHING OPENED'}
        </Text>
      </View>
    </View>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<Proof />);

function expectLine(name: string, actual: unknown, expected: unknown) {
  const passed = JSON.stringify(actual) === JSON.stringify(expected);
  say(`${passed ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(actual)}`);
  return passed;
}

async function run() {
  await sleep(50);

  // 1. A tap is still the corner-list toggle and creates nothing.
  await tap('room-a');
  expectLine('tap toggles and creates nothing', [calls.toggles, calls.create.length], [1, 0]);
  expectLine('tap leaves a corner unopened', calls.opened.length, 0);

  // 2. A real long press creates a named corner and opens it.
  await longPress('room-a');
  const created = calls.create[0] ?? ['', ''];
  expectLine('long press creates in the pressed Room', created[0], 'room-a');
  expectLine('created title is three words ending in corner', /^\w+ \w+ corner$/.test(created[1]), true);
  expectLine('long press opens the created corner', calls.opened, [
    ['corner-room-a', created[1]],
  ]);
  expectLine(
    'the opened corner is the pressed Room corner',
    calls.navigations[0],
    JSON.stringify(cornerHref('corner-room-a', 'room-a', created[1], 'room-list')),
  );
  expectLine('long press does not also toggle the list', calls.toggles, 1);

  // 3. The desktop row answers the same long press.
  await longPress('room-b');
  expectLine('desktop long press creates in that Room', calls.create[1]?.[0], 'room-b');
  expectLine('desktop long press opens its corner', calls.opened[1]?.[0], 'corner-room-b');

  // 4. With no transport the press explains itself and opens nothing.
  const openedBefore = calls.opened.length;
  const alerts = ((window as any).__alerts ||= []) as Array<[string, string]>;
  alerts.length = 0;
  await openRoomListCorner({ roomId: 'room-a', createCorner: null, openCorner: () => undefined });
  expectLine('no transport explains itself', alerts[0]?.[0], 'Not connected yet');
  expectLine('no transport opens nothing', calls.opened.length, openedBefore);

  // 5. A refused create is named and opens nothing.
  alerts.length = 0;
  await openRoomListCorner({
    roomId: 'room-a',
    createCorner: async () => {
      throw new Error('forbidden');
    },
    openCorner: () => undefined,
  });
  expectLine('a refused create is named', alerts[0], ['Could not open corner', 'forbidden']);
  expectLine('a refused create opens nothing', calls.opened.length, openedBefore);

  const openedElement = document.querySelector<HTMLElement>('[data-testid="opened"]');
  if (openedElement) {
    openedElement.textContent = calls.opened.length
      ? `OPENED ${calls.opened.map(([, title]) => title).join(', ')}`
      : 'NOTHING OPENED';
  }

  say(lines.every((line) => line.startsWith('PASS')) ? 'RESULT PASS' : 'RESULT FAIL');
}

void run();