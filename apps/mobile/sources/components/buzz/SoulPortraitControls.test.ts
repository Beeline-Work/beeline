import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDetailView } from '@beeline/buzz-client';
const liveListeners = vi.hoisted(() => new Set<(event: any) => void>());
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({
  register: async (_filters: unknown, listener: (event: any) => void) => {
    liveListeners.add(listener);
    return () => liveListeners.delete(listener);
  },
}) }));

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (choices: any) => choices.default },
  Text: (props: any) => React.createElement('Text', props, props.children),
  TextInput: (props: any) => React.createElement('TextInput', props),
  View: (props: any) => React.createElement('View', props, props.children),
}));
vi.mock('@/modal/ModalManager', () => ({ Modal: { confirm: vi.fn(async () => true) } }));
vi.mock('./SettingsRow', () => ({
  SettingsRow: (props: any) => React.createElement('SettingsRow', props),
}));
import { SoulPortraitControls } from './SoulPortraitControls';
import { avatarGenerationShowsPending } from '@/buzz/avatar-generation';

const original = {
  agent: { identity: { pubkey: 'agent', name: 'Ember', handle: 'ember', face: 'fox' } },
} as AgentDetailView;
let renderer: any;
beforeEach(() => {
  liveListeners.clear();
  vi.useFakeTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
  vi.useRealTimers();
});
const countHint = () =>
  renderer.root
    .findAllByType('View')
    .filter((node: any) => node.props.testID === 'avatar-refinement-hint').length;
async function agentChanged() {
  await act(async () => {
    for (const listener of liveListeners) listener({ monolithLive: {
      type: 'resource-change', roomId: '', resource: 'agent', resourceId: 'agent',
    } });
    await Promise.resolve();
  });
}
function mount(
  detail = original,
  generate = vi.fn().mockResolvedValue(undefined),
  refresh = vi.fn().mockResolvedValue(original),
) {
  const props = { detail, soul: 'The CURRENT edited soul', disabled: false, generate, refresh };
  act(() => {
    renderer = create(React.createElement(SoulPortraitControls, props));
  });
  return props;
}

describe('soul avatar generation', () => {
  it('hides hints for assigned faces and failed generation, and offers retry', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('offline'));
    mount(original, generate);
    expect(countHint()).toBe(0);
    await act(async () => renderer.root.findByType('SettingsRow').props.onPress());
    expect(generate).toHaveBeenCalledWith('The CURRENT edited soul');
    expect(countHint()).toBe(0);
    expect(renderer.root.findByType('SettingsRow').props.title).toBe('Retry avatar generation');
    expect(
      renderer.root.findByProps({ testID: 'avatar-generation-error' }).props.children,
    ).toContain('offline');
  });

  it('has no free-text direction input and sends only the current soul', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('save refused'));
    mount(original, generate);
    expect(renderer.root.findAllByProps({ testID: 'avatar-direction' })).toHaveLength(0);
    await act(async () => renderer.root.findByType('SettingsRow').props.onPress());
    expect(generate).toHaveBeenCalledWith('The CURRENT edited soul');
    expect(
      renderer.root.findByProps({ testID: 'avatar-generation-error' }).props.children,
    ).toContain('save refused');
  });

  it('replaces the display after successful refresh and keeps guidance after reopening', async () => {
    const generated = {
      ...original,
      avatarGenerationId: 'saved-id',
      agent: {
        ...original.agent,
        identity: {
          ...original.agent.identity,
          avatar: 'https://example.com/v1/agent-avatars/saved-id',
        },
      },
    };
    const refresh = vi.fn().mockImplementation(async () => {
      renderer.update(React.createElement(SoulPortraitControls, { ...props, detail: generated }));
      return generated;
    });
    const props = mount(original, vi.fn().mockResolvedValue(undefined), refresh);
    await act(async () => renderer.root.findByType('SettingsRow').props.onPress());
    expect(countHint()).toBe(0);
    expect(renderer.root.findByType('SettingsRow').props.disabled).toBe(true);
    await agentChanged();
    expect(countHint()).toBe(1);
    expect(renderer.root.findByType('SettingsRow').props.disabled).toBe(false);
    act(() => renderer.unmount());
    mount(generated);
    expect(countHint()).toBe(1);
    expect(JSON.stringify(renderer.toJSON())).toContain('@ember /draw-avatar');
  });

  it('makes no periodic reads over five minutes while a job is pending', async () => {
    const props = mount(original, vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue({ ...original, avatarGenerationPending: true }));
    await act(async () => renderer.root.findByType('SettingsRow').props.onPress());
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(props.refresh).not.toHaveBeenCalled();
    expect(renderer.root.findByType('SettingsRow').props.disabled).toBe(true);
    expect(countHint()).toBe(0);
    await agentChanged();
    expect(props.refresh).toHaveBeenCalledTimes(1);
  });

  it('lets a server answer end the client bridge without waiting for a live signal', async () => {
    let finish!: () => void;
    const generate = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const props = mount(original, generate);
    const rerender = (detail: AgentDetailView) =>
      act(() => renderer.update(React.createElement(SoulPortraitControls, { ...props, detail })));
    await act(async () => renderer.root.findByType('SettingsRow').props.onPress());
    // Before the server reports the job, the client job bridges the gap.
    rerender({ ...original, avatarGenerationPending: false });
    expect(renderer.root.findByType('SettingsRow').props.disabled).toBe(true);
    await act(async () => finish());
    rerender({ ...original, avatarGenerationPending: true });
    expect(renderer.root.findByType('SettingsRow').props.disabled).toBe(true);
    await act(async () => rerender({ ...original, avatarGenerationPending: false }));
    expect(renderer.root.findAllByProps({ testID: 'avatar-generation-pending' })).toHaveLength(0);
    expect(renderer.root.findByType('SettingsRow').props.title).toBe('Retry avatar generation');
    expect(props.refresh).not.toHaveBeenCalled();
  });
});

describe('avatarGenerationShowsPending', () => {
  const job = { pending: true, error: null, since: 'old' };
  it('bridges only until the server reports', () => {
    expect(avatarGenerationShowsPending(job, { avatarGenerationId: 'old' })).toBe(true);
    expect(avatarGenerationShowsPending(job, { avatarGenerationId: 'new', avatarGenerationPending: false })).toBe(false);
    expect(avatarGenerationShowsPending({ ...job, serverSeen: true }, { avatarGenerationId: 'old', avatarGenerationPending: false })).toBe(false);
    expect(avatarGenerationShowsPending({ pending: false, error: null }, { avatarGenerationPending: true })).toBe(true);
    expect(avatarGenerationShowsPending({ pending: false, error: null }, {})).toBe(false);
  });
});
