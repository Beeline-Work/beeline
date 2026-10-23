import { expect, it, vi } from 'vitest';
const controls = vi.hoisted(() => ({ pending: [] as Array<() => Promise<void>>, writes: vi.fn() }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
  getString() { return undefined; }
  set(key: string, value: string) { controls.writes(key, value); }
  delete() {}
  getAllKeys() { return []; }
} }));
vi.mock('./identity-records', () => ({ selectIdentities: (_address: unknown, value: unknown) => value }));
vi.mock('./room-transition-work', () => ({ deferRoomWrite: (_key: string, work: () => Promise<void>) =>
  new Promise<void>((resolve, reject) => { controls.pending.push(() => work().then(resolve, reject)); }),
}));
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';

it('defers Room serialization while preserving immediate saves for other surfaces', async () => {
  const guard = vi.fn((value: unknown): value is { count: number } =>
    typeof value === 'object' && value !== null && 'count' in value);
  const address = (endpoint: string) => surfaceAddress('https://relay.test', 'viewer', endpoint);
  const room = mobileSurfaceCache.write(address('/room/busy'), { count: 1 }, guard);
  expect(guard).not.toHaveBeenCalled();
  expect(controls.writes).not.toHaveBeenCalled();
  await mobileSurfaceCache.write(address('/workspaces'), { count: 2 }, guard);
  await mobileSurfaceCache.write(address('/room/busy/schedules'), { count: 3 }, guard);
  expect(controls.writes).toHaveBeenCalledTimes(2);
  expect(controls.pending).toHaveLength(1);
  await controls.pending[0]!();
  await room;
  expect(controls.writes).toHaveBeenCalledTimes(3);
});
