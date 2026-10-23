import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { readRoomView } from '@beeline/api-contract/phone';
import { cornerDisplayState, cornerHeaderAgent } from '@/buzz/corner-display-state';
import { resolveCornerViewAgentPubkey } from '@/buzz/corner-session';
import { displayRoomMessage } from '@/buzz/room-view-presentation';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    Text: (props: any) => ReactModule.createElement('Text', props, props.children),
    View: (props: any) => ReactModule.createElement('View', props, props.children),
  };
});
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({ metaRow: {}, metaCaps: {} }) } }));

import { CornerHeaderAgentText } from './HeaderLadder';

const niglet = 'a'.repeat(64);
const candy = 'b'.repeat(64);
const viewer = 'c'.repeat(64);
function textContent(value: any): string {
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (value && typeof value === 'object') return textContent(value.props?.children);
  return value == null ? '' : String(value);
}
const names: Record<string, string> = { [niglet]: 'Niglet', [candy]: 'Candy' };

// A corner in review whose GitHub check lines were stored with a copied parent
// owner (Candy) as author. Candy never speaks and never holds a turn here.
function cornerView(cornerOpenerAgentId?: string) {
  const agent = (pubkey: string) => ({ pubkey, kind: 'agent' as const, name: names[pubkey]! });
  return readRoomView({
    room: {
      id: '205b9382-930d-4a1d-98f0-a434832b2705',
      workspaceId: 'workspace',
      name: 'convo chains',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    },
    messages: [
      { id: 'd'.repeat(64), text: 'Opened the pull request.', createdAt: 1, author: agent(niglet) },
      ...['started a check BUILD', 'passed a check BUILD', 'passed a check TYPECHECK'].map(
        (text, index) => ({
          id: String(index).repeat(64),
          text: `@GitHub ${text}`,
          createdAt: 2 + index,
          author: agent(candy),
          presentation: 'system',
        }),
      ),
    ],
    members: [],
    latestAgentTurns: [],
    watchFilters: [],
    viewer: {
      identity: { pubkey: viewer, kind: 'human', name: 'Viewer' },
      role: 'member',
      permissions: { send: true, manage: false },
    },
    ...(cornerOpenerAgentId ? { cornerOpenerAgentId } : {}),
  });
}

function renderedHeader(cornerOpenerAgentId?: string): string {
  const view = cornerView(cornerOpenerAgentId);
  expect(view).not.toBeNull();
  const messages = view!.messages.map((message) => displayRoomMessage(message, viewer));
  expect(messages.map((message) => message.text).join(' ')).not.toContain('Candy');
  expect(messages.some((message) => message.agentTurn)).toBe(false);
  const header = cornerHeaderAgent({
    ownerPubkey: resolveCornerViewAgentPubkey(
      messages,
      (pubkey) => pubkey in names,
      view!.cornerOpenerAgentId,
    ),
    status: 'review',
    activeTurnPubkeys: [],
  });
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <CornerHeaderAgentText name={names[header.pubkey!] ?? 'Agent'} stateWord={header.stateWord} />,
    );
  });
  return textContent(tree!.root.findAllByType('Text' as never)[0]!.props.children);
}

it('names the corner opener when GitHub check lines carry another agent as author', () => {
  const loaded = renderedHeader(niglet);
  const loading = renderedHeader();
  console.log(`Corner header with opener projection: ${loaded}`);
  console.log(`Corner header before the opener projection lands: ${loading}`);
  expect(loaded).toBe('NIGLET · review');
  expect(loading).toBe('NIGLET · review');
});

it.each(['approve', 'connect', 'question'] as const)(
  'R1: renders the shipped %s reason as a link to its item', (reason) => {
    const jump = vi.fn();
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<CornerHeaderAgentText name="Jellybean" stateWord="waiting"
        waitingReason={reason} onReasonPress={jump} />);
    });
    const link = tree!.root.findAllByType('Text' as never).find(
      (node: any) => node.props.accessibilityRole === 'link',
    );
    expect(link?.props.children).toBe('waiting');
    act(() => link!.props.onPress());
    expect(jump).toHaveBeenCalledOnce();
    const root = tree!.root.findAllByType('Text' as never)[0]!;
    expect(textContent(root.props.children)).toBe('JELLYBEAN · waiting');
  },
);

it.each(['approve', 'connect', 'question'] as const)(
  'R1: failing checks preserve the %s link through the real header adapters', (reason) => {
    const item = { state: 'waiting' as const, reason, itemId: 'open-request',
      lifecycle: { lifecycle: 'in-review' as const, checks: 'failing' as const } };
    const display = cornerDisplayState(item);
    const header = cornerHeaderAgent({ ownerPubkey: niglet, status: display.status,
      headerSuffix: display.headerSuffix, activeTurnPubkeys: [] });
    const jump = vi.fn();
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<CornerHeaderAgentText name="Jellybean" stateWord={header.stateWord}
        state={display.status} headerSuffix={display.headerSuffix}
        waitingReason={item.reason} onReasonPress={() => jump(item.itemId)} />);
    });
    const texts = tree!.root.findAllByType('Text' as never);
    const link = texts.find((node: any) => node.props.accessibilityRole === 'link');
    expect(link?.props.children).toBe('waiting');
    act(() => link!.props.onPress());
    expect(jump).toHaveBeenCalledWith(item.itemId);
    expect(textContent(texts[0]!.props.children)).toBe('JELLYBEAN · waiting');
  },
);


it.each([
  [{ kind: 'merge-hold', personId: viewer, personName: 'Viewer' }, ' on your merge hold'],
  [{ kind: 'merge-hold', personId: candy, personName: 'Candy' }, " on Candy's merge hold"],
  [{ kind: 'report' }, ' on a report'],
] as const)('R1: renders %j as plain Waiting linked to its source', (blocker, copy) => {
  const jump = vi.fn();
  let tree: ReturnType<typeof create>;
  act(() => { tree = create(<CornerHeaderAgentText name="Jellybean" state="waiting"
    waitingReason="approve" blocker={blocker} viewerId={viewer} onReasonPress={jump} />); });
  const texts = tree!.root.findAllByType('Text' as never);
  const link=texts.find((node:any)=>node.props.accessibilityRole==='link');
  expect(textContent(texts[0]!.props.children)).toBe('JELLYBEAN · waiting');
  act(()=>link!.props.onPress());
  expect(jump).toHaveBeenCalledOnce();
});
