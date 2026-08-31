import { describe, expect, it } from 'vitest';
import type { RoomViewMessage } from '@beeline/buzz-client';
import {
  conversationIdentityByPubkey,
  cornerSummaries,
  createRoomMessageProjector,
  displayRoomMessage,
  mergeDisplayPages,
  type ChatDisplayMessage,
} from './room-view-presentation';

describe('Room view presentation', () => {
  it('uses the child turn receipt time for a working corner instead of stale metadata', () => {
    const receiptAt = Math.floor(Date.now() / 1_000);
    const [corner] = cornerSummaries({
      corners: [
        {
          corner: {
            id: '80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
            workspaceId: 'ec08be9d-9d9d-413e-b546-959d4abe39df',
            parentId: '7d111868-52eb-43ab-98ae-8a6c49b92da8',
            name: 'Receipt-driven corner',
            archived: false,
            createdAt: 1,
            updatedAt: 1,
          },
          lifecycle: { lifecycle: 'WORKING' },
          status: 'working',
          statusAt: receiptAt,
        },
      ],
    });

    expect(corner).toMatchObject({
      machineState: 'working',
      status: 'live',
      stateAt: receiptAt,
    });
  });

  it('presents a review corner as live while a fresh steering turn is working', () => {
    const receiptAt = Math.floor(Date.now() / 1_000);
    const [corner] = cornerSummaries({
      corners: [
        {
          corner: {
            id: '80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
            workspaceId: 'ec08be9d-9d9d-413e-b546-959d4abe39df',
            parentId: '7d111868-52eb-43ab-98ae-8a6c49b92da8',
            name: 'Review steering corner',
            archived: false,
            createdAt: 1,
            updatedAt: 1,
          },
          lifecycle: { lifecycle: 'REVIEW' },
          status: 'working',
          statusAt: receiptAt,
          reason: 'review',
        },
      ],
    });

    expect(corner).toMatchObject({
      machineState: 'working',
      status: 'live',
      stateAt: receiptAt,
    });
  });

  it('keeps an indexed system row visible as a system notice', () => {
    const message: RoomViewMessage = {
      id: 'system-notice',
      text: 'A scheduled run is paused.',
      createdAt: 12,
      author: {
        pubkey: 'b'.repeat(64),
        kind: 'agent',
        name: 'Pi agent',
      },
      presentation: 'system',
    };

    expect(displayRoomMessage(message, 'a'.repeat(64))).toMatchObject({
      id: 'system-notice',
      text: 'A scheduled run is paused.',
      authorIdentity: message.author,
      isSystemNotice: true,
      isAgentAuthor: true,
    });
  });

  it('re-resolves a stale roster label from each current server message projection', () => {
    const agentPubkey = 'b'.repeat(64);
    const viewerPubkey = 'a'.repeat(64);
    const staleMember = {
      identity: { pubkey: agentPubkey, kind: 'agent' as const, name: 'Arlo', handle: 'arlo' },
      role: 'member' as const,
    };
    const indexedMessage = (name: string, handle: string): RoomViewMessage => ({
      id: 'identity-message',
      text: `Hello from ${name}`,
      createdAt: 12,
      author: { pubkey: agentPubkey, kind: 'agent', name, handle },
      presentation: 'message',
    });
    const projector = createRoomMessageProjector();

    const cached = projector.project([indexedMessage('Arlo', 'arlo')], viewerPubkey);
    expect(conversationIdentityByPubkey([staleMember], cached).get(agentPubkey)?.name).toBe('Arlo');

    const fresh = projector.project([indexedMessage('Codex', 'codex')], viewerPubkey);
    expect(fresh[0]).not.toBe(cached[0]);
    expect(conversationIdentityByPubkey([staleMember], fresh).get(agentPubkey)).toMatchObject({
      name: 'Codex',
      handle: 'codex',
    });
  });

  it('keeps a GitHub card out of speaker attribution', () => {
    const message: RoomViewMessage = {
      id: 'github-card',
      text: '',
      createdAt: 12,
      author: {
        pubkey: 'd'.repeat(64),
        kind: 'human',
        name: 'PERSON DDDDDDDD',
      },
      presentation: 'card',
      githubEvent: {
        type: 'pull-request',
        action: 'opened',
        actor: 'lena',
        title: 'Ship the card',
        url: 'https://github.com/acme/widget/pull/7',
      },
    };

    expect(displayRoomMessage(message, 'a'.repeat(64))).toEqual(
      expect.objectContaining({
        id: 'github-card',
        githubEvent: message.githubEvent,
      }),
    );
    expect(displayRoomMessage(message, 'a'.repeat(64))).not.toHaveProperty('pubkey');
    expect(displayRoomMessage(message, 'a'.repeat(64))).not.toHaveProperty('isAgentAuthor');
  });

  it('orders response, paged history, signed outbox, and live-overlay partitions by time', () => {
    const message = (id: string, timestamp: number): ChatDisplayMessage => ({
      id,
      text: id,
      isUser: id === 'stale-outbox',
      timestamp,
    });

    expect(
      mergeDisplayPages(
        [message('older-page', 10)],
        [message('server-tail', 40)],
        [message('stale-outbox', 20)],
        [message('live-overlay', 30)],
      ).map((item) => item.id),
    ).toEqual(['older-page', 'stale-outbox', 'live-overlay', 'server-tail']);
  });
});
