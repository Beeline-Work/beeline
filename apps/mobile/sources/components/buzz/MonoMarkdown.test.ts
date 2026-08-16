import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (obj: any) => obj.android ?? obj.default },
    Linking: { openURL: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    View: host('View'),
    ScrollView: host('ScrollView'),
  };
});

import { MonoMarkdown } from './MonoMarkdown';

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

function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node === 'object' && 'children' in (node as any)) {
    return collectText((node as any).children);
  }
  return '';
}

function renderedText(node: ReactTestRenderer): string {
  return collectText(node.toJSON());
}

/**
 * The Android bug this suite guards against is a native layout quirk (a
 * flex:1 Text wrapping nested Text inside a flex-row View fails to lay out
 * text on-device, RN issue class "nested Text in flex row Text is blank") —
 * react-test-renderer's JSON tree still contains the text either way, so a
 * plain "is the text present" assertion can't fail against the broken markup.
 * Instead, collect each *top-level* Text node's flattened content (a "View"
 * boundary starts a new group) so we can assert the marker and the item body
 * live in the SAME Text node, which is the actual structural fix.
 */
function topLevelTextGroups(node: unknown): string[] {
  const groups: string[] = [];
  const walk = (n: unknown) => {
    if (n === null || n === undefined || typeof n === 'boolean' || typeof n === 'string') return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const el = n as { type?: string; children?: unknown };
    if (el.type === 'Text') {
      groups.push(collectText(el));
      return;
    }
    walk(el.children);
  };
  walk(node);
  return groups;
}

const NUMBERED_LIST_INPUT = `REDESIGN (drill-down, three depths):
1. Transcript = mostly the agent's NATURAL-LANGUAGE updates (what it is doing / found), not raw tool telemetry.
2. Per turn, collapse ALL tool calls + file edits into ONE clickable summary line (e.g. "Edited 4 files, ran tests").
3. Tap that line -> SECONDARY view: the list of edited files + tool calls for that turn.`;

describe('MonoMarkdown lists', () => {
  it('renders numbered list item body text, not just the markers', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(MonoMarkdown, { markdown: NUMBERED_LIST_INPUT }));
    });

    const text = renderedText(renderer);
    expect(text).toContain('NATURAL-LANGUAGE updates');
    expect(text).toContain('collapse ALL tool calls');
    expect(text).toContain('SECONDARY view');

    // The actual regression: on the broken markup the marker ("1.") and the
    // item body live in two sibling Text nodes split by a flex-row View, so
    // no single Text node's flattened content contains both.
    const groups = topLevelTextGroups(renderer.toJSON());
    expect(groups.some((g) => g.includes('1.') && g.includes('NATURAL-LANGUAGE'))).toBe(true);
    expect(groups.some((g) => g.includes('2.') && g.includes('collapse ALL tool calls'))).toBe(
      true,
    );
    expect(groups.some((g) => g.includes('3.') && g.includes('SECONDARY view'))).toBe(true);
  });

  it('renders unordered/bullet list item body text', () => {
    const markdown = '- first bullet item text\n- second bullet item text';
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(MonoMarkdown, { markdown }));
    });

    const text = renderedText(renderer);
    expect(text).toContain('first bullet item text');
    expect(text).toContain('second bullet item text');

    const groups = topLevelTextGroups(renderer.toJSON());
    expect(groups.some((g) => g.includes('·') && g.includes('first bullet item text'))).toBe(
      true,
    );
    expect(groups.some((g) => g.includes('·') && g.includes('second bullet item text'))).toBe(
      true,
    );
  });
});
