import { beforeEach, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  state: 'active',
  appState: undefined as ((state: string) => void) | undefined,
  tasks: new Set<() => void>(),
}));
vi.mock('react-native', () => ({
  AppState: {
    get currentState() { return controls.state; },
    addEventListener: (_name: string, listener: (state: string) => void) => {
      controls.appState = listener;
      return { remove() {} };
    },
  },
  InteractionManager: { runAfterInteractions: (task: () => void) => {
    controls.tasks.add(task);
    return { cancel: () => { controls.tasks.delete(task); } };
  } },
}));
import { deferRoomWrite, roomTransitionWork } from './room-transition-work';

beforeEach(() => { controls.state = 'active'; controls.tasks.clear(); });

it('flushes the pending Room save when the app backgrounds during navigation', async () => {
  const end = roomTransitionWork.begin();
  const write = vi.fn(async () => {});
  const done = deferRoomWrite('room', write);
  expect(write).not.toHaveBeenCalled();
  controls.state = 'background';
  controls.appState?.('background');
  await done;
  expect(write).toHaveBeenCalledTimes(1);
  end();
});

it('also flushes a response that arrives after the background event', async () => {
  controls.state = 'background';
  const write = vi.fn(async () => {});
  await deferRoomWrite('room', write);
  expect(write).toHaveBeenCalledTimes(1);
  expect(controls.tasks.size).toBe(0);
});
