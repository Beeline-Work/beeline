import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { cornerHeaderAgent } from '@/buzz/corner-display-state';
import { resolveCornerViewAgentPubkey } from '@/buzz/corner-session';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    Text: (props: any) => ReactModule.createElement('Text', props, props.children),
    View: (props: any) => ReactModule.createElement('View', props, props.children),
  };
});
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({ metaRow: {} }) } }));

import { CornerHeaderAgentText } from './HeaderLadder';

it('renders the corner opener after a different agent reviews the corner', () => {
  const messages = [
    { id: 'work', text: 'Working', isUser: false, timestamp: 1, pubkey: 'bbc-pk' },
    { id: 'review', text: 'Reviewed', isUser: false, timestamp: 2, pubkey: 'candy-pk' },
  ];
  const opener = resolveCornerViewAgentPubkey(messages, () => true, 'bbc-pk');
  const header = cornerHeaderAgent({
    ownerPubkey: opener,
    status: 'review',
    activeTurnPubkeys: [],
  });
  const names: Record<string, string> = { 'bbc-pk': 'BBC', 'candy-pk': 'Candy' };
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <CornerHeaderAgentText name={names[header.pubkey!]!} stateWord={header.stateWord} />,
    );
  });
  const visible = tree!.root.findByType('Text' as never).children.join('');
  expect(visible).toBe('BBC · review');
  console.log(`Convo chains header: ${visible}`);
});
