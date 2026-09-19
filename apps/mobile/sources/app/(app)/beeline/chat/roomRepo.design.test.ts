import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source assertions for the Room→repo Stage 2 app UI, in the same style as
 * `roomIndicators.test.ts`: this giant screen has no render harness, so the
 * structural guarantees are checked as text — same technique
 * `no-foreground-blocking.test.ts` uses for the hydration contract.
 */
const chatSource = readFileSync(new URL('./chat-surface.tsx', import.meta.url), 'utf8');
const subtitleSource = readFileSync(
  new URL('../../../../components/buzz/RoomRepositorySubtitle.tsx', import.meta.url),
  'utf8',
);

function blockFrom(source: string, marker: string, label: string): string {
  const start = source.indexOf(marker);
  expect(start, `missing ${label}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  const braceStart = source.indexOf('{', start);
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed ${label}`);
}

describe('Room→repo header chip', () => {
  it('renders only for a Room with a bound repo, never a corner', () => {
    const subtitleIndex = chatSource.indexOf('<RoomRepositorySubtitle');
    expect(subtitleIndex).toBeGreaterThanOrEqual(0);
    const guardStart = chatSource.lastIndexOf('{!isCorner && (', subtitleIndex);
    expect(guardStart, 'repo subtitle must be gated on !isCorner').toBeGreaterThanOrEqual(0);
    expect(guardStart).toBeLessThan(subtitleIndex);
    expect(subtitleSource).toContain('if (!name) return null;');
  });

  it('shows the bare repo slug — no "REPO" label prefix', () => {
    // Owner trim (2026-08-23): the URL/slug already says what it is.
    expect(chatSource).toContain('repositoryName={roomRepoChipLabel(roomRepository)}');
    expect(subtitleSource).toContain('{name}</HeaderMetaCaps>');
    expect(subtitleSource).not.toMatch(/>REPO</);
  });

  it('routes the repository subtitle through the transcript URL opener, not Room settings', () => {
    expect(chatSource).toContain('onOpenUrl={handleOpenGitHubEvent}');
    expect(chatSource).toContain('repositoryName={roomRepoChipLabel(roomRepository)}');
    const subtitle = blockFrom(chatSource, '<RoomRepositorySubtitle', 'Room repository subtitle');
    expect(subtitle).not.toContain('setRoomActionsVisible(true)');
  });

  it('uses the server-indexed tri-state rather than treating every loaded surface as none', () => {
    expect(chatSource).toContain('const roomRepositoryState = roomSurface?.repositoryResolution;');
    expect(chatSource).toContain("const roomRepositoryResolved = roomRepositoryState === 'none';");
    expect(chatSource).toContain("if (roomRepositoryState !== 'none' && !roomRepoAccessIssue)");
    expect(chatSource).not.toContain('const roomRepositoryResolved = Boolean(roomSurface);');
  });
});

describe('Room→repo corner-open lazy prompt', () => {
  it('short-circuits message submission on a repo-less Room before the composer is cleared', () => {
    const handleSend = blockFrom(chatSource, 'const handleSend = useCallback(', 'handleSend');
    const guardIndex = handleSend.indexOf('looksLikeCornerOpenIntent(rawText)');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(handleSend).toContain('roomRepoAccessIssue');
    expect(handleSend).toContain('roomRepositoryResolved');
    // The composer must not be cleared before this guard — it sits before the
    // optimistic-message / setInputText('') side effects.
    expect(handleSend.indexOf("setInputText('')")).toBeGreaterThan(
      handleSend.indexOf('setCornerOpenRepoPrompt(true)'),
    );
  });

  it('sends proposal shortcuts without consuming the composer draft or its attachments', () => {
    const handleSend = blockFrom(chatSource, 'const handleSend = useCallback(', 'handleSend');
    // A leaked responder event must never read as a shortcut: only an object
    // carrying text qualifies, so a PressEvent cannot skip the clear block.
    expect(handleSend).toContain(
      "const sendShortcut = shortcut && typeof shortcut.text === 'string' ? shortcut : undefined;",
    );
    expect(handleSend).toContain(
      'const activePendingAttachments = sendShortcut ? [] : pendingAttachmentsRef.current;',
    );
    expect(handleSend).toContain(
      'sendShortcut ? NO_SELECTED_MENTIONS : selectedMentionsRef.current',
    );
    expect(handleSend).toMatch(/if \(!sendShortcut\) \{[\s\S]*setInputText\(''\)/);
    expect(chatSource).toContain("text: decision === 'open' ? 'go' : 'cancel'");
  });

  it('clears text, quoted replies, and attachments together after ordinary dispatch', () => {
    const handleSend = blockFrom(chatSource, 'const handleSend = useCallback(', 'handleSend');
    const clearBlock = blockFrom(handleSend, 'if (!sendShortcut) {', 'composer clear');
    expect(clearBlock).toContain("inputTextRef.current = '';");
    expect(clearBlock).toContain("setInputText('');");
    expect(clearBlock).toContain(
      'current.filter((attachment) => !activePendingAttachments.includes(attachment))',
    );
    expect(clearBlock).toContain('setReplyTarget(null);');
    expect(handleSend.indexOf('if (!sendShortcut) {')).toBeGreaterThan(
      handleSend.indexOf('addMessages([optimistic]);'),
    );
  });

  it('shows the repo access guidance in the prompt', () => {
    const banner = blockFrom(
      chatSource,
      '{cornerOpenRepoPrompt && (',
      'corner-open repo prompt banner',
    );
    expect(banner).toContain('Ask a');
    expect(banner).toContain('ACCESS TO THIS REPO WAS REVOKED');
    expect(banner).toContain('Add this repo to the Beeline installation');
  });
});

describe('Room→repo write confirmation', () => {
  it('retries the indexed read and only errors on a definitive competing write', () => {
    const apply = blockFrom(
      chatSource,
      'const applyRoomRepository = useCallback(',
      'room repository apply',
    );
    expect(apply).toContain('const published = await transport.roomRepositorySet');
    expect(apply).toContain('await confirmRoomRepositoryLink(');
    expect(apply).toContain('published.updatedAt');
    expect(apply).toContain("confirmation === 'contradicted'");
    expect(apply).toContain("confirmation === 'pending'");
    expect(apply).toContain('Repo link accepted. The Room is still syncing.');
    expect(apply).not.toContain('Room did not confirm it');
    expect(apply.indexOf('setShowRoomRepoPicker(false)')).toBeGreaterThan(
      apply.indexOf('await confirmRoomRepositoryLink('),
    );
  });
});

describe('Room→repo settings change', () => {
  it('confirms before re-binding a repo out from under a Room with open corners', () => {
    const handler = blockFrom(
      chatSource,
      'const handleSelectRoomRepoCandidate = useCallback(',
      'handleSelectRoomRepoCandidate',
    );
    expect(handler).toContain('roomListCorners(cornerLifecycle)');
    expect(handler).toContain('Modal.confirm');
    expect(handler).toContain('roomRepository && hasOpenCorners');
  });

  it('unassigns the repo only through the confirmed destructive path', () => {
    const handler = blockFrom(
      chatSource,
      'const handleUnlinkRoomRepository = useCallback(',
      'handleUnlinkRoomRepository',
    );
    expect(handler).toContain('Modal.confirm');
    expect(handler).toContain("confirmText: 'Unlink repo'");
    expect(handler).toContain('destructive: true');
    // The write is the dedicated unassign operation, never a set with empty values.
    expect(handler).toContain('transport.roomRepositoryRemove(decodedId)');
    expect(handler).not.toContain('roomRepositorySet');
    // Nothing room-side beyond the binding is claimed destroyed.
    expect(handler).toContain('messages and history are untouched');
    // The affordance lives inside the expanded picker and is wired only for a
    // manager looking at a Room with a bound repository.
    expect(chatSource).toContain('canManageWorkspace && roomRepository');
    expect(chatSource).toContain('onUnlink={');
    expect(chatSource).toContain('unlinkRepositoryName={roomRepository?.binding.name}');
  });
});
