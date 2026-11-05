import React from 'react';
import { Platform } from 'react-native';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { modalRenders, backPress, removeBack } = vi.hoisted(() => ({
  modalRenders: vi.fn(),
  backPress: vi.fn(),
  removeBack: vi.fn(),
}));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    Platform: { OS: 'android' },
    BackHandler: {
      addEventListener: (_: string, callback: () => boolean) => {
        backPress.mockImplementation(callback);
        return { remove: removeBack };
      },
    },
    Modal: (props: { visible: boolean; children: React.ReactNode }) => {
      modalRenders(props.visible);
      return props.visible ? ReactModule.createElement('Modal', props, props.children) : null;
    },
    StyleSheet: { flatten: (style: unknown) => style },
    Pressable: 'Pressable',
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
  };
});
vi.mock('react-native-reanimated', () => {
  const fade = { duration: () => fade, easing: () => fade, reduceMotion: () => fade };
  return {
    default: { View: 'AnimatedView' },
    Easing: { in: (value: unknown) => value, quad: (t: number) => t * t },
    FadeOut: fade,
    ReduceMotion: { System: 'system' },
  };
});
vi.mock('./Button', () => ({ Button: 'Button' }));
vi.mock('./ButtonRow', () => ({ ButtonRow: 'ButtonRow' }));
vi.mock('./MonoHull', () => ({ HullSurface: 'HullSurface' }));

import { HullModal } from './HullDialog';

let renderer: ReactTestRenderer;
beforeEach(() => {
  Object.assign(Platform, { OS: 'android' });
  modalRenders.mockClear();
  backPress.mockReset();
  removeBack.mockClear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
});

describe('HullModal presentation ownership', () => {
  it('does not read unmounted Android content, and reads its latest value when opened', () => {
    const readTitle = vi.fn(() => 'Room actions');
    const options = {
      get title() {
        return readTitle();
      },
    };
    const Content = ({ value }: { value: typeof options }) =>
      React.createElement('Text', {}, value.title);
    const surface = (visible: boolean) => (
      <HullModal visible={visible} onRequestClose={() => undefined}>
        <Content value={options} />
      </HullModal>
    );

    act(() => {
      renderer = create(surface(false));
    });
    expect(readTitle).not.toHaveBeenCalled();
    act(() => {
      renderer.update(surface(false));
    });
    expect(readTitle).not.toHaveBeenCalled();
    expect(modalRenders).toHaveBeenCalledTimes(1);

    readTitle.mockReturnValue('Updated Room actions');
    act(() => {
      renderer.update(surface(true));
    });
    expect(readTitle).toHaveBeenCalledOnce();
    expect(renderer.root.findByType('Text').props.children).toBe('Updated Room actions');
  });

  it('keeps visible native content stable while callbacks update, including after reopening', () => {
    const first = vi.fn();
    const latest = vi.fn();
    const close = vi.fn();
    const surface = (visible: boolean, label: string, onPress: () => void) => (
      <HullModal visible={visible} onRequestClose={close}>
        {React.createElement('Pressable', { testID: 'action', onPress }, label)}
      </HullModal>
    );
    act(() => {
      renderer = create(surface(true, 'Room actions', first));
    });
    act(() => {
      renderer.update(surface(true, 'Room actions', latest));
    });
    expect(modalRenders).toHaveBeenCalledTimes(1);
    act(() => {
      renderer.root.findByProps({ testID: 'action' }).props.onPress();
    });
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();

    act(() => {
      renderer.update(surface(false, 'Room actions', first));
    });
    act(() => {
      renderer.update(surface(false, 'Changed while closed', latest));
    });
    act(() => {
      renderer.update(surface(true, 'Changed while closed', latest));
    });
    expect(renderer.root.findByProps({ testID: 'action' }).props.children).toBe(
      'Changed while closed',
    );
    act(() => {
      renderer.root.findByProps({ testID: 'action' }).props.onPress();
    });
    expect(latest).toHaveBeenCalledTimes(2);
    expect(first).not.toHaveBeenCalled();
  });

  it('continues reconciling hidden iOS content while native dismissal may retain it', () => {
    Object.assign(Platform, { OS: 'ios' });
    const read = vi.fn(() => 'Dismissal content');
    const payload = {
      get title() {
        return read();
      },
    };
    act(() => {
      renderer = create(
        <HullModal visible={false} onRequestClose={() => undefined}>
          {React.createElement('Text', { payload })}
        </HullModal>,
      );
    });
    expect(read).toHaveBeenCalledOnce();
  });
});

it('keeps Android screen sheets in the current window and owns hardware Back only while open', () => {
  const close = vi.fn();
  const latest = vi.fn();
  const surface = (visible: boolean, onRequestClose: () => void) => (
    <HullModal visible={visible} withinScreen onRequestClose={onRequestClose}>
      {React.createElement('Text', {}, 'Room actions')}
    </HullModal>
  );
  act(() => {
    renderer = create(surface(true, close));
  });
  expect(modalRenders).not.toHaveBeenCalled();
  expect(renderer.root.findByType('AnimatedView').props.exiting).toBeDefined();
  act(() => {
    renderer.update(surface(true, latest));
  });
  act(() => {
    expect(backPress()).toBe(true);
  });
  expect(latest).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  act(() => {
    renderer.update(surface(false, latest));
  });
  expect(removeBack).toHaveBeenCalledOnce();
  expect(renderer.root.findAllByType('AnimatedView')).toHaveLength(0);
  Object.assign(Platform, { OS: 'ios' });
  act(() => {
    renderer.update(surface(true, latest));
  });
  expect(modalRenders).toHaveBeenCalledOnce();
});
