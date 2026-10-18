import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUntaggedMessageHints } from './use-untagged-message-hints';

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), values: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));
beforeEach(() => {
  storage.values.clear();
  storage.getItem.mockReset().mockImplementation(async (key: string) => storage.values.get(key) ?? null);
  storage.setItem.mockReset().mockImplementation(async (key: string, value: string) => { storage.values.set(key, value); });
});
async function flush() { await act(async () => {}); }

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const trees: any[] = [];
const defaults = { roomId: 'general', viewerPubkey: 'sender', viewerKind: 'human' as const, hasAgentMembers: true };
function mount(initial: Partial<Parameters<typeof useUntaggedMessageHints>[0]> = {}) {
  let api!: ReturnType<typeof useUntaggedMessageHints>;
  function Probe(props: Parameters<typeof useUntaggedMessageHints>[0]) {
    api = useUntaggedMessageHints(props);
    return <>{[...api.hintMessageIds].map(id => <span key={id}>{id}: No agent was tagged</span>)}</>;
  }
  let props = { ...defaults, ...initial };
  let tree: any;
  act(() => { tree = create(<Probe {...props} />); });
  trees.push(tree);
  return {
    get api() { return api; },
    hints: () => tree.root.findAllByType('span').map((n: any) => n.props.children),
    update: (next: Partial<typeof props>) => { props = { ...props, ...next }; act(() => tree.update(<Probe {...props} />)); },
    send: (id: string, hasMentions = false) => { const sent = api.captureSend(hasMentions); act(() => sent(id)); },
    unmount: () => act(() => tree.unmount()),
  };
}
afterEach(() => act(() => trees.splice(0).forEach(tree => tree.unmount())));

describe('private untagged send feedback', () => {
  it('appears only on the device that sent, then clears all hints after tagging anyone', async () => {
    const sender = mount();
    await flush();
    const observer = mount({ viewerPubkey: 'observer' });
    const otherDevice = mount();
    sender.send('first'); sender.send('second');
    await flush();
    expect(sender.hints()).toHaveLength(2);
    expect(observer.hints()).toEqual([]);
    expect(otherDevice.hints()).toEqual([]);
    sender.send('tagged-person', true);
    expect(sender.hints()).toEqual([]);
    sender.send('third');
    sender.send('tagged-agent', true);
    expect(sender.hints()).toEqual([]);
  });

  it.each([
    { isDirectMessage: true },
    { hasAgentMembers: false },
    { viewerKind: 'agent' as const },
    { viewerKind: undefined },
    { active: false },
  ])('does not show hints for %j', async options => {
    const sender = mount(options);
    await flush();
    sender.send('message');
    expect(sender.hints()).toEqual([]);
  });

  it('does not show feedback before a successful send receipt', async () => {
    const sender = mount();
    await flush();
    sender.api.captureSend(false);
    expect(sender.hints()).toEqual([]);
  });

  it('clears on leaving and ignores a delayed receipt even after returning', async () => {
    const sender = mount();
    await flush();
    sender.send('first');
    await flush();
    const delayed = sender.api.captureSend(false);
    sender.update({ active: false });
    expect(sender.hints()).toEqual([]);
    sender.update({ active: true });
    await flush();
    act(() => delayed('late'));
    expect(sender.hints()).toEqual([]);
    sender.send('fresh');
    await flush();
    expect(sender.hints()).toHaveLength(1);
  });

  it('clears when the Room or viewer changes and does not leak receipts between sessions', async () => {
    const sender = mount();
    await flush();
    sender.send('first');
    await flush();
    const delayed = sender.api.captureSend(false);
    sender.update({ roomId: 'corner' });
    act(() => delayed('late'));
    expect(sender.hints()).toEqual([]);
    await flush();
    sender.send('corner-send');
    await flush();
    sender.update({ viewerPubkey: 'observer' });
    expect(sender.hints()).toEqual([]);
  });
  it('caps rendered hints across Rooms and remounts with persisted storage', async () => {
    const sender = mount();
    await flush();
    sender.send('one');
    sender.send('one');
    await flush();
    expect(sender.hints()).toHaveLength(1);
    sender.update({ roomId: 'other' });
    await flush();
    sender.send('two');
    await flush();
    expect(sender.hints()).toHaveLength(1);
    sender.send('three');
    await flush();
    expect(sender.hints()).toHaveLength(1);
    sender.unmount();
    const restarted = mount();
    await flush();
    restarted.send('four');
    await flush();
    expect(restarted.hints()).toEqual([]);
    expect(storage.values.get('@beeline/untagged-hint-shown/sender')).toBe('2');
    const other = mount({ viewerPubkey: 'other-account' });
    await flush();
    other.send('one');
    await flush();
    expect(other.hints()).toHaveLength(1);
  });

  it('hides while storage loads and on read or write failures', async () => {
    storage.getItem.mockImplementation(() => new Promise(() => {}));
    const loading = mount();
    loading.send('cold-start');
    expect(loading.hints()).toEqual([]);
    storage.getItem.mockRejectedValue(new Error('unavailable'));
    const failed = mount({ viewerPubkey: 'failed' });
    await flush();
    failed.send('read-error');
    await flush();
    expect(failed.hints()).toEqual([]);
    storage.getItem.mockResolvedValue(null);
    storage.setItem.mockRejectedValue(new Error('unavailable'));
    const write = mount({ viewerPubkey: 'write' });
    await flush();
    write.send('write-error');
    await flush();
    expect(write.hints()).toEqual([]);
  });

  it('shares the allowance between simultaneously mounted Rooms', async () => {
    const first = mount();
    const second = mount({ roomId: 'other' });
    await flush();
    first.send('one'); second.send('two'); first.send('three');
    await flush();
    expect(first.hints().length + second.hints().length).toBe(2);
  });

  it.each([0, 1])('retires after tagging with %i previous hints, across Rooms and remounts', async count => {
    const sender = mount();
    const otherRoom = mount({ roomId: 'other' });
    await flush();
    if (count) { sender.send('first'); await flush(); }
    sender.send('tagged-agent', true);
    sender.send('after-tag');
    otherRoom.send('other-room');
    await flush();
    expect(sender.hints()).toEqual([]);
    expect(otherRoom.hints()).toEqual([]);
    expect(storage.values.get('@beeline/untagged-hint-shown/sender')).toBe('2');
    sender.unmount();
    const restarted = mount();
    await flush();
    restarted.send('after-restart');
    await flush();
    expect(restarted.hints()).toEqual([]);
  });

  it('retires tagged sends before the initial storage read finishes', async () => {
    let finish!: (value: string | null) => void;
    storage.getItem.mockImplementationOnce(() => new Promise<string | null>(resolve => { finish = resolve; }));
    const sender = mount();
    sender.send('tagged', true);
    await flush();
    await act(async () => finish(null));
    sender.send('untagged');
    await flush();
    expect(sender.hints()).toEqual([]);
    expect(storage.values.get('@beeline/untagged-hint-shown/sender')).toBe('2');
  });

  it('keeps tagged-send retirement gated and tolerates storage failure', async () => {
    const dm = mount({ isDirectMessage: true });
    await flush();
    dm.send('tagged', true);
    await flush();
    expect(storage.setItem).not.toHaveBeenCalled();
    const sender = mount();
    await flush();
    storage.setItem.mockRejectedValue(new Error('unavailable'));
    sender.send('tagged', true);
    sender.send('untagged');
    await flush();
    expect(sender.hints()).toEqual([]);
  });

});
