import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  CornerLifecycleView,
  CornerState,
  CornerStateReason,
} from '@beeline/api-contract/phone';
import {
  cornerDisplayFromRoomView,
  roomViewParentId,
  cornerDisplayState,
  cornerHeaderStateLabel,
  cornerDisplayItems,
  cornerHeaderAgent,
} from './corner-display-state';

const lifecycle = (overrides: Partial<CornerLifecycleView> = {}): CornerLifecycleView => ({
  lifecycle: 'unknown',
  checks: 'unknown',
  ...overrides,
});

function item(state: CornerState, reason?: CornerStateReason) {
  return { state, ...(reason ? { reason } : {}), lifecycle: lifecycle() };
}

describe('server-owned corner display state', () => {
  it.each([
    ['working', 'quiet', '◌'],
    ['waiting', 'brass', '○'],
    ['review', 'quiet', '●'],
    ['archived', 'ghost', '○'],
  ] as const)('renders %s without deriving a replacement state', (state, tone, glyph) => {
    expect(cornerDisplayState(item(state))).toMatchObject({
      status: state,
      word: state,
      tone,
      glyph,
      terminal: state === 'archived',
    });
  });

  it('keeps the two failure explanations in the header only', () => {
    expect(cornerHeaderStateLabel(cornerDisplayState(item('waiting', 'failed')))).toBe(
      'waiting · failed',
    );
    expect(cornerHeaderStateLabel(cornerDisplayState(item('review', 'checks-failed')))).toBe(
      'review · checks failed',
    );
    expect(cornerDisplayState(item('waiting', 'question')).word).toBe('waiting');
  });

  it('uses lifecycle only for PR/check narration', () => {
    const display = cornerDisplayState({
      state: 'waiting',
      lifecycle: lifecycle({
        lifecycle: 'in-review',
        checks: 'failing',
        pr: {
          number: 1169,
          url: 'https://github.com/Beeline-Work/beeline/pull/1169',
          title: 'One state',
          targetBranch: 'main',
          headSha: 'abc',
        },
      }),
    });
    expect(display.status).toBe('waiting');
    expect(display.detail).toContain('PR #1169');
  });

  it('keeps all four server-owned states available to Room rows', () => {
    expect(
      cornerDisplayItems([item('working'), item('waiting'), item('review'), item('archived')]).map(
        (entry) => entry.display.status,
      ),
    ).toEqual(['working', 'waiting', 'review', 'archived']);
  });

  it('derives a corner viewing itself from this Room, not sibling corners', () => {
    expect(
      cornerDisplayFromRoomView({
        room: { archived: false },
        latestAgentTurns: [{ status: 'working' }],
        cornerLifecycle: lifecycle({ lifecycle: 'in-review' }),
      }),
    ).toMatchObject({ state: 'working' });
    expect(
      cornerDisplayFromRoomView({
        room: { archived: true },
        latestAgentTurns: [{ status: 'working' }],
        cornerLifecycle: lifecycle({ lifecycle: 'in-review' }),
      }),
    ).toMatchObject({ state: 'archived' });
  });

  it('contains no client-side daemon-state resolver', () => {
    const source = readFileSync(new URL('./corner-display-state.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/machineState|machineReason|currentCornerStatus|mergedAt|outcome/);
    expect(source).toContain('const { state } = item;');
  });

  describe('cornerHeaderAgent', () => {
    it('keeps the corner owned by A naming A while agent B holds the live turn', () => {
      const view = cornerHeaderAgent({
        ownerPubkey: 'a'.repeat(64),
        status: 'working',
        activeTurnPubkeys: ['b'.repeat(64)],
      });
      expect(view.pubkey).toBe('a'.repeat(64));
      expect(view.reviewerTurnRunning).toBe(true);
      expect(view.stateWord).toBe('reviewing');
      expect(view.ownerWorking).toBe(false);
    });

    it('reads working when the owner itself holds the live turn', () => {
      const view = cornerHeaderAgent({
        ownerPubkey: 'a'.repeat(64),
        status: 'working',
        activeTurnPubkeys: ['a'.repeat(64)],
      });
      expect(view.reviewerTurnRunning).toBe(false);
      expect(view.stateWord).toBe('working');
      expect(view.ownerWorking).toBe(true);
    });

    it('carries the header suffix through the reviewing word', () => {
      const view = cornerHeaderAgent({
        ownerPubkey: 'a'.repeat(64),
        status: 'working',
        headerSuffix: 'checks failed',
        activeTurnPubkeys: ['b'.repeat(64)],
      });
      expect(view.stateWord).toBe('reviewing · checks failed');
      expect(view.ownerWorking).toBe(false);
    });

    it('never reads reviewing when the corner is not working or no turn runs', () => {
      expect(
        cornerHeaderAgent({
          ownerPubkey: 'a'.repeat(64),
          status: 'waiting',
          activeTurnPubkeys: ['b'.repeat(64)],
        }).stateWord,
      ).toBe('waiting');
      expect(
        cornerHeaderAgent({
          ownerPubkey: 'a'.repeat(64),
          status: 'working',
          activeTurnPubkeys: [],
        }).stateWord,
      ).toBe('working');
      // No owner known yet (cold start): a running turn cannot be attributed
      // to a non-owner, so the word stays the plain state.
      expect(
        cornerHeaderAgent({
          status: 'working',
          activeTurnPubkeys: ['b'.repeat(64)],
        }).reviewerTurnRunning,
      ).toBe(false);
    });
  });
});

describe('roomViewParentId', () => {
  const parentId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

  it('names the parent from the parent block when the server sends one', () => {
    expect(
      roomViewParentId({ room: { parentId }, parent: { id: parentId } }),
    ).toBe(parentId);
  });

  it('still reads a corner when a payload drops the parent block', () => {
    expect(roomViewParentId({ room: { parentId } })).toBe(parentId);
  });

  it('reads a top-level Room as having no parent', () => {
    expect(roomViewParentId({ room: {} })).toBeUndefined();
  });
});

describe('cornerDisplayFromRoomView with an unreadable archived flag', () => {
  it('does not paint a corner whose live/closed state is unknown as live', () => {
    expect(
      cornerDisplayFromRoomView({ room: {}, latestAgentTurns: [] }).state,
    ).toBe('archived');
  });

  it('still paints a known-live corner from its own turns', () => {
    expect(
      cornerDisplayFromRoomView({
        room: { archived: false },
        latestAgentTurns: [{ status: 'working' }],
      }).state,
    ).toBe('working');
  });
});
