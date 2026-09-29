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
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));

import { BrassButton, MonoButton, OnboardingButton } from './MonoHull';

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

async function colours(Button: typeof OnboardingButton) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(React.createElement(Button, { label: 'Continue', onPress: () => undefined }));
  });
  const label = tree.root.find((node: any) => node.type === 'Text');
  let fill = label.parent!;
  while (fill.type !== 'View') fill = fill.parent!;
  return {
    background: flat(fill.props.style).backgroundColor,
    text: flat(label.props.style).color,
  };
}

describe('the onboarding primary button', () => {
  it('is cream with ink text in dark mode', async () => {
    active.theme = 'obsidian';
    expect(await colours(OnboardingButton)).toEqual({ background: '#F3EDE3', text: '#1C1712' });
  });

  it('is ink with cream text in light mode', async () => {
    active.theme = 'bone';
    expect(await colours(OnboardingButton)).toEqual({ background: '#1C1712', text: '#F3EDE3' });
  });

  it('uses the same primary palette at every legacy BrassButton call site', async () => {
    active.theme = 'bone';
    expect(await colours(BrassButton)).toEqual({
      background: beelineThemes.bone.buttonPrimaryFill,
      text: beelineThemes.bone.buttonPrimaryText,
    });
    active.theme = 'obsidian';
    expect(await colours(BrassButton)).toEqual({
      background: beelineThemes.obsidian.buttonPrimaryFill,
      text: beelineThemes.obsidian.buttonPrimaryText,
    });
  });
});

describe('the shared MonoButton palette', () => {
  it.each(['bone', 'obsidian'] as const)('renders primary and secondary in %s', async (name) => {
    active.theme = name;
    const palette = beelineThemes[name];
    for (const variant of ['primary', 'secondary'] as const) {
      let tree!: ReactTestRenderer;
      await act(async () => {
        tree = create(React.createElement(MonoButton, { label: 'Continue', variant, onPress: () => undefined }));
      });
      const label = tree.root.find((node: any) => node.type === 'Text');
      let plate = label.parent!;
      while (plate.type !== 'View') plate = plate.parent!;
      const style = flat(plate.props.style);
      expect(style.backgroundColor).toBe(variant === 'primary' ? palette.buttonPrimaryFill : 'transparent');
      expect(style.borderColor).toBe(variant === 'primary' ? palette.buttonPrimaryFill : palette.buttonSecondaryText);
      expect(flat(label.props.style).color).toBe(variant === 'primary' ? palette.buttonPrimaryText : palette.buttonSecondaryText);
    }
  });

  it('keeps a disabled primary legible as disabled', async () => {
    active.theme = 'bone';
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(MonoButton, { label: 'Continue', disabled: true }));
    });
    const label = tree.root.find((node: any) => node.type === 'Text');
    let plate = label.parent!;
    while (plate.type !== 'View') plate = plate.parent!;
    expect(flat(plate.props.style).backgroundColor).toBe(beelineThemes.bone.bgBase);
    expect(flat(label.props.style).color).toBe(beelineThemes.bone.textDisabled);
  });
});
