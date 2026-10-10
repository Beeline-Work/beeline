import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebhookRequestCard as Request } from '@beeline/api-contract/phone';

const operation = vi.hoisted(() => ({ monolithPhoneOperation: vi.fn() }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
  return { Text: host('Text') };
});
vi.mock('react-native-unistyles', () => {
  const theme = { buzz: { type: { body: {} }, textPrimary: 'ink' } };
  return {
    StyleSheet: { create: (styles: any) => (typeof styles === 'function' ? styles(theme) : styles) },
  };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: operation.monolithPhoneOperation,
  phoneOperationFailureReason: (error: unknown) => String(error),
}));
vi.mock('./TranscriptCard', async () => {
  const ReactModule = await import('react');
  return { TranscriptCard: (props: any) => ReactModule.createElement('TranscriptCard', props) };
});

const { WebhookRequestCard } = await import('./WebhookRequestCard');

const renderers: ReactTestRenderer[] = [];
afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount());
  vi.clearAllMocks();
});

const request = (status: Request['status']): Request => ({
  requestId: 'req-1',
  agentId: 'agent-1',
  agentName: 'Hoots',
  source: 'github',
  reason: 'Watch pushes',
  status,
  expiresAt: Date.now() / 1000 + 3600,
});

function render(initial: Request) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<WebhookRequestCard request={initial} roomId="room-a" canManage />);
  });
  renderers.push(renderer);
  const card = () => renderer.root.findByType('TranscriptCard' as any);
  return {
    subline: () => card().props.subline as string,
    press: (testID: string) =>
      card()
        .props.actions.find((action: any) => action.testID === testID)
        .onPress(),
    update: (next: Request) =>
      act(() => renderer.update(<WebhookRequestCard request={next} roomId="room-a" canManage />)),
  };
}

describe('webhook request card status', () => {
  it('shows the decision, then the server status once the row changes', async () => {
    operation.monolithPhoneOperation.mockResolvedValue({ status: 'approved' });
    const card = render(request('pending'));
    expect(card.subline()).toBe('Room admin approval needed');
    await act(async () => card.press('webhook-approve'));
    expect(card.subline()).toBe('approved');
    // Another admin's decision or expiry reaches this card on the server row.
    card.update(request('expired'));
    expect(card.subline()).toBe('expired');
  });

  it('follows a server change it did not make', () => {
    const card = render(request('pending'));
    card.update(request('denied'));
    expect(card.subline()).toBe('denied');
  });
});
