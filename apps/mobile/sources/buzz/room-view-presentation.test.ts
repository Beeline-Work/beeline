import { describe, expect, it } from 'vitest';
import type { RoomViewMessage } from '@beeline/buzz-client';
import {
  displayRoomMessage,
  mergeDisplayPages,
  type ChatDisplayMessage,
} from './room-view-presentation';

describe('Room view presentation', () => {
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
      isSystemNotice: true,
      isAgentAuthor: true,
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

  it('projects a landed-corner digest as one typed transcript block', () => {
    const message: RoomViewMessage = {
      id: 'land-digest',
      text: 'Legacy fallback text',
      createdAt: 13,
      author: {
        pubkey: 'd'.repeat(64),
        kind: 'agent',
        name: 'Patch',
      },
      presentation: 'card',
      landSummary: {
        cornerId: 'corner-checksum',
        objective: 'Add checksum verification',
        delivered: '2 commits across 3 files',
        omitted: 'The upload protocol stayed unchanged.',
        branch: 'main',
        tip: '4'.repeat(40),
        url: `https://github.com/acme/widget/commit/${'4'.repeat(40)}`,
        approvedBy: {
          pubkey: 'a'.repeat(64),
          name: 'Ada Lovelace',
          handle: 'ada',
        },
      },
    };

    expect(displayRoomMessage(message, 'a'.repeat(64))).toMatchObject({
      id: 'land-digest',
      landSummary: message.landSummary,
    });
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
