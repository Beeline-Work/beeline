import React from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { GestureHandlerRootView, Swipeable } from 'react-native-gesture-handler';
import type { ChatListItem } from '@beeline/buzz-client';
import { ConversationRow } from '../sources/components/buzz/ConversationRow';
import { useRoomListGestures } from '../sources/buzz/use-room-list-gestures';

const item = {
  room: { id: 'proof-room', name: 'Product', updatedAt: 1 },
  unread: false,
} as ChatListItem;
const baseline = new URLSearchParams(location.search).has('baseline');
let reveals = 0;
let opens = 0;
let gestures: ReturnType<typeof useRoomListGestures>;
let swipe: Swipeable | null;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lines: string[] = [];
function check(name: string, passed: boolean) {
  lines.push(`${passed ? 'PASS' : 'FAIL'} ${name}`);
  document.getElementById('result')!.textContent = lines.join('\n');
}

function Proof() {
  gestures = useRoomListGestures();
  return (
    <GestureHandlerRootView style={{ width: 360 }}>
      <View {...gestures.touchHandlers}>
        <Swipeable
          ref={(value) => {
            swipe = value;
          }}
          {...(baseline
            ? {}
            : {
                enabled: gestures.swipesEnabled,
                activeOffsetX: [-15, 15],
                failOffsetY: [-10, 10],
              })}
          friction={1}
          rightThreshold={64}
          overshootRight={false}
          onSwipeableWillOpen={() => {
            reveals += 1;
          }}
          renderRightActions={() => (
            <View style={{ width: 64 }}>
              <Text>Leave</Text>
            </View>
          )}
        >
          <ConversationRow
            item={item}
            now={1000}
            onPin={() => undefined}
            onPress={() => {
              if (baseline || gestures.canInteract()) opens += 1;
            }}
            testID="proof-room"
          />
        </Swipeable>
      </View>
    </GestureHandlerRootView>
  );
}

async function drag(points: Array<[number, number]>) {
  const row = document.querySelector<HTMLElement>('[data-testid="proof-room"]')!;
  const box = row.getBoundingClientRect();
  // Synthetic pointers cannot acquire browser capture; dispatch every sample
  // on the same element while the real RNGH recognizer processes the events.
  row.setPointerCapture = () => undefined;
  row.releasePointerCapture = () => undefined;
  row.hasPointerCapture = () => true;
  const send = (type: string, dx: number, dy: number) =>
    row.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: box.left + 260 + dx,
        clientY: box.top + 20 + dy,
      }),
    );
  send('pointerdown', 0, 0);
  for (const [dx, dy] of points) {
    await pause(30);
    send('pointermove', dx, dy);
  }
  await pause(30);
  send('pointerup', ...points.at(-1)!);
  await pause(300);
}

createRoot(document.getElementById('root')!).render(<Proof />);
async function run() {
  await pause(200);
  await drag([
    [-12, 16],
    [-35, 30],
    [-110, 45],
  ]);
  check(
    'Reproduction room-list-diagonal: vertical diagonal drag reveals no swipe action',
    reveals === 0,
  );
  swipe?.close();
  await pause(300);
  const previous = reveals;
  await drag([
    [-20, 1],
    [-60, 2],
    [-110, 3],
  ]);
  check('Resting horizontal swipe reveals Leave', reveals > previous);
  swipe?.close();
  await pause(300);
  gestures.listHandlers.onMomentumScrollBegin();
  await pause(30);
  await drag([
    [-20, 1],
    [-60, 2],
    [-110, 3],
  ]);
  check('Coasting list rejects row swipe', reveals === previous + 1);
  const row = document.querySelector<HTMLElement>('[data-testid="proof-room"]')!;
  row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
  gestures.listHandlers.onMomentumScrollEnd();
  row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  gestures.touchHandlers.onTouchEnd();
  row.click();
  check('Reproduction room-list-coast: coast-stopping touch opens no Room', opens === 0);
  await pause(30);
  row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
  row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  row.click();
  check('Resting row tap opens immediately', opens === 1);
  lines.push(lines.some((line) => line.startsWith('FAIL')) ? 'RESULT FAIL' : 'RESULT PASS');
  document.getElementById('result')!.textContent = lines.join('\n');
}
void run().catch((error) => check(String(error), false));
