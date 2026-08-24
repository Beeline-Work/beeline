import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
  };
});

// The pin pulses its active step through MonoHull's `HullLivePulse`, which
// reaches reanimated and (via expo-haptics) expo-modules-core's
// React-Native-only `__DEV__` global. Same shims as MechanismMotion.test.ts.
vi.mock('expo-haptics', () => ({
  impactAsync: () => undefined,
  notificationAsync: () => undefined,
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success' },
}));

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: { View: (props: any) => ReactModule.createElement('AnimatedView', props) },
    Easing: { linear: 'linear', out: (fn: unknown) => fn, poly: (n: number) => n },
    ReduceMotion: { System: 'system' },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => false,
    useSharedValue: (value: number) => ({ value }),
    withRepeat: (value: unknown) => value,
    withTiming: (value: number) => value,
    withSequence: (...steps: unknown[]) => steps[0],
    FadeInDown: { duration: () => ({}) },
  };
});

import { groknight } from '@/buzz/groknight';
import { CornerPlanPin } from './CornerPlanPin';

const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => vi.restoreAllMocks());

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

function rows(renderer: ReactTestRenderer) {
  // Each row is a marker Text followed by a step Text, in that order.
  return renderer.root.findAllByType('Text').slice(1); // [0] is the eyebrow
}

describe('CornerPlanPin', () => {
  it('renders nothing when there is neither an objective nor a plan (no empty pin)', () => {
    expect(render(React.createElement(CornerPlanPin, { plan: { items: [] } })).toJSON()).toBeNull();
    expect(render(React.createElement(CornerPlanPin, {})).toJSON()).toBeNull();
  });

  it('states a single objective on one line with no checklist at all', () => {
    const renderer = render(
      React.createElement(CornerPlanPin, { objective: 'Add color to code blocks' }),
    );
    const texts = renderer.root.findAllByType('Text');
    // Eyebrow + the objective line. Nothing else: a corner with no published
    // plan still names what it is for.
    expect(texts).toHaveLength(2);
    expect(texts[1].props.children).toBe('Add color to code blocks');
    expect(texts[1].props.numberOfLines).toBe(2);
    expect(renderer.root.findAllByType('ScrollView')).toHaveLength(0);
  });

  it('expands the complete objective when pressed and collapses it on a second press', () => {
    const objective = `Preserve this complete objective ${'with all of its detail '.repeat(20)}`;
    const renderer = render(React.createElement(CornerPlanPin, { objective, testID: 'plan' }));
    const toggle = renderer.root.findByProps({ testID: 'plan-objective-toggle' });
    const text = () => renderer.root.findByProps({ testID: 'plan-objective' });

    expect(text().props.children).toBe(objective);
    expect(text().props.numberOfLines).toBe(2);
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });

    act(() => toggle.props.onPress());
    expect(text().props.numberOfLines).toBeUndefined();
    expect(toggle.props.accessibilityState).toEqual({ expanded: true });

    act(() => toggle.props.onPress());
    expect(text().props.numberOfLines).toBe(2);
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });
  });

  it("keeps the corner's opening objective pinned when later plans carry another objective", () => {
    const renderer = render(
      React.createElement(CornerPlanPin, {
        objective: 'the corner opening task',
        plan: { objective: 'the plan objective', items: [{ step: 'One', status: 'pending' }] },
      }),
    );
    const texts = renderer.root.findAllByType('Text');
    expect(texts[1].props.children).toBe('the corner opening task');
  });

  it('pulses only the in-progress step, and only it', () => {
    const renderer = render(
      React.createElement(CornerPlanPin, {
        plan: {
          items: [
            { step: 'Done', status: 'completed' },
            { step: 'Working', status: 'in_progress' },
            { step: 'Next', status: 'pending' },
          ],
        },
      }),
    );
    // `HullLivePulse` renders one reanimated view; nothing else in the pin does.
    const pulses = renderer.root.findAllByType('AnimatedView');
    expect(pulses).toHaveLength(1);
    expect(pulses[0].findAllByType('Text')[1].props.children).toBe('Working');
  });

  it('marks the current step gold, done steps struck-through and greyed, and pending steps quiet', () => {
    const renderer = render(
      React.createElement(CornerPlanPin, {
        plan: {
          items: [
            { step: 'Trace projection', status: 'completed' },
            { step: 'Build drill-down', status: 'in_progress' },
            { step: 'Add regression test', status: 'pending' },
          ],
        },
      }),
    );

    const [doneMark, doneStep, activeMark, activeStep, pendingMark, pendingStep] = rows(renderer);

    expect(doneMark.props.children).toBe('✓');
    expect(doneStep.props.style.flat()).toContainEqual(
      expect.objectContaining({ color: groknight.textMuted, textDecorationLine: 'line-through' }),
    );

    expect(activeMark.props.children).toBe('◐');
    expect(activeStep.props.style.flat()).toContainEqual(
      expect.objectContaining({ color: groknight.accent }),
    );

    expect(pendingMark.props.children).toBe('□');
    expect(pendingStep.props.style.flat().filter(Boolean).at(-1).color).toBe(groknight.ledgerQuiet);
  });

  it('scrolls a long plan inside a fixed-height frame instead of growing past it', () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      step: `Step ${index}`,
      status: 'pending' as const,
    }));
    const renderer = render(React.createElement(CornerPlanPin, { plan: { items } }));

    const scroll = renderer.root.findByType('ScrollView');
    expect(scroll.props.style.maxHeight).toBeGreaterThan(0);
    // All items still render inside — it's a scroll cap, not a truncation.
    expect(rows(renderer)).toHaveLength(40);
  });

  it('shows the objective when given, and omits it when absent', () => {
    const withObjective = render(
      React.createElement(CornerPlanPin, {
        plan: { objective: 'Color-tag code blocks', items: [{ step: 'Wire highlighter', status: 'pending' }] },
      }),
    );
    expect(
      withObjective.root.findAllByType('Text').some((node) => node.props.children === 'Color-tag code blocks'),
    ).toBe(true);

    const withoutObjective = render(
      React.createElement(CornerPlanPin, { plan: { items: [{ step: 'Wire highlighter', status: 'pending' }] } }),
    );
    expect(withoutObjective.root.findAllByType('Text')).toHaveLength(3); // eyebrow + mark + step
  });
});
