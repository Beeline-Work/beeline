import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { useUntaggedMessageHints } from './use-untagged-message-hints';

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
  it('appears only on the device that sent, then clears all hints after tagging anyone', () => {
    const sender = mount();
    const observer = mount({ viewerPubkey: 'observer' });
    const otherDevice = mount();
    sender.send('first'); sender.send('second');
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
  ])('does not show hints for %j', options => {
    const sender = mount(options);
    sender.send('message');
    expect(sender.hints()).toEqual([]);
  });

  it('does not show feedback before a successful send receipt', () => {
    const sender = mount();
    sender.api.captureSend(false);
    expect(sender.hints()).toEqual([]);
  });

  it('clears on leaving and ignores a delayed receipt even after returning', () => {
    const sender = mount();
    sender.send('first');
    const delayed = sender.api.captureSend(false);
    sender.update({ active: false });
    expect(sender.hints()).toEqual([]);
    sender.update({ active: true });
    act(() => delayed('late'));
    expect(sender.hints()).toEqual([]);
    sender.send('fresh');
    expect(sender.hints()).toHaveLength(1);
  });

  it('clears when the Room or viewer changes and does not leak receipts between sessions', () => {
    const sender = mount();
    sender.send('first');
    const delayed = sender.api.captureSend(false);
    sender.update({ roomId: 'corner' });
    act(() => delayed('late'));
    expect(sender.hints()).toEqual([]);
    sender.send('corner-send');
    sender.update({ viewerPubkey: 'observer' });
    expect(sender.hints()).toEqual([]);
  });
});
