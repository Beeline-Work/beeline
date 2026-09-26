import { describe, expect, it } from 'vitest';
import { deckLanding } from './deck-landing';

describe('the Room deck landing', () => {
  it('reports a failed Workspace read instead of holding the loader forever', () => {
    // A cached empty list selects no Workspace, so no chats read ever starts;
    // the live read is the only thing that can answer, and it failed.
    expect(
      deckLanding({ workspaces: { status: 'failed' }, chats: 'pending' }),
    ).toEqual({ kind: 'error' });
  });

  it('holds the loader while the live Workspace read is still in flight', () => {
    expect(deckLanding({ workspaces: { status: 'pending' }, chats: 'pending' })).toEqual({
      kind: 'loader',
    });
  });

  it('sends a person the live read confirms has no Workspace to the choice screen', () => {
    expect(deckLanding({ workspaces: { status: 'ready', count: 0 }, chats: 'pending' })).toEqual({
      kind: 'choice',
    });
  });

  it('never routes to the choice screen on a cached empty list alone', () => {
    // The cached list cannot be told apart from "not read yet" here, which is
    // the point: only a live read routes anyone.
    expect(deckLanding({ workspaces: { status: 'pending' }, chats: 'pending' }).kind).not.toBe(
      'choice',
    );
  });

  it('paints the deck as soon as a chat list is in hand', () => {
    expect(deckLanding({ workspaces: { status: 'pending' }, chats: 'ready' })).toEqual({
      kind: 'deck',
    });
    // A Workspace read that failed after the deck was painted stays a bar on
    // the deck, not a replacement for it.
    expect(deckLanding({ workspaces: { status: 'failed' }, chats: 'ready' })).toEqual({
      kind: 'deck',
    });
  });

  it('reports a failed chats read when there is nothing to paint', () => {
    expect(
      deckLanding({ workspaces: { status: 'ready', count: 2 }, chats: 'failed' }),
    ).toEqual({ kind: 'error' });
  });
});
