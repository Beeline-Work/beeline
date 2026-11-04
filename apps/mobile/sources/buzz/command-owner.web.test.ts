// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ sequence: 1 }));
vi.mock('@/utils/web-storage', () => ({ webRuntimeStorage: () => ({ storage: window.localStorage }) }));
vi.mock('react-native-mmkv', () => ({ MMKV: class { constructor() { throw new Error('Native storage used on web'); } } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length).fill(fixture.sequence++) }));
const state = () => ({ generation: 1, ready: true, commandDedupV1: true });
const committed = (operation: string, _args: unknown, command: { id: string }) => ({
  v: 1 as const, operation, commandId: command.id, state: 'committed' as const, result: { id: 'workspace' },
});
beforeEach(() => {
  fixture.sequence = 1; vi.resetModules(); window.localStorage.clear();
  let tail = Promise.resolve();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, _options: unknown, work: () => unknown) => {
    const next = tail.then(work); tail = next.then(() => undefined, () => undefined); return next;
  } } });
});
it('two browser writers preserve each other and a fresh tab adopts the original uncertain identity', async () => {
  const first = await import('./command-owner');
  const sendA = vi.fn().mockRejectedValue(new Error('receipt lost'));
  const ownerA = first.activateCommandOwner('https://beeline.test', 'viewer', { commandState: state, requestCommand: sendA });
  expect(ownerA.canPrepare()).toBe(true);
  vi.resetModules();
  const second = await import('./command-owner');
  const sendB = vi.fn(committed);
  const ownerB = second.activateCommandOwner('https://beeline.test', 'viewer', { commandState: state, requestCommand: sendB });
  const results = await Promise.allSettled([
    ownerA.execute('createWorkspace', { name: 'A' }), ownerB.execute('createWorkspace', { name: 'B' }),
  ]);
  expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
  const key = window.localStorage.key(0)!;
  expect(JSON.parse(window.localStorage.getItem(key)!).map((record: { state: string }) => record.state).sort()).toEqual(['committed', 'unknown']);
  vi.resetModules(); // Both tabs may close; localStorage and the command identity survive.
  const reloaded = await import('./command-owner');
  const resumed = vi.fn(committed);
  const owner = reloaded.activateCommandOwner('https://beeline.test', 'viewer', { commandState: state, requestCommand: resumed });
  await owner.negotiated();
  expect(resumed).toHaveBeenCalledOnce();
  expect(resumed.mock.calls[0]![2]).toEqual(sendA.mock.calls[0]![2]);
  expect(JSON.parse(window.localStorage.getItem(key)!).every((record: { state: string }) => record.state === 'committed')).toBe(true);
});
it('denied browser persistence prevents command transmission', async () => {
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  try {
    const { activateCommandOwner } = await import('./command-owner');
    const send = vi.fn(committed);
    const owner = activateCommandOwner('https://beeline.test', 'viewer', { commandState: state, requestCommand: send });
    await expect(owner.execute('createWorkspace', { name: 'A' })).rejects.toThrow('denied');
    expect(send).not.toHaveBeenCalled();
  } finally { write.mockRestore(); }
});
it('a browser without shared lock authority cannot select a raw write path', async () => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  const { activateCommandOwner } = await import('./command-owner');
  const send = vi.fn(committed);
  const owner = activateCommandOwner('https://beeline.test', 'viewer', { commandState: state, requestCommand: send });
  expect(owner.canPrepare()).toBe(false);
  await expect(owner.execute('createWorkspace', { name: 'A' })).rejects.toThrow('storage unavailable');
  expect(send).not.toHaveBeenCalled();
});

it('a stale tab cannot mint a new wallet identity around another tab\'s uncertain action', async () => {
  const first = await import('./command-owner');
  const sendA = vi.fn().mockRejectedValue(new Error('receipt lost'));
  const ownerA = first.activateCommandOwner('https://beeline.test', 'viewer', { commandState: state, requestCommand: sendA });
  vi.resetModules();
  const second = await import('./command-owner');
  const sendB = vi.fn(committed);
  const ownerB = second.activateCommandOwner('https://beeline.test', 'viewer', { commandState: state, requestCommand: sendB });
  const input = { amount: '1', to: 'synthetic' } as never;
  await expect(ownerA.execute('sendFromWallet', input)).rejects.toThrow('receipt lost');
  await expect(ownerB.execute('sendFromWallet', input)).rejects.toThrow('already pending in another tab');
  expect(sendB).not.toHaveBeenCalled();
  vi.resetModules();
  const adopted = await import('./command-owner');
  const sameIdentity = vi.fn(committed);
  const reloaded = adopted.activateCommandOwner('https://beeline.test', 'viewer', { commandState: state, requestCommand: sameIdentity });
  await reloaded.execute('sendFromWallet', input);
  expect(sameIdentity.mock.calls[0]![2]).toEqual(sendA.mock.calls[0]![2]);
});
