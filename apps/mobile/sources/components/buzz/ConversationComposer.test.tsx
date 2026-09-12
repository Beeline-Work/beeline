import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const platform = vi.hoisted(() => ({ OS: 'web' }));
vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return {
    Text: host('Text'),
    View: host('View'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    Pressable: host('Pressable'),
    Platform: {
      get OS() {
        return platform.OS;
      },
      select: (choices: any) => choices.default,
    },
  };
});
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Medium: 'medium' },
}));
import { ConversationComposer } from './ConversationComposer';
import { desktopComposerKeyAction } from '@/buzz/desktop-workbench-state';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const renderers: any[] = [];
function render(value: string, onStop?: () => Promise<boolean>) {
  const onSend = vi.fn();
  const onKeyPress = vi.fn();
  let renderer: any;
  act(() => {
    renderer = create(
      <ConversationComposer
        value={value}
        onStop={onStop}
        running
        stopKey="turn-one"
        height={40}
        maxHeight={120}
        focused={false}
        disabled={false}
        onAttach={vi.fn()}
        onBlur={vi.fn()}
        onChangeText={vi.fn()}
        onContentSizeChange={vi.fn()}
        onFocus={vi.fn()}
        onKeyPress={onKeyPress}
        onSend={onSend}
      />,
    );
  });
  renderers.push(renderer);
  return { renderer, onSend, onKeyPress, button: () => renderer.root.findByType('Pressable') };
}
async function release(fixture: ReturnType<typeof render>) {
  act(() => fixture.button().props.onPressOut({ nativeEvent: { type: 'mouseup' } }));
  await act(async () => fixture.button().props.onPress());
}
beforeEach(() => {
  platform.OS = 'web';
  vi.useFakeTimers();
});
afterEach(() => {
  act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
  vi.useRealTimers();
});

describe('one composer: send on tap, deliberate stop on hold', () => {
  it('uses the same empty placeholder on every surface', () => {
    const f = render('');
    expect(f.renderer.root.findByType('TextInput').props.placeholder).toBe('Message');
  });

  it('leaves multiline text visible through native auto-growth', () => {
    const value = 'first line\nsecond line\nthird line';
    platform.OS = 'ios';
    const f = render(value);
    const input = f.renderer.root.findByType('TextInput');
    expect(input.props.value).toBe(value);
    expect(input.props.multiline).toBe(true);
    expect(input.props.numberOfLines).toBeUndefined();
    expect(input.props.style).toHaveLength(2);
    expect(input.props.style[1]).toBeUndefined();
  });

  it('keeps measured multiline sizing on web', () => {
    const f = render('first line\nsecond line\nthird line');
    expect(f.renderer.root.findByType('TextInput').props.style[1]).toEqual({
      height: 40,
      maxHeight: 120,
    });
  });

  it.each(['', 'hello'])('idle %j uses the up arrow and disables only an empty send', (value) => {
    const f = render(value);
    expect(f.button().findByType('Text').props.children).toBe('↑');
    expect(f.button().props.disabled).toBe(!value);
  });
  it('taps while running queue text without stopping or changing the arrow', async () => {
    const stop = vi.fn(async () => true);
    const f = render('next instruction', stop);
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(100));
    expect(f.button().findByType('Text').props.children).toBe('↑');
    await release(f);
    expect(f.onSend).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });
  it('an empty tap during work does nothing but keeps hold available', async () => {
    const stop = vi.fn(async () => true);
    const f = render('', stop);
    expect(f.button().props.disabled).toBe(false);
    act(() => f.button().props.onPressIn());
    await release(f);
    expect(stop).not.toHaveBeenCalled();
    expect(f.onSend).not.toHaveBeenCalled();
  });
  it.each(['', 'next instruction'])('authorized hold %j cancels before any send', async (value) => {
    const order: string[] = [];
    let settle!: (ok: boolean) => void;
    const stop = vi.fn(() => {
      order.push('cancel');
      return new Promise<boolean>((resolve) => {
        settle = resolve;
      });
    });
    const f = render(value, stop);
    f.onSend.mockImplementation(() => order.push('send'));
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(500));
    expect(f.button().props.accessibilityLabel).toBe('Release to stop this turn');
    expect(stop).not.toHaveBeenCalled();
    await release(f);
    expect(order).toEqual(['cancel']);
    await act(async () => settle(true));
    expect(order).toEqual(value ? ['cancel', 'send'] : ['cancel']);
  });
  it('a refused cancellation preserves the unsent draft', async () => {
    const f = render(
      'keep this',
      vi.fn(async () => false),
    );
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(500));
    await release(f);
    expect(f.onSend).not.toHaveBeenCalled();
    expect(f.renderer.root.findByType('TextInput').props.value).toBe('keep this');
  });
  it('unauthorized hold does nothing and never arms brass', async () => {
    const f = render('queued later');
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(500));
    expect(f.button().props.accessibilityLabel).toBe('Send message');
    expect(f.button().findByType('Text').props.children).toBe('↑');
    await release(f);
    expect(f.onSend).not.toHaveBeenCalled();
  });
  it('dragging out aborts the hold; returning needs a new hold', () => {
    const stop = vi.fn(async () => true);
    const f = render('steer', stop);
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(500));
    act(() => f.button().props.onPressOut({ nativeEvent: { type: 'mousemove', touches: [{}] } }));
    expect(f.button().props.accessibilityLabel).toBe('Send message');
    expect(stop).not.toHaveBeenCalled();
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(499));
    expect(f.button().props.accessibilityLabel).toBe('Send message');
  });
  it('does not send or cancel when stop authority disappears during a hold', async () => {
    const stop = vi.fn(async () => true);
    const f = render('keep this draft', stop);
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(500));
    const props = f.renderer.root.findByType(ConversationComposer).props;
    act(() => f.renderer.update(<ConversationComposer {...props} onStop={undefined} />));
    await release(f);
    expect(stop).not.toHaveBeenCalled();
    expect(f.onSend).not.toHaveBeenCalled();
  });

  it('a new turn invalidates an in-progress hold', async () => {
    const stop = vi.fn(async () => true);
    const f = render('keep this draft', stop);
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(500));
    const props = f.renderer.root.findByType(ConversationComposer).props;
    act(() => f.renderer.update(<ConversationComposer {...props} stopKey="turn-two" />));
    await release(f);
    expect(stop).not.toHaveBeenCalled();
    expect(f.onSend).not.toHaveBeenCalled();
  });

  it('shares one row across Room and corner with unchanged desktop keyboard dispatch', () => {
    const f = render('hello');
    expect(f.renderer.root.findAllByType('View')[0].props.style[0]).toMatchObject({
      flexDirection: 'row',
      alignItems: 'flex-end',
    });
    expect(f.renderer.root.findByType('TextInput').props.onKeyPress).toBe(f.onKeyPress);
    expect(desktopComposerKeyAction('web', 'Enter', false)).toBe('send');
    expect(desktopComposerKeyAction('web', 'Enter', true)).not.toBe('send');
    for (const file of [
      '../../app/(app)/beeline/chat/[channelId].tsx',
      '../DesktopRoomInspector.tsx',
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).toContain('<ConversationComposer');
      expect(source).toContain('stopKey={');
      expect(source).toContain('desktopComposerKeyAction(');
    }
  });
});
