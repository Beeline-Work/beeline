import { describe, expect, it } from 'vitest';
import { splitChannelHeaderTitle } from './channel-header-title';

describe('splitChannelHeaderTitle', () => {
  it('splits a Room title into its brass sigil and name', () => {
    expect(splitChannelHeaderTitle('#beeline', 'room')).toEqual({ sigil: '#', name: 'beeline' });
    expect(splitChannelHeaderTitle('##beeline', 'room')).toEqual({ sigil: '#', name: 'beeline' });
  });

  it('leaves the placeholder Room title unmarked', () => {
    expect(splitChannelHeaderTitle('Room', 'room')).toEqual({ sigil: null, name: 'Room' });
    expect(splitChannelHeaderTitle('#', 'room')).toEqual({ sigil: null, name: '#' });
  });

  it('keeps the parent mark on a corner', () => {
    expect(splitChannelHeaderTitle('#beeline/fix auth', 'corner')).toEqual({
      sigil: '#',
      name: 'beeline/fix auth',
    });
  });

  it('marks a DM with @ whatever shape the peer label takes', () => {
    expect(splitChannelHeaderTitle('@alice', 'dm')).toEqual({ sigil: '@', name: 'alice' });
    expect(splitChannelHeaderTitle('Alice', 'dm')).toEqual({ sigil: '@', name: 'Alice' });
    expect(splitChannelHeaderTitle('alice@usebeeline.app', 'dm')).toEqual({
      sigil: '@',
      name: 'alice@usebeeline.app',
    });
  });
});
