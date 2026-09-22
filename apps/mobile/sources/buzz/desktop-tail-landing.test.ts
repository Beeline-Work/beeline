import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { shouldFollowDesktopTail } from './room-scroll-follow';

const chatSource = readFileSync(
  new URL('../app/(app)/beeline/chat/_chat-surface.tsx', import.meta.url),
  'utf8',
);

describe('shouldFollowDesktopTail', () => {
  it('follows while pinned to the tail with no landing anchor or drag in progress', () => {
    expect(
      shouldFollowDesktopTail({
        isPinnedToTail: true,
        isUserDragging: false,
        hasLandingAnchor: false,
      }),
    ).toBe(true);
  });

  it('holds when the reader is not pinned to the tail', () => {
    expect(
      shouldFollowDesktopTail({
        isPinnedToTail: false,
        isUserDragging: false,
        hasLandingAnchor: false,
      }),
    ).toBe(false);
  });

  it('holds mid-drag, even pinned to the tail', () => {
    expect(
      shouldFollowDesktopTail({
        isPinnedToTail: true,
        isUserDragging: true,
        hasLandingAnchor: false,
      }),
    ).toBe(false);
  });

  it('holds while a message anchor (notification, unread boundary) owns the landing', () => {
    expect(
      shouldFollowDesktopTail({
        isPinnedToTail: true,
        isUserDragging: false,
        hasLandingAnchor: true,
      }),
    ).toBe(false);
  });
});

describe('desktop tail-follow wiring (2026-09, superseding eight prior scroll-timing heuristics)', () => {
  it('renders the desktop transcript as a plain scrollable View, not FlatList', () => {
    const desktopBranch = chatSource.slice(
      chatSource.indexOf('{desktopTranscript ? ('),
      chatSource.indexOf(') : (\n          <FlatList'),
    );
    expect(desktopBranch).toContain('ref={setDesktopScrollNode');
    expect(desktopBranch).toContain('ref={setDesktopContentNode');
    expect(desktopBranch).not.toContain('<FlatList');
    expect(desktopBranch).not.toContain('initialNumToRender');
    expect(desktopBranch).not.toContain('maxToRenderPerBatch');
  });

  it('follows an append with one real-DOM assignment, no retry budget or settle window', () => {
    const follow = chatSource.slice(
      chatSource.indexOf('const setDesktopContentNode = useCallback'),
      chatSource.indexOf('const setDesktopScrollNode = useCallback'),
    );
    expect(follow).toContain('shouldFollowDesktopTail({');
    expect(follow).toContain('scrollNode.scrollTop = scrollNode.scrollHeight');
    expect(follow).not.toContain('setTimeout');
    expect(follow).not.toContain('LandingsRef');
    // Regression guard: pin state must come from isPinnedToTailRef (which
    // starts true and is corrected only by a real scroll event), not a
    // fresh scrollHeight/scrollTop/clientHeight read taken here. A cold
    // open has scrollTop still 0 against the full, taller-than-viewport
    // content, so a fresh read at that instant says "not pinned" and the
    // first landing never happens — reproduced and fixed in this corner.
    expect(follow).toContain('isPinnedToTail: isPinnedToTailRef.current');
    expect(follow).not.toMatch(
      /const isPinnedToTail =\s*\n\s*scrollNode\.scrollHeight - scrollNode\.scrollTop/,
    );
  });

  it('holds older-history prepends in place by the real measured growth at the top', () => {
    const prepend = chatSource.slice(
      chatSource.indexOf('desktopPrependOldestIdRef.current'),
      chatSource.indexOf('const landAtNewMessageBoundary ='),
    );
    expect(prepend).toContain('node.scrollTop += node.scrollHeight - previousScrollHeight');
  });

  it('jumps to a message by its row DOM node, not FlatList index math', () => {
    expect(chatSource).toContain('desktopRowNodesRef');
    expect(
      chatSource.match(/\.scrollIntoView\(\{ block: 'center' \}\)/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    // onScrollToIndexFailed is a FlatList-only retry; it stays native-only.
    const desktopBranch = chatSource.slice(
      chatSource.indexOf('{desktopTranscript ? ('),
      chatSource.indexOf(') : (\n          <FlatList'),
    );
    expect(desktopBranch).not.toContain('onScrollToIndexFailed');
  });

  it('no longer imports the retired heuristic decisions', () => {
    expect(chatSource).not.toContain('desktopTailLanding');
    expect(chatSource).not.toContain('tailFollowStalled');
    expect(chatSource).not.toContain('desktopOpenLandingOnContentSizeChange');
    expect(chatSource).not.toContain('cancelDesktopOpenLanding');
  });
});
