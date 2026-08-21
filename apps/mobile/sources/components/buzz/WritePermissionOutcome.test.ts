import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(
      name,
      props,
      // Pressable takes a render prop for its press state; every other host
      // takes plain children.
      typeof props.children === 'function' ? props.children({ pressed: false }) : props.children,
    );
  return {
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

// This component only consumes the ledger's fixed gutter width. Keep the
// source-level test out of Ledger's animation/native dependency graph.
vi.mock('./Ledger', () => ({ LEDGER_MARGINALIA_WIDTH: 36 }));

import { WritePermissionOutcome, writePermissionStatusLabel } from './WritePermissionOutcome';

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

describe('write permission corner outcome', () => {
  it('inscribes the outcome as one dim line — no border, no fill, no chip', () => {
    const renderer = render(
      React.createElement(WritePermissionOutcome, { status: 'denied' }),
    );
    const [line] = renderer.root.findAllByType('View');
    expect(line.props.style).not.toHaveProperty('borderWidth');
    expect(line.props.style).not.toHaveProperty('borderColor');
    expect(line.props.style).not.toHaveProperty('backgroundColor');
    expect(line.props.style).not.toHaveProperty('minHeight');
    // Starts at the prose margin and reserves the same right gutter the
    // timestamps hang in.
    expect(line.props.style.paddingHorizontal).toBeUndefined();
    expect(line.props.style.paddingRight).toBe(36);

    const [status] = renderer.root.findAllByType('Text');
    expect(status.props.children).toContain('STILL READ-ONLY');
    const tone = (node: { props: { style: unknown } }) =>
      (Array.isArray(node.props.style) ? node.props.style : [node.props.style])
        .filter(Boolean)
        .reduce((merged: Record<string, unknown>, style: Record<string, unknown>) => ({ ...merged, ...style }), {});
    expect(tone(status).color).toBe('#83838d');
  });

  it('reports the decision and never navigates', () => {
    // An open corner is live state, not a decision. It lives in the pinned
    // CornerLiveBar above the composer, which stays true as the corner's
    // status moves on; a note inscribed here would scroll away and then lie.
    for (const status of ['pending', 'allowed', 'denied', 'expired', 'failed'] as const) {
      const renderer = render(
        React.createElement(WritePermissionOutcome, { status, subchannelId: 'new-corner-id' }),
      );
      expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
      expect(renderer.root.findAllByProps({ testID: 'write-permission-open-corner' })).toHaveLength(
        0,
      );
    }
  });

  it('names every decision plainly, and never claims a corner is open', () => {
    const label = (props: Parameters<typeof writePermissionStatusLabel>) =>
      writePermissionStatusLabel(...props);
    expect(label(['allowed', 'new-corner-id'])).toBe('◇ ALLOWED · OPENING CORNER');
    expect(label(['pending', undefined, true])).toBe('⊘ A PERSON MUST RESPOND');
    expect(label(['denied'])).toContain('STILL READ-ONLY');
    expect(label(['failed'])).toContain('STILL READ-ONLY');
    expect(label(['expired'])).toContain('STILL READ-ONLY');
    // The scroll note the pinned bar replaced.
    for (const status of ['pending', 'allowed', 'denied', 'expired', 'failed'] as const) {
      expect(label([status, 'new-corner-id'])).not.toContain('CORNER OPEN');
    }
  });
});
