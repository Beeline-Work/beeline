import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { completeTestTheme } from '@/test/test-theme';
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable' }));
import { TranscriptReference } from './TranscriptReference';
import { ConversationGlyph } from './MicGlyph';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('uses the same stroked bubble at provenance and composer sizes', () => {
  let renderer: any;
  act(() => { renderer = create(<><TranscriptReference viewer>Viewing preview</TranscriptReference><ConversationGlyph color="ink" /></>); });
  const glyphs = renderer.root.findAllByType('Svg');
  expect(glyphs.map((glyph: any) => [glyph.props.width, glyph.props.height])).toEqual([[14, 14], [20, 20]]);
  expect(glyphs[0].props.stroke).toBe(completeTestTheme().buzz.accent);
  for (const glyph of glyphs) {
    expect(glyph.props.viewBox).toBe('0 0 20 20');
    expect(glyph.props.strokeWidth).toBe(1.6);
    expect(glyph.props.strokeLinecap).toBe('round');
    expect(glyph.props.strokeLinejoin).toBe('round');
    expect(glyph.findAllByType('Path')).toHaveLength(1);
  }
  act(() => renderer.unmount());
});
