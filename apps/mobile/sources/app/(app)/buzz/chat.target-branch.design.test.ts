import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source assertions for the target-branch proposal surface that has no render
 * harness of their own — same technique as `channels.repo.design.test.ts`.
 *
 * What is being pinned is *authority* and *honesty*, not looks: the confirm
 * writes under the viewer's own key through the owner-gated transport call,
 * a non-owner gets a plain refusal instead of a silently-ignored publish, and
 */
const source = readFileSync(path.join(__dirname, 'chat', '[channelId].tsx'), 'utf8');
const variants = readFileSync(path.join(__dirname, 'chat', 'RoomMessageVariants.tsx'), 'utf8');
const transport = readFileSync(
  path.join(__dirname, '..', '..', '..', 'sync', 'transport', 'buzz-rig-transport.ts'),
  'utf8',
);

function blockFrom(text: string, marker: string, label: string): string {
  const start = text.indexOf(marker);
  expect(start, `missing ${label}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = text.indexOf('{', start); index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed ${label}`);
}

describe('the target-branch proposal card', () => {
  const handler = blockFrom(
    source,
    'const handleConfirmTargetBranch = useCallback(',
    'handleConfirmTargetBranch',
  );

  it('refuses a non-owner with a plain sentence before touching the relay', () => {
    const guardIndex = handler.indexOf("viewerChannelRole !== 'owner'");
    const writeIndex = handler.indexOf('transport.roomTargetBranchSet(');
    expect(guardIndex, 'the admin guard must exist').toBeGreaterThanOrEqual(0);
    expect(writeIndex, 'the confirm must write through the transport').toBeGreaterThan(guardIndex);
    expect(handler).toContain('owner can change the target branch');
    // The agent is never the confirming party, even if it is the viewer.
    expect(handler).toContain('viewerIsAgent');
  });

  it('publishes through the owner-authored room-repository path, never a new wire', () => {
    expect(transport).toContain('.setRoomTargetBranch(channelId, targetBranch)');
    // The daemon has no method here at all — this transport belongs to the app.
    expect(handler).not.toContain('postControlMessage');
  });

  it('renders a Confirm control only for the owner, and an applied state otherwise', () => {
    const card = variants.slice(
      variants.indexOf('export const TargetBranchProposalCard'),
      variants.indexOf('export interface GitHubEventCardProps'),
    );
    expect(card).toContain('testID="target-branch-confirm"');
    expect(card).toContain('testID="target-branch-denied"');
    expect(card).toContain('testID="target-branch-applied"');
    // The applied state is read from published Room state, not from a local
    // "I tapped it" flag, so it survives a reload and can never lie.
    expect(card).toContain('currentTargetBranch === proposal.to');
    expect(card).toContain("viewerRole === 'owner'");
    expect(card).toContain('automatically rebase onto');
    expect(card).toContain('activity ledger');
  });
});
