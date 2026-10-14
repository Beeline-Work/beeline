import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { RoomCatchUpSheet } from './RoomCatchUpSheet';
import { buildCatchUpReport } from '@/buzz/room-catch-up-report';

vi.mock('react-native', async () => {
  const R = await import('react');
  const host = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return { View: host('View'), Text: host('Text'), Pressable: host('Pressable') };
});
vi.mock('./HullActionSheet', async () => {
  const R = await import('react');
  return { HULL_SHEET_INSET: 24, HullActionSheetModal: (props: any) => R.createElement('Sheet', props, props.children) };
});
vi.mock('./Button', async () => {
  const R = await import('react');
  return { Button: (props: any) => R.createElement('Button', props) };
});
vi.mock('./RoomListSectionHeader', () => ({ RoomListSectionHeader: () => null }));

describe('catch-up unavailable recovery', () => {
  it.each([null, buildCatchUpReport({
    messages: [{ id: 'empty', text: '', timestamp: 1792005960, isUser: false }],
    boundaryId: 'empty', newestId: 'empty', viewerPubkey: 'owner',
  })])('shows an honest state and a working retry for unavailable content', async (report) => {
    const onRetry = vi.fn();
    let tree: any;
    await act(async () => { tree = create(<RoomCatchUpSheet agents={[]} canDraft onAskAgent={() => {}} onClose={() => {}} onRetry={onRetry} report={report} visible />); });
    const texts = tree.root.findAllByType('Text').map((node: any) => node.props.children);
    expect(texts).toContain('Summary unavailable');
    expect(texts).not.toContain('From Ruby.');
    const retry = tree.root.findByType('Button');
    expect(retry.props.label).toBe('Retry summary');
    await act(async () => retry.props.onPress());
    expect(onRetry).toHaveBeenCalledOnce();
    await act(async () => tree.unmount());
  });
});
