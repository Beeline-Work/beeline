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

function render(initial: Request, onResult?: (message: unknown) => void) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <WebhookRequestCard request={initial} roomId="room-a" canManage onResult={onResult} />,
    );
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
      act(() =>
        renderer.update(
          <WebhookRequestCard request={next} roomId="room-a" canManage onResult={onResult} />,
        ),
      ),
  };
}

describe('webhook request card status', () => {
  it('hands the returned row on and shows only the server status', async () => {
    const row = { id: 'card-1', webhookRequest: request('approved') };
    operation.monolithPhoneOperation.mockResolvedValue({ status: 'approved', message: row });
    const onResult = vi.fn();
    const card = render(request('pending'), onResult);
    expect(card.subline()).toBe('Room admin approval needed');
    await act(async () => card.press('webhook-approve'));
    // The row goes to the Room's records; the card holds no status copy.
    expect(onResult).toHaveBeenCalledExactlyOnceWith(row);
    expect(card.subline()).toBe('Room admin approval needed');
    card.update(request('approved'));
    expect(card.subline()).toBe('approved');
  });

  it('follows a server change it did not make', () => {
    const card = render(request('pending'));
    card.update(request('denied'));
    expect(card.subline()).toBe('denied');
  });

  it('keeps a newer server status when the decision response arrives late', async () => {
    let resolve!: (value: { status: string }) => void;
    operation.monolithPhoneOperation.mockReturnValue(new Promise((done) => { resolve = done; }));
    const card = render(request('pending'));
    act(() => card.press('webhook-approve'));
    // The server row moves on while the decision is still in flight.
    card.update(request('expired'));
    await act(async () => resolve({ status: 'approved' }));
    expect(card.subline()).toBe('expired');
  });
});
