import { describe, it, expect } from 'vitest';
import { signEvent, type NostrEvent } from '@buzzy/nostr';
import { createIdentity } from './identity.js';
import {
  classifySessionEvent,
  isAgentActivity,
  parseMembersEvent,
  sortEventsChronological,
  tagValue,
  toSessionEvent,
} from './parse.js';
import { KIND_CHANNEL_MEMBERS, KIND_STREAM_MESSAGE, TAG_AGENT_ACTIVITY } from './kinds.js';

const id = createIdentity('t');

function msg(tags: string[][], content: string, created_at = 1000): NostrEvent {
  return signEvent(
    {
      pubkey: id.publicKey,
      created_at,
      kind: KIND_STREAM_MESSAGE,
      tags,
      content,
    },
    id.secretKey,
  );
}

describe('parse helpers', () => {
  it('classifies agent-activity vs message', () => {
    const human = msg(
      [
        ['h', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
        ['t', 'chat'],
      ],
      'hi',
    );
    const activity = msg(
      [
        ['h', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
        ['t', TAG_AGENT_ACTIVITY],
      ],
      'tool: shell',
    );
    expect(classifySessionEvent(human)).toBe('message');
    expect(isAgentActivity(activity)).toBe(true);
    expect(classifySessionEvent(activity)).toBe('agent-activity');
  });

  it('toSessionEvent requires h tag', () => {
    const noH = msg([['t', 'x']], 'nope');
    const withH = msg([['h', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']], 'yep');
    expect(toSessionEvent(noH)).toBeNull();
    expect(toSessionEvent(withH)?.content).toBe('yep');
  });

  it('parseMembersEvent reads p tags', () => {
    const ev = signEvent(
      {
        pubkey: id.publicKey,
        created_at: 1,
        kind: KIND_CHANNEL_MEMBERS,
        tags: [
          ['d', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
          ['p', 'aa'.repeat(32)],
          ['p', 'bb'.repeat(32), 'admin'],
        ],
        content: '',
      },
      id.secretKey,
    );
    const members = parseMembersEvent(ev);
    expect(members).toHaveLength(2);
    expect(members[0]?.pubkey).toBe('aa'.repeat(32));
    expect(members[1]?.role).toBe('admin');
  });

  it('sortEventsChronological is stable by created_at then id', () => {
    const a = msg([['h', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']], 'a', 10);
    const b = msg([['h', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']], 'b', 20);
    const c = msg([['h', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']], 'c', 15);
    const sorted = sortEventsChronological([b, a, c]);
    expect(sorted.map((e) => e.content)).toEqual(['a', 'c', 'b']);
  });

  it('tagValue finds first match', () => {
    const ev = msg(
      [
        ['h', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
        ['t', 'one'],
        ['t', 'two'],
      ],
      'x',
    );
    expect(tagValue(ev, 't')).toBe('one');
    expect(tagValue(ev, 'missing')).toBeUndefined();
  });
});
