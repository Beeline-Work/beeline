import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '@/sync/transport';
import {
  latestRoomMessage,
  latestRoomMessageSummary,
  previewAuthorLabel,
  roomPreviewText,
} from './room-list-summary';

function message(
  content: string,
  createdAt: number,
  tags: string[][] = [],
  pubkey?: string,
): SessionEvent {
  return {
    type: 'raw',
    sessionId: 'room-1',
    payload: { id: `event-${createdAt}`, content, createdAt, tags, ...(pubkey ? { pubkey } : {}) },
  };
}

describe('Room list summary', () => {
  it('returns the newest conversational message', () => {
    expect(latestRoomMessage([message('first', 1), message('latest room note', 3)])).toBe(
      'latest room note',
    );
  });

  it('breaks same-second ties by event id so cache refreshes are deterministic', () => {
    expect(
      latestRoomMessageSummary([
        message('first in second', 3),
        {
          ...message('second in second', 3),
          payload: { id: 'event-z', content: 'second in second', createdAt: 3, tags: [] },
        },
      ]),
    ).toMatchObject({ id: 'event-z', text: 'second in second', timestamp: 3 });
  });

  it('does not let a malformed tag (non-string element) masquerade as a real subchannel/control tag', () => {
    // Regression: hasTag() previously only checked candidate[0]/candidate[1],
    // unlike the 3 sibling tag-shape validators (buzz-event-projection.ts,
    // agent-presence.ts, agent-draft.ts) which reject any tag containing a
    // non-string element outright. A corrupted tag like this used to be
    // silently tolerated as a genuine `subchannel` marker and hid a real
    // message from the Room list summary.
    expect(
      latestRoomMessage([
        message('keep me', 1),
        message('looks like a corner-open message but is not', 2, [
          ['subchannel', 'corner-1', 42 as unknown as string],
        ]),
      ]),
    ).toBe('looks like a corner-open message but is not');
  });

  it('ignores Corner control records and agent activity', () => {
    const activity: SessionEvent = {
      type: 'assistant_delta',
      sessionId: 'room-1',
      text: 'running tests',
      seq: 4,
    };
    expect(
      latestRoomMessage([
        message('keep me', 1),
        message('Agent opened #fix-tests', 2, [['subchannel', 'corner-1']]),
        message('control', 3, [['t', 'body-control']]),
        activity,
      ]),
    ).toBe('keep me');
  });

  it('carries the author so the index can attribute the preview', () => {
    expect(latestRoomMessageSummary([message('shipped it', 3, [], 'author-pubkey')])).toMatchObject({
      text: 'shipped it',
      authorPubkey: 'author-pubkey',
    });
    expect(latestRoomMessageSummary([message('anonymous', 3)])?.authorPubkey).toBeUndefined();
  });
});

describe('roomPreviewText', () => {
  it('flattens a multi-line message onto one scannable line', () => {
    expect(roomPreviewText('first line\n\nsecond   line\n')).toBe('first line second line');
  });

  it('drops fenced code rather than pasting a diff into the index', () => {
    expect(roomPreviewText('here is the fix\n```ts\nconst a = 1;\n```\nships tomorrow')).toBe(
      'here is the fix ships tomorrow',
    );
    // An unterminated fence (a message cut off mid-block) must not leak either.
    expect(roomPreviewText('look:\n```\nsecret = 1')).toBe('look:');
  });

  it('renders markdown as the words it displays, not its syntax', () => {
    expect(roomPreviewText('## Status\n- **done**: `npm test` passes')).toBe(
      'Status done: npm test passes',
    );
    expect(roomPreviewText('see [the plan](https://example.test/a/b)')).toBe('see the plan');
    expect(roomPreviewText('> quoted reply')).toBe('quoted reply');
    expect(roomPreviewText('---\nafter a rule')).toBe('after a rule');
  });

  it('collapses a bare URL to its host', () => {
    expect(roomPreviewText('deployed to https://relay.buzzrouter.com/health now')).toBe(
      'deployed to relay.buzzrouter.com now',
    );
  });

  it('never shows raw git or tool plumbing (the #195 shapes)', () => {
    // Every one of these is a line body used to publish verbatim before #195.
    const plumbing = [
      'To https://github.com/acme/beeline.git\n ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs\nhint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart.',
      'diff --git a/src/a.ts b/src/a.ts\nindex 1a2b3c4..5d6e7f8 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,4 +1,4 @@',
      'fatal: could not read Username for https://github.com',
      '$ git push --force-with-lease\nremote: Permission to acme/beeline.git denied',
    ];
    for (const raw of plumbing) {
      expect(roomPreviewText(raw)).toBe('');
    }
  });

  it('keeps a human sentence that merely mentions git, and shortens a bare sha', () => {
    expect(roomPreviewText('The change could not be delivered automatically.')).toBe(
      'The change could not be delivered automatically.',
    );
    expect(roomPreviewText('landed 0123456789abcdef0123456789abcdef01234567 on main')).toBe(
      'landed 0123456 on main',
    );
  });

  it('truncates with an ellipsis instead of overflowing the row', () => {
    const preview = roomPreviewText('x'.repeat(400));
    expect(preview).toHaveLength(120);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('suppresses a bare ref or object id rather than dressing it up as a sentence', () => {
    // The #195 shape: a message that is nothing but a git pointer. Shortening
    // the sha made it *worse* — a recognizably machine-shaped 40-hex blob
    // turned into a plausible-looking `remote/1a2b3c4` on the index.
    for (const plumbing of [
      'remote/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
      'refs/heads/beeline/corner-4f2a',
      'origin/main',
      '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
      'upstream/feature 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    ]) {
      expect(roomPreviewText(plumbing), plumbing).toBe('');
    }
    for (const line of [
      '* [new branch]      main -> main',
      '! [rejected]        main -> main (fetch first)',
      '[up to date]        main -> main',
      'abc1234..def5678  main -> main',
      '+ abc1234...def5678 main -> main (forced update)',
      'Everything up-to-date',
      "Branch 'main' set up to track 'origin/main'.",
      'refs/heads/main -> refs/remotes/origin/main',
    ]) {
      expect(roomPreviewText(line), line).toBe('');
    }
  });

  it('never mistakes an ordinary word for an object id', () => {
    // `[0-9a-f]{7,}` alone would swallow real words spelled out of a–f. A bare
    // object id carries a digit; a word does not.
    expect(roomPreviewText('defaced')).toBe('defaced');
    expect(roomPreviewText('effaced facade')).toBe('effaced facade');
    expect(roomPreviewText('deadbeef')).toBe('deadbeef');
    expect(roomPreviewText('dead1beef')).toBe('');
  });

  it('keeps a sentence that merely mentions a ref, shortening the id inside it', () => {
    // Suppression is for a preview that is *only* plumbing. Real prose around
    // a pointer is exactly what a person wants to read.
    expect(
      roomPreviewText('Pushed 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b to origin/main for review'),
    ).toBe('Pushed 1a2b3c4 to origin/main for review');
    expect(roomPreviewText('remote/main is ahead now')).toBe('remote/main is ahead now');
  });

  it('is what the latest-message projection stores, so an all-plumbing message keeps the prior preview', () => {
    expect(
      latestRoomMessage([
        message('real discussion here', 1),
        message('hint: Updates were rejected because the remote contains work', 2),
      ]),
    ).toBe('real discussion here');
  });
});

describe('previewAuthorLabel', () => {
  it('shouts the name in mono, matching the transcript row label', () => {
    expect(previewAuthorLabel('Bobby')).toBe('BOBBY');
    expect(previewAuthorLabel('You')).toBe('YOU');
  });

  it('stays unattributed rather than shouting an unresolvable identity', () => {
    expect(previewAuthorLabel(undefined)).toBe('');
    expect(previewAuthorLabel('   ')).toBe('');
  });

  it('bounds a long name so it cannot crowd out the preview it labels', () => {
    // The ellipsis counts against the bound, so the label never exceeds it.
    expect(previewAuthorLabel('Extraordinarily Long Name')).toBe('EXTRAORDINA…');
    expect(previewAuthorLabel('Extraordinarily Long Name')).toHaveLength(12);
  });
});
