import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
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
  it('renders nothing when the plan has no items (no empty pin)', () => {
    const renderer = render(React.createElement(CornerPlanPin, { plan: { items: [] } }));
    expect(renderer.toJSON()).toBeNull();
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
