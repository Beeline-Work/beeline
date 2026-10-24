import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { beelineThemes } from '@/buzz/groknight';

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
const state = vi.hoisted(() => ({ theme: 'bone' as 'bone' | 'obsidian' }));
vi.mock('react-native-unistyles', async () => {
  const { beelineThemes } = await import('@/buzz/groknight');
  return {
    StyleSheet: {
      create: (factory: any) =>
        new Proxy(
          {},
          {
            get: (_, key) => factory({ buzz: beelineThemes[state.theme] })[key],
          },
        ),
    },
  };
});
import { RoomListSectionHeader } from './RoomListSectionHeader';

function flatten(style: any): any {
  return Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style || {};
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('section labels inherit their containing surface (R1)', () => {
  for (const theme of ['bone', 'obsidian'] as const) {
    for (const surface of ['bgRaised', 'appCanvas', 'bgHighlight', 'bgTerminal'] as const) {
      it(`${theme}: a default header adds no band over ${surface}`, () => {
        state.theme = theme;
        let tree: any;
        act(() => {
          tree = create(
            <RoomListSectionHeader title="Suggested" inset="content" spacing="flush" />,
          );
        });
        const fill = flatten(tree.root.findByType('View').props.style).backgroundColor;
        expect(fill === undefined || fill === 'transparent').toBe(true);
        expect(fill && fill !== 'transparent' ? fill : beelineThemes[theme][surface]).toBe(
          beelineThemes[theme][surface],
        );
        act(() => tree.unmount());
      });
    }
    it(`${theme}: explicitly opaque headers stay opaque`, () => {
      state.theme = theme;
      let tree: any;
      act(() => {
        tree = create(<RoomListSectionHeader title="Repos" surface="screen" />);
      });
      expect(flatten(tree.root.findByType('View').props.style).backgroundColor).toBe(
        beelineThemes[theme].bgTerminal,
      );
      act(() => tree.unmount());
    });
  }
  it('the sticky repo row covers both label and count with the prompt surface', () => {
    const source = readFileSync(new URL('./RepoPicker.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/groupHeader:\s*\{[^}]*backgroundColor: groknight.bgHighlight/);
    const chat = readFileSync(
      new URL('../../app/(app)/beeline/chat/_chat-surface.tsx', import.meta.url),
      'utf8',
    );
    expect(chat).toMatch(/repoPromptBanner:\s*\{[^}]*backgroundColor: groknight.bgHighlight/);
  });
});
