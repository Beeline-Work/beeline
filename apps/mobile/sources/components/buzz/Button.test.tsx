import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { beelineThemes } from '@/buzz/groknight';

const active = vi.hoisted(() => ({ theme: 'obsidian' as 'obsidian' | 'bone' }));

vi.mock('react-native-unistyles', async () => {
  const { beelineThemes: themes } = await import('@/buzz/groknight');
  return {
    StyleSheet: {
      hairlineWidth: 1,
      create: (definition: unknown) =>
        typeof definition === 'function'
          ? new Proxy(
              {},
              {
                get: (_target, key) =>
                  (definition as (theme: unknown) => Record<string, unknown>)({
                    buzz: themes[active.theme],
                  })[key as string],
              },
            )
          : definition,
    },
    useUnistyles: () => ({ theme: { buzz: themes[active.theme] } }),
  };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: 'android', select: (options: any) => options.android ?? options.default },
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  const builder: any = new Proxy({}, { get: () => () => builder });
  return {
    default: {
      View: (props: any) => ReactModule.createElement('AnimatedView', props, props.children),
      Text: (props: any) => ReactModule.createElement('AnimatedText', props, props.children),
      createAnimatedComponent: (component: unknown) => component,
    },
    Easing: {
      cubic: 'cubic',
      linear: 'linear',
      poly: () => 'poly',
      out: (value: unknown) => value,
      inOut: (value: unknown) => value,
      bezier: () => 'bezier',
    },
    FadeInDown: builder,
    ReduceMotion: { System: 'system' },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => false,
    useSharedValue: (value: unknown) => ({ value }),
    withRepeat: (value: unknown) => value,
    withSequence: (...steps: unknown[]) => steps[0],
    withTiming: (value: unknown) => value,
  };
});
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));

import { Button, type ButtonVariant } from './Button';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});
afterAll(() => vi.restoreAllMocks());

function flat(style: unknown): Record<string, unknown> {
  return (Array.isArray(style) ? style.flat(Number.POSITIVE_INFINITY) : [style]).reduce(
    (all: Record<string, unknown>, part: unknown) =>
      part && typeof part === 'object' ? { ...all, ...(part as object) } : all,
    {},
  );
}

async function render(props: Partial<React.ComponentProps<typeof Button>> = {}) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      React.createElement(Button, { label: 'Continue', onPress: () => undefined, ...props }),
    );
  });
  const pressable = tree.root.find((node: any) => node.type === 'Pressable');
  const label = tree.root.find((node: any) => node.type === 'Text');
  const frame = (pressed = false) => {
    const style = pressable.props.style;
    return flat(typeof style === 'function' ? style({ pressed }) : style);
  };
  return { tree, pressable, label, frame, text: flat(label.props.style) };
}

describe('the primary button', () => {
  it('is cream with ink text in dark mode', async () => {
    active.theme = 'obsidian';
    const { frame, text } = await render();
    expect({ background: frame().backgroundColor, text: text.color }).toEqual({
      background: '#F3EDE3',
      text: '#1C1712',
    });
  });

  it('is ink with cream text in light mode', async () => {
    active.theme = 'bone';
    const { frame, text } = await render();
    expect({ background: frame().backgroundColor, text: text.color }).toEqual({
      background: '#1C1712',
      text: '#F3EDE3',
    });
  });

  it('dims to 0.85 while pressed', async () => {
    active.theme = 'bone';
    const { frame } = await render();
    expect(frame(false).opacity).toBeUndefined();
    expect(frame(true).opacity).toBe(0.85);
  });
});

describe('the shared Button anatomy', () => {
  it.each(['bone', 'obsidian'] as const)('keeps one shape and face in %s', async (name) => {
    active.theme = name;
    const palette = beelineThemes[name];
    for (const variant of ['primary', 'secondary', 'brass'] as ButtonVariant[]) {
      const { frame, text } = await render({ variant });
      const style = frame();
      expect(style.minHeight).toBe(44);
      expect(style.borderRadius).toBe(palette.radius);
      expect(style.borderWidth).toBe(1);
      expect(style.paddingHorizontal).toBe(palette.space.md);
      expect(text.fontSize).toBe(palette.type.body.fontSize);
      expect(text.lineHeight).toBe(palette.type.body.lineHeight);
      expect(text.fontFamily).toBe('SpaceGrotesk-Medium');
    }
  });

  it.each(['bone', 'obsidian'] as const)('colours each variant from tokens in %s', async (name) => {
    active.theme = name;
    const palette = beelineThemes[name];
    const expected = {
      primary: [palette.buttonPrimaryFill, palette.buttonPrimaryFill, palette.buttonPrimaryText],
      secondary: ['transparent', palette.borderStrong, palette.buttonSecondaryText],
      brass: ['transparent', palette.accent, palette.accent],
    } as const;
    for (const variant of ['primary', 'secondary', 'brass'] as const) {
      const { frame, text } = await render({ variant });
      expect([frame().backgroundColor, frame().borderColor, text.color]).toEqual(expected[variant]);
    }
  });

  it('fills outlined variants with bgPressed while pressed', async () => {
    active.theme = 'obsidian';
    for (const variant of ['secondary', 'brass'] as const) {
      const { frame } = await render({ variant });
      expect(frame(true).backgroundColor).toBe(beelineThemes.obsidian.bgPressed);
    }
  });

  it('keeps a disabled primary legible as disabled', async () => {
    active.theme = 'bone';
    const { frame, text, pressable } = await render({ disabled: true });
    expect(frame().backgroundColor).toBe(beelineThemes.bone.bgRaised);
    expect(text.color).toBe(beelineThemes.bone.textDisabled);
    expect(pressable.props.disabled).toBe(true);
    expect(pressable.props.accessibilityState).toMatchObject({ disabled: true, busy: false });
  });

  it('shows the compact loader, marks busy and disables while loading', async () => {
    active.theme = 'bone';
    const { tree, pressable } = await render({ loading: true });
    expect(pressable.props.disabled).toBe(true);
    expect(pressable.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
    expect(tree.root.findAll((node: any) => node.props?.accessibilityRole === 'progressbar').length).toBeGreaterThan(0);
  });

  it('forwards testID, accessibility label and onPress', async () => {
    const onPress = vi.fn();
    const { pressable } = await render({ testID: 'go', accessibilityLabel: 'Go now', onPress });
    expect(pressable.props.testID).toBe('go');
    expect(pressable.props.accessibilityLabel).toBe('Go now');
    expect(pressable.props.accessibilityRole).toBe('button');
    await act(async () => pressable.props.onPress({}));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('stretches only when fullWidth is set', async () => {
    expect((await render()).frame().alignSelf).toBeUndefined();
    expect((await render({ fullWidth: true })).frame().alignSelf).toBe('stretch');
  });
});
