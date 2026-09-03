import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Linking: { openURL: vi.fn() },
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-reanimated', () => ({ useReducedMotion: () => false }));
vi.mock('./IdentityMark', async () => {
  const ReactModule = await import('react');
  const IdentityMarkStub = (props: Record<string, unknown>) =>
    ReactModule.createElement('IdentityMark', props, props.children as never);
  return { IdentityMark: IdentityMarkStub };
});

import { LedgerSystemLine } from './Ledger';
import { typeRoles } from '@/buzz/groknight';

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

function flattenText(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join('');
  return flattenText(node.props?.children);
}

/**
 * DESIGN.md → Type / Ledger: a system notification is metadata, not a voice.
 * One renderer, the calm `meta` role (13px quiet sans), no avatar, stamp
 * pinned right, names in brass and tappable, the object linked by its URL.
 */
describe('the system line', () => {
  const event = {
    subject: { kind: 'person' as const, id: 'o'.repeat(64), name: 'Owner' },
    verb: 'turned yolo on for',
    object: { text: 'Bee', id: 'b'.repeat(64) },
    consequence: 'grant requests are now approved automatically',
  };

  it('is set in the meta role with no avatar and the stamp pinned right', () => {
    const renderer = render(
      React.createElement(LedgerSystemLine, {
        id: 'yolo',
        text: 'Owner turned yolo on for Bee · grant requests are now approved automatically',
        event,
        stamp: '16:41',
      }),
    );
    const line = renderer.root.findByProps({ testID: 'system-line-text-yolo' });
    expect(line.props.style).toMatchObject({
      fontFamily: typeRoles.meta.fontFamily,
      fontSize: typeRoles.meta.fontSize,
      lineHeight: typeRoles.meta.lineHeight,
      color: '#83838d',
    });
    expect(line.props.style.transform).toBeUndefined();
    expect(line.props.style.fontWeight).toBeUndefined();
    expect(renderer.root.findAllByType('IdentityMark' as never)).toHaveLength(0);
    const stamp = renderer.root.findByProps({ testID: 'system-line-stamp-yolo' });
    expect(stamp.props.style).toMatchObject({ position: 'absolute', right: 0, textAlign: 'right' });
    expect(flattenText(line.props.children)).toBe(
      'Owner turned yolo on for Bee · grant requests are now approved automatically',
    );
  });

  it('sets names in brass and makes them tappable', () => {
    const onOpenIdentity = vi.fn();
    const renderer = render(
      React.createElement(LedgerSystemLine, {
        id: 'yolo',
        text: 'Owner turned yolo on for Bee',
        event,
        stamp: '16:41',
        onOpenIdentity,
      }),
    );
    const subject = renderer.root.findByProps({ testID: 'system-line-name-yolo-0' });
    expect(subject.props.style).toMatchObject({ color: '#b08a4a' });
    subject.props.onPress();
    expect(onOpenIdentity).toHaveBeenCalledWith('o'.repeat(64));
    const object = renderer.root.findByProps({ testID: 'system-line-object-yolo' });
    expect(object.props.style).toMatchObject({ color: '#b08a4a' });
    object.props.onPress();
    expect(onOpenIdentity).toHaveBeenLastCalledWith('b'.repeat(64));
  });

  it('links an object that carries a URL', () => {
    const onOpenUrl = vi.fn();
    const renderer = render(
      React.createElement(LedgerSystemLine, {
        id: 'pr',
        text: 'GitHub opened a pull request Ship the widget',
        event: {
          subject: { kind: 'github', name: 'GitHub' },
          verb: 'opened a pull request',
          object: { text: 'Ship the widget', url: 'https://github.com/acme/w/pull/7' },
        },
        stamp: '16:41',
        onOpenUrl,
      }),
    );
    const object = renderer.root.findByProps({ testID: 'system-line-object-pr' });
    object.props.onPress();
    expect(onOpenUrl).toHaveBeenCalledWith('https://github.com/acme/w/pull/7');
    // A subject with no identity (GitHub) is named but not tappable.
    expect(renderer.root.findByProps({ testID: 'system-line-name-pr-0' }).props.onPress).toBeUndefined();
  });

  it('reads a folded run as one sentence', () => {
    const renderer = render(
      React.createElement(LedgerSystemLine, {
        id: 'joined',
        text: 'Candy, Terra and Codex joined',
        event: { subject: { kind: 'person', id: 'c'.repeat(64), name: 'Candy' }, verb: 'joined' },
        subjects: [
          { kind: 'person', id: 'c'.repeat(64), name: 'Candy' },
          { kind: 'agent', id: 't'.repeat(64), name: 'Terra' },
          { kind: 'agent', id: 'x'.repeat(64), name: 'Codex' },
        ],
        stamp: '16:41',
      }),
    );
    const line = renderer.root.findByProps({ testID: 'system-line-text-joined' });
    expect(flattenText(line.props.children)).toBe('Candy, Terra and Codex joined');
    expect(
      [0, 1, 2].map((i) => renderer.root.findByProps({ testID: `system-line-name-joined-${i}` }).props.children),
    ).toEqual(['Candy', 'Terra', 'Codex']);
  });

  it('renders a row from before the grammar as its plain text', () => {
    const renderer = render(
      React.createElement(LedgerSystemLine, { id: 'old', text: 'Candy joined', stamp: '16:41' }),
    );
    const line = renderer.root.findByProps({ testID: 'system-line-text-old' });
    expect(line.props.children).toBe('Candy joined');
  });
});
