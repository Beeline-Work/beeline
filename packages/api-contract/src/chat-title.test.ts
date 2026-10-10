import { describe, expect, it } from 'vitest';
import {
  cornerShortTitle,
  cornerTitle,
  directMessageTitle,
  identityHandle,
  roomTitle,
} from './chat-title.js';
import { readClearChannelIds, readClearPushData } from './push-actions.js';

describe('roomTitle', () => {
  it('marks a stored name once and never decorates a missing one', () => {
    expect(roomTitle('Roadmap')).toBe('#Roadmap');
    expect(roomTitle('  #Roadmap ')).toBe('#Roadmap');
    expect(roomTitle('##Roadmap')).toBe('#Roadmap');
    expect(roomTitle('')).toBeUndefined();
    expect(roomTitle('   ')).toBeUndefined();
    expect(roomTitle(null)).toBeUndefined();
  });
});

describe('cornerTitle', () => {
  it('composes #<room>/<corner> from stored names', () => {
    expect(cornerTitle('Roadmap', 'fix-ledger-drift', 'abc12345')).toBe(
      '#Roadmap/fix-ledger-drift',
    );
    expect(cornerTitle('#Roadmap', '#fix-ledger-drift', 'abc12345')).toBe(
      '#Roadmap/fix-ledger-drift',
    );
  });

  // Audit 9.1: the header used to keep a legacy `room/` prefix the list dropped.
  it('reads a legacy room-prefixed name the same way on every surface', () => {
    expect(cornerTitle('alpha', 'alpha/fix-auth', 'abcdef0123')).toBe('#alpha/fix-auth');
    expect(cornerTitle('#alpha', '#alpha/fix-auth', 'abcdef0123')).toBe('#alpha/fix-auth');
    expect(cornerTitle('alpha', 'ALPHA/fix-auth', 'abcdef0123')).toBe('#alpha/fix-auth');
    expect(cornerShortTitle('alpha', 'alpha/fix-auth', 'abcdef0123')).toBe('fix-auth');
  });

  it('strips only an exact room segment', () => {
    expect(cornerTitle('alpha', 'alphabet-soup', 'abcdef0123')).toBe('#alpha/alphabet-soup');
    expect(cornerTitle('alpha', 'alpha-two/fix', 'abcdef0123')).toBe('#alpha/alpha-two/fix');
  });

  it('degrades to #<corner> while the parent name is unknown', () => {
    expect(cornerTitle(undefined, 'fix-auth', 'abcdef0123')).toBe('#fix-auth');
    expect(cornerTitle(null, 'fix-auth', 'abcdef0123')).toBe('#fix-auth');
    expect(cornerTitle('   ', 'fix-auth', 'abcdef0123')).toBe('#fix-auth');
  });

  it('falls back to the id slug for an empty or generated name', () => {
    expect(cornerTitle('Roadmap', undefined, 'abc12345ffff')).toBe('#Roadmap/corner-abc12345');
    expect(cornerTitle('Roadmap', '   ', 'abc12345ffff')).toBe('#Roadmap/corner-abc12345');
    expect(cornerTitle('Roadmap', 'sub-9f9f9f', 'abc12345ffff')).toBe('#Roadmap/corner-abc12345');
    expect(cornerTitle('alpha', 'alpha/', 'abc12345ffff')).toBe('#alpha/corner-abc12345');
  });
});

describe('directMessageTitle', () => {
  it('uses the handle local part, else the name, behind one @', () => {
    expect(directMessageTitle({ name: 'Maya', handle: '@maya@usebeeline.app' })).toBe('@maya');
    expect(directMessageTitle({ name: 'Maya', handle: null })).toBe('@Maya');
    expect(identityHandle({ name: 'Maya', handle: '@@maya' })).toBe('maya');
    expect(directMessageTitle({ name: 'Alice', handle: '@@alice@host' })).toBe('@alice');
  });

  it('falls back to the display name for an empty handle', () => {
    expect(identityHandle({ name: 'Alice', handle: '' })).toBe('Alice');
    expect(identityHandle({ name: 'Alice', handle: '  @ ' })).toBe('Alice');
  });

  it('names Trusty Squire by its display name', () => {
    expect(directMessageTitle({ name: 'Trusty Squire', handle: '@trusty-squire' })).toBe(
      '@Trusty Squire',
    );
  });

  it('names a connector by its display name', () => {
    expect(
      directMessageTitle({
        name: 'GitHub',
        handle: 'github-bot',
        avatar: 'https://x/v1/connectors/logo/github.svg',
      }),
    ).toBe('@GitHub');
  });
});

describe('read-clear push data', () => {
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

  it('round-trips flat, nested and dataString payloads', () => {
    const data = readClearPushData(ids);
    expect(readClearChannelIds(data)).toEqual(ids);
    expect(readClearChannelIds({ data })).toEqual(ids);
    expect(readClearChannelIds({ data: { dataString: JSON.stringify(data) } })).toEqual(ids);
    expect(readClearChannelIds({ type: 'read-clear', channelIds: ids.join(',') })).toEqual(ids);
  });

  it('ignores every other push', () => {
    expect(readClearChannelIds({ type: 'channel-activity', channelId: ids[0] })).toBeNull();
    expect(readClearChannelIds({ data: { dataString: 'not json' } })).toBeNull();
    expect(readClearChannelIds(null)).toBeNull();
  });
});
