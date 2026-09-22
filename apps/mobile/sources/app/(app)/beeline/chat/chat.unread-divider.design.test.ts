import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The transitions themselves are driven for real in
 * `buzz/use-new-message-control.test.tsx`, which mounts the hook and the
 * production divider cell and makes each failure happen. What is left for this
 * file is the wiring a mounted hook cannot see: that the surface hands the hook
 * the right four inputs, and that no second path to the divider or the control
 * has grown back beside it.
 */
const chatSource = readFileSync(path.join(__dirname, '_chat-surface.tsx'), 'utf8');

describe('the chat surface unread-divider wiring', () => {
  it('draws divider, disc and strip from the one hook, with no second path', () => {
    expect(chatSource).toContain('useNewMessageControl({');
    expect(chatSource).toContain('dividerMessageId: firstNewMessageId');
    expect(chatSource).toContain('discVisible: newestJumpDiscShown');
    expect(chatSource).toContain('badgeCount: newMessageBadgeCount');
    expect(chatSource).toContain('catchUpVisible: catchUpStripShown');
    expect(chatSource).toContain('<RoomCatchUpControls');
    expect(chatSource).toContain('discVisible={newestJumpDiscShown}');
    expect(chatSource).toContain('catchUpVisible={catchUpStripShown}');
    expect(chatSource).toContain('badgeCount={newMessageBadgeCount}');
    // The coupling this change removed, in either of the shapes it had. The
    // bare `?? firstUnreadMessageId` fallback is no longer the tell: the
    // catch-up sheet's range legitimately falls back to the server cursor
    // when nothing has queued yet. What must never come back is the DIVIDER
    // being drawn from the live queue.
    expect(chatSource).not.toContain('firstNewMessageId = newMessageQueue');
    expect(chatSource).not.toContain('dividerMessageId: newMessageQueue');
    expect(chatSource).not.toContain('{newMessageQueue.count > 0 && newMessageQueue.boundaryId &&');
    // The queue is the hook's to move. A setter here would be a way around it.
    expect(chatSource).not.toContain('setNewMessageQueue');
  });

  it('CHEV-01: the disc lands on the tail itself, never on a queued row', () => {
    expect(chatSource).toContain('onJumpToNewest={landAtNewestMessage}');
    const landing = chatSource.slice(
      chatSource.indexOf('const landAtNewestMessage'),
      chatSource.indexOf('// Only a different tail row is an arrival'),
    );
    expect(landing).toContain('scrollToNewestMessage()');
    expect(landing).not.toContain('landAtNewMessageBoundary');
  });

  it('CHEV-14: all three catch-up doors go through the one report', () => {
    // The composer verb, the strip, and the badge long-press open the same
    // sheet over the same range. The verb used to scroll to the first unread
    // row on its own, which is a fourth answer about a Room the other two
    // were already describing.
    expect(chatSource).toContain("case 'catch-up':\n          openCatchUpSheet();");
    expect(chatSource).toContain('onOpenCatchUp={openCatchUpSheet}');
    const report = chatSource.slice(
      chatSource.indexOf('buildCatchUpReport({'),
      chatSource.indexOf('const openCatchUpSheet'),
    );
    expect(report).toContain('boundaryId: catchUpBoundaryId');
    expect(report).toContain('newestId: newestTranscriptMessageId');
    // Requester identities reach that seam, for the asks a row's author did
    // not make (a permission card names its requester by pubkey).
    expect(report).toContain('identities: conversationIdentities');
  });

  it('CHEV-02: the pill is gone from the surface, plate, label and all', () => {
    expect(chatSource).not.toContain('newMessageControlPlate');
    expect(chatSource).not.toContain('newMessageControlShown');
    expect(chatSource).not.toContain('} new\n');
    // The disc and strip are one component's business, not a second styling
    // path grown beside it.
    expect(chatSource).not.toContain('newestJumpDisc:');
    expect(chatSource).not.toContain('catchUpStrip:');
  });

  it('gives the hook the server cursor, the folded rows, and the arriving ids', () => {
    const call = chatSource.slice(
      chatSource.indexOf('useNewMessageControl({'),
      chatSource.indexOf('const transcriptLandingAnchorId'),
    );
    expect(call).toContain('roomId: decodedId');
    expect(call).toContain('queueableMessages: foldedMessages');
    expect(call).toContain('arrivingIds: transcriptArrivalObservation.arrivingIds');
    expect(call).toContain('newestMessageId: newestTranscriptMessageId');
    expect(call).toContain('firstUnreadMessageId,');
    // Tail distance reaches the hook for queueing only; what the control shows
    // is decided by the viewability pass below.
    expect(call).toContain('isPinnedToTail: () => isPinnedToTailRef.current');
  });

  it('feeds the hook the list’s own viewability pass', () => {
    const observer = chatSource.slice(
      chatSource.indexOf('const observeVisibleTranscriptMessages'),
      chatSource.indexOf('const landAtNewMessageBoundary'),
    );
    expect(observer).toContain('observeVisibleMessages(visibleTranscriptMessagesRef.current)');
    expect(chatSource).toContain('onViewableItemsChanged={observeVisibleTranscriptMessages}');
  });

  it('keeps the unread boundary out of the fold without consulting the live queue', () => {
    expect(chatSource).toContain('boundaryRowIndex(anchored, firstUnreadMessageId)');
  });

  it('reports the newest row from chronological order so both lists agree', () => {
    expect(chatSource).toContain('newestTranscriptRowId(visibleMessages)');
  });
});
