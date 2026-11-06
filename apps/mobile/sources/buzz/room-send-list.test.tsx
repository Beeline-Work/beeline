import { afterEach, expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
vi.mock('react-native', () => ({ FlatList: () => null, View: () => null }));
import { RoomSendPreview } from './room-send-list';

const message = (id: string): ChatDisplayMessage => ({ id, text: 'Complete first frame', timestamp: 1, isUser: true });
afterEach(() => vi.unstubAllGlobals());

it('releases preparation after layout and a painted host frame, without a timer', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  const preview = new RoomSendPreview();
  let completed = false;
  const painted = preview.show(message('pending')).then(() => { completed = true; });
  expect(preview.snapshot()?.message.text).toBe('Complete first frame');
  expect(frames).toHaveLength(0);
  preview.laidOut('pending');
  frames.shift()!(0);
  await Promise.resolve();
  expect(completed).toBe(false);
  frames.shift()!(16);
  await painted;
  expect(preview.snapshot()?.painted).toBe(true);
});

it('settles a departing visit and keeps its delayed layout out of the next preview', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  const preview = new RoomSendPreview();
  const first = preview.show(message('first'));
  preview.laidOut('first');
  preview.dispose();
  await first;
  preview.activate();
  const second = preview.show(message('second'));
  frames.shift()!(0);
  frames.shift()!(16);
  await Promise.resolve();
  expect(preview.snapshot()?.message.id).toBe('second');
  expect(preview.snapshot()?.painted).toBe(false);
  preview.remove('second');
  await second;
});
