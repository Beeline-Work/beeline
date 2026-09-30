import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { readRoomView } from '@beeline/api-contract/phone';
import { cornerHeaderAgent } from '@/buzz/corner-display-state';
import { resolveCornerViewAgentPubkey } from '@/buzz/corner-session';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    Text: (props: any) => ReactModule.createElement('Text', props, props.children),
    View: (props: any) => ReactModule.createElement('View', props, props.children),
  };
});
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({ metaRow: {}, metaCaps: {} }) } }));

import { CornerHeaderAgentText } from './HeaderLadder';

it('renders the corner opener when a hidden turn receipt names another agent', () => {
  const niglet = 'a'.repeat(64);
  const candy = 'b'.repeat(64);
  const view = readRoomView({
    room: { id: '205b9382-930d-4a1d-98f0-a434832b2705', name: 'convo chains' },
    messages: [],
    members: [],
    latestAgentTurns: [],
    watchFilters: [],
    viewer: {
      identity: { pubkey: 'c'.repeat(64), kind: 'human', name: 'Viewer' },
      role: 'member',
      permissions: { send: true, manage: false },
    },
    cornerOpenerAgentId: niglet,
  });
  expect(view).not.toBeNull();
  const messages = [
    { id: 'work', text: 'Working', isUser: false, timestamp: 1, pubkey: niglet },
    {
      id: 'receipt',
      text: 'Check passed',
      isUser: false,
      timestamp: 2,
      agentTurn: { requestId: 'turn', agentPubkey: candy, status: 'complete' as const },
    },
  ];
  expect(messages.map((message) => message.text).join(' ')).not.toContain('Candy');
  const opener = resolveCornerViewAgentPubkey(messages, () => true, view!.cornerOpenerAgentId);
  const header = cornerHeaderAgent({
    ownerPubkey: opener,
    status: 'review',
    activeTurnPubkeys: [],
  });
  const names: Record<string, string> = { [niglet]: 'Niglet', [candy]: 'Candy' };
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <CornerHeaderAgentText name={names[header.pubkey!]!} stateWord={header.stateWord} />,
    );
  });
  const visible = tree!.root.findByType('Text' as never).children.join('');
  expect(visible).toBe('NIGLET · review');
  console.log(`Corner header fixture: ${visible}`);
});
