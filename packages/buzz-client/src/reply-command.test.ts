import { describe, expect, it } from 'vitest';
import { createIdentity } from './identity.js';
import { buildReplyCommand } from './reply-command.js';
import type { KnownMessageReference } from './room-view.js';

function proof(input: { eventId: string; rootId: string }): KnownMessageReference {
  return { channelId: 'room', ...input } as KnownMessageReference;
}

describe('reply command builder', () => {
  it('uses the parent proof verbatim for nested NIP-10 ancestry', () => {
    const event = buildReplyCommand(
      createIdentity('reply-author'),
      'Nested reply',
      proof({ eventId: 'parent', rootId: 'root' }),
      {
        mentionAgent: 'agent',
        contentTags: [['imeta', 'url https://example.test/image.jpg']],
      },
    );
    expect(event.tags).toEqual([
      ['h', 'room'],
      ['p', 'agent'],
      ['e', 'root', '', 'root'],
      ['e', 'parent', '', 'reply'],
      ['imeta', 'url https://example.test/image.jpg'],
    ]);
  });

  it('omits the redundant root marker for a reply to the root event', () => {
    const event = buildReplyCommand(
      createIdentity('reply-author'),
      'Root reply',
      proof({ eventId: 'root', rootId: 'root' }),
    );
    expect(event.tags).toEqual([
      ['h', 'room'],
      ['e', 'root', '', 'reply'],
    ]);
  });

  it('rejects structural tags outside the opaque proof', () => {
    expect(() =>
      buildReplyCommand(
        createIdentity('reply-author'),
        'Bad reply',
        proof({ eventId: 'parent', rootId: 'root' }),
        {
          contentTags: [['e', 'wrong-root', '', 'root']],
        },
      ),
    ).toThrow('builder-owned');
  });
});
