import { describe, expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { restoreTranscriptAnchor, visibleTranscriptWindow } from './transcript-presentation';

const prose = (id: string): ChatDisplayMessage => ({
  id,
  text: id,
  isUser: false,
  timestamp: Number(id.replace(/\D/g, '')) || 1,
});

describe('visibleTranscriptWindow', () => {
  it('gives hidden machine receipts no FlatList row or inter-message gap', () => {
    const first = prose('first-1');
    const second = prose('second-2');
    const hiddenCornerReceipt: ChatDisplayMessage = {
      ...prose('hidden-3'),
      corner: { subchannelId: 'corner-1', state: 'waiting' },
    };
    const hiddenAllowedReceipt: ChatDisplayMessage = {
      ...prose('hidden-4'),
      writePermission: {
        permissionId: 'permission-1',
        requestId: 'request-1',
        agentPubkey: 'agent-1',
        tool: 'edit files',
        status: 'allowed',
        subchannelId: 'corner-1',
      },
    };

    // FlatList receives only these two adjacent prose rows. Thus the space
    // between them is exactly LedgerEntry's normal adjacent-message gap: no
    // invisible row can reserve a separator, padding, or recycled height.
    expect(
      visibleTranscriptWindow([first, hiddenCornerReceipt, hiddenAllowedReceipt, second], 30).map(
        (message) => message.id,
      ),
    ).toEqual([first.id, second.id]);
  });

  it('does not let hidden receipts displace early corner prose from a tail window', () => {
    const opening = prose('opening-1');
    const progress = prose('progress-2');
    const hidden = Array.from({ length: 30 }, (_, index) => ({
      ...prose(`hidden-${index + 10}`),
      corner: { subchannelId: `corner-${index}`, state: 'waiting' as const },
    }));

    expect(
      visibleTranscriptWindow([opening, progress, ...hidden], 30).map((message) => message.id),
    ).toEqual([opening.id, progress.id]);
  });
});

describe('restoreTranscriptAnchor', () => {
  it('widens a bounded tail after an arrival, then re-centers the exact origin', () => {
    const messages = Array.from({ length: 30 }, (_, index) =>
      prose(`message-${String(index).padStart(2, '0')}`),
    );
    const originId = messages[0]!.id;
    const resident = [...messages, prose('message-30')];
    let visible = visibleTranscriptWindow(resident, 30).reverse();
    expect(visible.some((candidate) => candidate.id === originId)).toBe(false);

    const reveal = vi.fn((rowsFromNewest: number) => {
      visible = visibleTranscriptWindow(resident, rowsFromNewest).reverse();
    });
    const scroll = vi.fn();
    expect(
      restoreTranscriptAnchor({
        messageId: originId,
        transcriptMessages: visible,
        residentMessages: resident,
        onReveal: reveal,
        onScroll: scroll,
      }),
    ).toBe('revealed');
    expect(reveal).toHaveBeenCalledWith(31);

    expect(
      restoreTranscriptAnchor({
        messageId: originId,
        transcriptMessages: visible,
        residentMessages: resident,
        onReveal: reveal,
        onScroll: scroll,
      }),
    ).toBe('scrolled');
    expect(scroll).toHaveBeenCalledWith(30, 0.5);
    expect(visible[30]!.id).toBe(originId);
  });
});
