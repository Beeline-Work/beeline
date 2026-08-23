import { describe, expect, it } from 'vitest';
import {
  chatBackAction,
  cornerHref,
  popCountToParentRoom,
  roomHref,
  routeChannelId,
  type ChatStackRoute,
} from './corner-navigation';

const chatRoute = (channelId: string): ChatStackRoute => ({
  name: 'buzz/chat/[channelId]',
  params: { channelId },
});

describe('leaving a corner', () => {
  it('pops to the parent Room when it sits directly beneath the corner', () => {
    const routes = [
      { name: 'buzz/channels' },
      chatRoute('room-1'),
      chatRoute('corner-1'),
    ];
    expect(chatBackAction(routes, 'room-1')).toEqual({ type: 'pop', count: 1 });
  });

  it('never lands on another corner when a notification reordered the stack', () => {
    // A merge-approval push uses `dangerouslySingular`, which lifts the matching
    // chat route out of the stack and re-appends it on top instead of popping to
    // it. That leaves a corner sitting *below* its own Room, so a later drill-in
    // makes plain "go back one" walk straight into a corner again.
    const routes = [
      { name: 'buzz/channels' },
      chatRoute('corner-1'),
      chatRoute('room-1'),
      chatRoute('corner-1'),
    ];
    const action = chatBackAction(routes, 'room-1');
    expect(action).toEqual({ type: 'pop', count: 1 });

    const landedOn = routes[routes.length - 1 - (action as { count: number }).count];
    expect(routeChannelId(landedOn)).toBe('room-1');
    expect(routeChannelId(landedOn)).not.toBe('corner-1');
  });

  it('pops past intervening screens rather than one entry at a time', () => {
    const routes = [
      chatRoute('room-1'),
      chatRoute('corner-1'),
      chatRoute('corner-2'),
    ];
    expect(chatBackAction(routes, 'room-1')).toEqual({ type: 'pop', count: 2 });
  });

  it('opens the parent Room when it was never on the stack', () => {
    // The Room-list corner dropdown pushes a corner without its Room, and a
    // notification cold start can make the corner the only route at all.
    expect(chatBackAction([{ name: 'buzz/channels' }, chatRoute('corner-1')], 'room-1')).toEqual({
      type: 'open-room',
      channelId: 'room-1',
    });
    expect(chatBackAction([chatRoute('corner-1')], 'room-1')).toEqual({
      type: 'open-room',
      channelId: 'room-1',
    });
  });

  it('returns to the Room list when the Corner was opened there', () => {
    expect(
      chatBackAction(
        [{ name: 'buzz/channels' }, chatRoute('corner-1')],
        'room-1',
        'room-list',
      ),
    ).toEqual({ type: 'pop', count: 1 });
    expect(chatBackAction([chatRoute('corner-1')], 'room-1', 'room-list')).toEqual({
      type: 'room-list',
    });
  });

  it('matches the nearest parent copy, ignoring the corner it is leaving', () => {
    const routes = [chatRoute('room-1'), chatRoute('room-1'), chatRoute('corner-1')];
    expect(popCountToParentRoom(routes, 'room-1')).toBe(1);
    // The top entry is never a candidate: a corner cannot "return" to itself.
    expect(popCountToParentRoom([chatRoute('room-1')], 'room-1')).toBeNull();
  });

  it('reads a channel id through URI encoding', () => {
    expect(routeChannelId({ params: { channelId: 'a%2Fb' } })).toBe('a/b');
    expect(routeChannelId({ params: { channelId: '100%' } })).toBe('100%');
    expect(routeChannelId({ params: {} })).toBeUndefined();
    expect(routeChannelId(undefined)).toBeUndefined();
  });
});

describe('leaving a Room', () => {
  it('goes back normally when there is something to go back to', () => {
    expect(chatBackAction([{ name: 'buzz/channels' }, chatRoute('room-1')], undefined)).toEqual({
      type: 'back',
    });
  });

  it('falls back to the Room list instead of a back that does nothing', () => {
    expect(chatBackAction([chatRoute('room-1')], undefined)).toEqual({ type: 'room-list' });
    expect(chatBackAction([], undefined)).toEqual({ type: 'room-list' });
  });
});

describe('corner hrefs', () => {
  it('carries the parent and known title so the corner header is right on frame one', () => {
    expect(cornerHref('corner-1', 'room-1', 'fix-oauth-callback')).toEqual({
      pathname: '/buzz/chat/[channelId]',
      params: { channelId: 'corner-1', parent: 'room-1', title: 'fix-oauth-callback' },
    });
  });

  it('omits an unknown title rather than passing an empty one', () => {
    expect(cornerHref('corner-1', 'room-1')).toEqual({
      pathname: '/buzz/chat/[channelId]',
      params: { channelId: 'corner-1', parent: 'room-1' },
    });
  });

  it('carries an explicit Room-list return target when opened from that list', () => {
    expect(cornerHref('corner-1', 'room-1', 'fix-oauth-callback', 'room-list')).toEqual({
      pathname: '/buzz/chat/[channelId]',
      params: {
        channelId: 'corner-1',
        parent: 'room-1',
        title: 'fix-oauth-callback',
        returnTo: 'room-list',
      },
    });
  });

  it('opens a Room with no corner hints attached', () => {
    expect(roomHref('room-1')).toEqual({
      pathname: '/buzz/chat/[channelId]',
      params: { channelId: 'room-1' },
    });
  });
});
