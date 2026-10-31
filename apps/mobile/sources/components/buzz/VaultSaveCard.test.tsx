import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { VaultSaveCard as Card } from '@beeline/api-contract/phone';

const http = vi.hoisted(() => vi.fn()), socket = vi.hoisted(() => vi.fn());
vi.mock('@/auth/monolith-session', () => ({ monolithSession: { fetch: http } }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ request: socket }) }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://proof.test' }) }));
vi.mock('react-native', () => ({ Text: 'Text', View: 'View', AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock('./TranscriptCard', () => ({ TranscriptCard: (props: any) => React.createElement('TranscriptCard', props, props.children) }));
vi.mock('./HullDialog', () => ({ HullDialogInput: (props: any) => React.createElement('Input', props) }));
vi.mock('./Button', () => ({ Button: () => null }));
vi.mock('./IdentityMark', () => ({ IdentityMark: () => null }));
import { VaultSaveCard } from './VaultSaveCard';

it('keeps Save to vault on HTTP and clears the submitted secret', async () => {
  const card: Card = { service: 'proof', label: 'example', purpose: 'Test private submission', authStrategy: 'api_key',
    allowedHosts: ['example.com'], fields: [{ name: 'password', label: 'Password', secret: true }],
    agentId: 'agent', ownerId: 'owner', ownerName: 'Owner', status: 'pending' };
  http.mockResolvedValueOnce(Response.json({ status: 'saved', card: { ...card, status: 'saved', savedAt: 123, reference: 'vault://proof/example' } }));
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<VaultSaveCard card={card} cardId="card" roomId="room" viewerId="owner" agentName="Agent" />); });
    await act(async () => { renderer.root.findByType('Input' as any).props.onChangeText('throwaway-secret'); });
    await act(async () => {
      const save = renderer.root.findByType('TranscriptCard' as any).props.actions.find((action: any) => action.label === 'Save to vault');
      expect(save.disabled).toBe(false); save.onPress();
    });
    expect(http).toHaveBeenCalledExactlyOnceWith('https://proof.test/v1/vault-save/submit',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ cardId: 'card', roomId: 'room', values: { password: 'throwaway-secret' } }) }),
      { timeoutMs: 75_000, idempotent: false });
    expect(socket).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType('Input' as any)).toHaveLength(0);
    expect(renderer.root.findByType('TranscriptCard' as any).props.footerNote).toContain('Saved by you');
  } finally { await act(async () => { renderer?.unmount(); }); }
});
