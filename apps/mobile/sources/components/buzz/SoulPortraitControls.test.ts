import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDetailView } from '@beeline/buzz-client';

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (choices: any) => choices.default },
  Text: (props: any) => React.createElement('Text', props, props.children),
  TextInput: (props: any) => React.createElement('TextInput', props),
  View: (props: any) => React.createElement('View', props, props.children),
}));
vi.mock('@/modal/ModalManager', () => ({ Modal: { confirm: vi.fn(async () => true) } }));
vi.mock('./MonoHull', () => ({ MonoButton: (props: any) => React.createElement('Button', props) }));
import { SoulPortraitControls } from './SoulPortraitControls';

const original = {
  agent: { identity: { pubkey: 'agent', name: 'Ember', handle: 'ember', face: 'fox' } },
} as AgentDetailView;
let renderer: any;
beforeEach(() => {
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
    await act(async () => renderer.root.findByType('Button').props.onPress());
    expect(generate).toHaveBeenCalledWith('The CURRENT edited soul', undefined);
    expect(countHint()).toBe(0);
    expect(renderer.root.findByType('Button').props.label).toBe('Retry avatar generation');
    expect(
      renderer.root.findByProps({ testID: 'avatar-generation-error' }).props.children,
    ).toContain('offline');
  });

  it('passes trimmed optional direction with the current soul', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('save refused'));
    mount(original, generate);
    act(() =>
      renderer.root
        .findByProps({ testID: 'avatar-direction' })
        .props.onChangeText('  brighter eyes  '),
    );
    await act(async () => renderer.root.findByType('Button').props.onPress());
    expect(generate).toHaveBeenCalledWith('The CURRENT edited soul', 'brighter eyes');
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
    await act(async () => renderer.root.findByType('Button').props.onPress());
    expect(countHint()).toBe(0);
    expect(renderer.root.findByType('Button').props.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(countHint()).toBe(1);
    expect(renderer.root.findByType('Button').props.disabled).toBe(false);
    act(() => renderer.unmount());
    mount(generated);
    expect(countHint()).toBe(1);
    expect(JSON.stringify(renderer.toJSON())).toContain('@ember /draw-avatar');
  });

  it('bounds an offline wait and preserves exclusion when the settings close', async () => {
    const props = mount();
    await act(async () => renderer.root.findByType('Button').props.onPress());
    await act(async () => vi.advanceTimersByTimeAsync(180000));
    expect(renderer.root.findByType('Button').props.label).toBe('Retry avatar generation');
    expect(countHint()).toBe(0);
    await act(async () => renderer.root.findByType('Button').props.onPress());
    act(() => renderer.unmount());
    const calls = (props.refresh as any).mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect((props.refresh as any).mock.calls.length).toBe(calls + 1);
    const reopened = mount();
    expect(renderer.root.findByType('Button').props.disabled).toBe(true);
    expect(renderer.root.findByType('Button').props.label).toBe('generating, will DM you when the avatar is ready');
    await act(async () => renderer.root.findByType('Button').props.onPress());
    expect(reopened.generate).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(180000));
    expect(renderer.root.findByType('Button').props.disabled).toBe(false);
  });
});
