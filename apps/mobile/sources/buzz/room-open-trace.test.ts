import { describe, expect, it, vi, afterEach } from 'vitest';

/**
 * The point of this module is that it can be READ on a real phone. These tests
 * hold the two facts that matter: a release bundle stays silent by default, and
 * it speaks when the build flag is set.
 */
const load = async () => {
  vi.resetModules();
  return import('./room-open-trace');
};

const withEnv = async (value: string | undefined, isDev: boolean) => {
  const previousFlag = process.env.EXPO_PUBLIC_ROOM_OPEN_TRACE;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousVitest = process.env.VITEST;
  // The module treats a test environment as off, so this suite has to look
  // like the product to exercise the product's own branches.
  delete process.env.VITEST;
  process.env.NODE_ENV = 'production';
  if (value === undefined) delete process.env.EXPO_PUBLIC_ROOM_OPEN_TRACE;
  else process.env.EXPO_PUBLIC_ROOM_OPEN_TRACE = value;
  (globalThis as { __DEV__?: boolean }).__DEV__ = isDev;
  const mod = await load();
  const restore = () => {
    if (previousFlag === undefined) delete process.env.EXPO_PUBLIC_ROOM_OPEN_TRACE;
    else process.env.EXPO_PUBLIC_ROOM_OPEN_TRACE = previousFlag;
    process.env.NODE_ENV = previousNodeEnv ?? 'test';
    if (previousVitest !== undefined) process.env.VITEST = previousVitest;
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
  };
  return { mod, restore };
};

afterEach(() => vi.restoreAllMocks());

describe('room open trace', () => {
  it('stays silent in a release bundle when the flag is unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { mod, restore } = await withEnv(undefined, false);
    mod.markRoomOpen('room-read-start');
    mod.markRoomOpenWeight({ messages: [1], toolRows: [1], members: [], corners: [] });
    restore();
    expect(warn).not.toHaveBeenCalled();
  });

  it('emits from a release bundle when the build flag is set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { mod, restore } = await withEnv('1', false);
    mod.markRoomOpen('room-read-start');
    restore();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('"phase":"room-read-start"');
  });

  it('names what the read carried, so a slow Room says which part was heavy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { mod, restore } = await withEnv('1', false);
    mod.markRoomOpenWeight({
      messages: [1, 2, 3],
      toolRows: [1, 2],
      members: [1, 2, 3, 4],
      corners: [1],
    });
    restore();
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('"phase":"room-read-weight"');
    expect(line).toContain('"messages":3');
    expect(line).toContain('"toolRows":2');
    expect(line).toContain('"members":4');
    expect(line).toContain('"corners":1');
    expect(line).toContain('"bytes":');
  });
});
