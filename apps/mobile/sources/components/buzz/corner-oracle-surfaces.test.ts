import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cornerActionSurface } from '../../buzz/corner-attention';
import {
  roomRowPresentation,
  type RoomRowInput,
} from '../../buzz/room-list-row';
import { selectPinnedCorner } from '../../buzz/room-indicators';
import type { CornerSummary } from '../../buzz/corners';
import { resolveCornerLifecycle } from '@beeline/buzz-client';

const chatSource = sourceFile('../../app/(app)/buzz/chat/[channelId].tsx');
const channelsSource = sourceFile('../../app/(app)/buzz/channels.tsx');
const rowSource = sourceFile('../../buzz/room-list-row.ts');
const indicatorsSource = sourceFile('../../buzz/room-indicators.ts');
const transportSource = sourceFile('../../sync/transport/buzz-rig-transport.ts');

/** Read a repo file by a path relative to THIS test file. */
function sourceFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

function repoSource(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, new URL('../../../../../', import.meta.url))),
    'utf8',
  );
}

/**
 * ONE oracle, FOUR surfaces. Every surface that reports a corner's state must
 * consume `resolveCornerLifecycle`'s verdict (via `@beeline/buzz-client`'s
 * corner-lifecycle module, re-exported by `buzz/corners.ts`) — a per-surface
 * re-derivation is how the deck golded corners their agents had already
 * picked back up, and how a restart's rebroadcast could re-gold parked work.
 */
describe('one corner lifecycle oracle', () => {
  it('every surface imports the one oracle and none re-derives it', () => {
    // The surfaces, enumerated:
    // 1. deck rows (room-list-row), 2. deck expansion corner rows +
    //    standalone list (channels/corners screens via cornerStatusPresentation
    //    on oracle-fed CornerSummary), 3. pinned room bar (room-indicators),
    //    4. corner screen card/panel ([channelId].tsx via
    //    resolveCornerLifecycleStatus + corner-attention).
    expect(transportSource).toMatch(
      /import \{[\s\S]*?resolveCornerLifecycle[\s\S]*?\} from '@\/buzz\/corners'/,
    );
    expect(rowSource).toMatch(/cornerSuperState[\s\S]*?from '@\/buzz\/corners'/);
    expect(indicatorsSource).toMatch(/mergeCornerStatuses[\s\S]*?from '\.\/corners'/);
    expect(chatSource).toMatch(/resolveCornerLifecycleStatus[\s\S]*?from '@\/buzz\/corners'/);
    expect(chatSource).toMatch(/cornerActionSurface[\s\S]*?from '@\/buzz\/corner-attention'/);

    // No second derivation anywhere: only the shared module may define these.
    const sources = [chatSource, channelsSource, rowSource, indicatorsSource, transportSource];
    for (const text of sources) {
      expect(text).not.toMatch(/function mapRawCornerStatusTag/);
      expect(text).not.toMatch(/function resolveCornerLifecycle\b/);
      expect(text).not.toMatch(/CORNER_WORK_SIGNAL_TAGS: .*Set/);
    }
    // The needs-you set is imported, never re-enumerated per surface.
    for (const text of [chatSource, indicatorsSource]) {
      expect(text).not.toMatch(/new Set<CornerStatus>\(\[\s*'needs-attention'/);
    }

    // The oracle itself lives in exactly one implementation file.
    const oracle = repoSource('packages/buzz-client/src/corner-lifecycle.ts');
    expect(oracle).toContain('export function resolveCornerLifecycle');
    const facade = repoSource('apps/mobile/sources/buzz/corners.ts');
    expect(facade).toMatch(/from '@beeline\/buzz-client'/);
    expect(facade).not.toMatch(/export function mapRawCornerStatusTag/);
  });

  it('the corner screen never renders the attention card on itself', () => {
    // The attention card routes attention FROM summary surfaces INTO the
    // corner; inside the corner it is self-referential (its 'REPLY IN THIS
    // CORNER' affordance is meaningless where you already stand). The screen
    // consumes only the review branch of the derivation; the state word lives
    // in the header badge, the ask lives in the transcript.
    const reviewBranch = chatSource.indexOf("cornerAction.kind === 'review'");
    const nothingReadyIndex = chatSource.indexOf('NOTHING READY TO MERGE YET');
    expect(reviewBranch).toBeGreaterThan(0);
    expect(nothingReadyIndex).toBeGreaterThan(reviewBranch);
    expect(chatSource).not.toContain("cornerAction.kind === 'attention'");
    expect(chatSource).not.toContain('corner-attention-card');
    expect(chatSource).not.toContain('REPLY IN THIS CORNER');
    // And no other rendering path may branch on raw status words directly.
    expect(chatSource).not.toMatch(/displayedCornerStatus === '(needs-attention|open|failed)'/);
  });
});

/** The four surfaces, fed by one verdict. */
function corner(status: CornerSummary['status']): CornerSummary {
  return {
    id: 'corner-1',
    name: 'fix-the-thing',
    openerPubkey: 'a'.repeat(64),
    status,
    lastActivityAt: 200,
  };
}

describe('four surfaces agree on one verdict', () => {
  const cases = [
    {
      facts: 'working: attention card superseded by newer work',
      history: [
        { createdAt: 100, rawStatus: 'needs-attention' },
        { createdAt: 200, isWorkSignal: true },
      ],
      status: 'live',
    },
    {
      facts: 'ready-for-review',
      history: [{ createdAt: 100, isMergeReady: true }],
      status: 'open',
    },
    {
      facts: 'needs-decision',
      history: [{ createdAt: 100, rawStatus: 'needs-attention' }],
      status: 'needs-attention',
    },
    { facts: 'idle: nothing reportable', history: [], status: null },
  ] as const;

  for (const { facts, history, status } of cases) {
    it(`agrees on ${facts}`, () => {
      // The verdict itself comes from THE oracle, exactly as the transport does.
      // `now` sits just after the newest fact so liveness windows hold.
      const now = history.length > 0 ? history[history.length - 1].createdAt * 1000 + 1000 : 0;
      const resolved =
        history.length === 0 ? null : resolveCornerLifecycle(history as never, { now });
      const expected = status;
      if (status !== null) expect(resolved).toBe(expected);

      const corners = status === null ? [] : [corner(expected)];
      const input: RoomRowInput = { corners };

      // 1+2. Deck row AND its expansion rows: same CornerSummary array.
      const row = roomRowPresentation(input, new Map());
      if (status === null) {
        expect(row.zone).toBe('idle');
        expect(row.corners).toEqual([]);
      } else {
        expect(row.corners.map((c) => c.status)).toEqual([expected]);
        expect(row.zone).toBe(expected === 'live' ? 'working' : 'needs-you');
        expect(row.attention).toBe(expected !== 'live');
      }

      // 3. Pinned room bar.
      const pinned = selectPinnedCorner({
        signals: [],
        lifecycle: corners,
        lifecycleLoaded: true,
      });
      if (status === null) expect(pinned).toBeNull();
      else expect(pinned).toMatchObject({ cornerId: 'corner-1', status: expected });

      // 4. Corner screen action area.
      const action = cornerActionSurface({ status: expected, hasMergeTarget: false });
      if (status === 'needs-attention' || status === 'open') {
        expect(action.kind).toBe('attention');
      } else if (status === 'live') {
        expect(action.kind).toBe('nothing-ready');
      } else {
        expect(action.kind).toBe('nothing-ready');
      }
    });
  }

  it('all three waiting surfaces clear together when the agent picks work back up', () => {
    // Before: parked on an attention card.
    const before = resolveCornerLifecycle([{ createdAt: 100, rawStatus: 'needs-attention' }]);
    expect(before).toBe('needs-attention');
    // After: one new fact — the agent's own narration, NEWER than the card.
    const after = resolveCornerLifecycle(
      [
        { createdAt: 100, rawStatus: 'needs-attention' },
        { createdAt: 200, isWorkSignal: true },
      ],
      { now: 200 * 1000 + 1000 },
    );
    expect(after).toBe('live');

    const corners = [corner(after)];
    expect(roomRowPresentation({ corners }, new Map()).zone).toBe('working');
    expect(selectPinnedCorner({ signals: [], lifecycle: corners, lifecycleLoaded: true }))
      .toMatchObject({ status: 'live' });
    expect(cornerActionSurface({ status: after, hasMergeTarget: false }).kind).toBe(
      'nothing-ready',
    );
  });

  it('corner glyphs are diamonds on every surface — never identity shapes', () => {
    // Shapes are identity vocabulary (△○▢); corners are WORK. One family.
    const facade = repoSource('apps/mobile/sources/buzz/corners.ts');
    for (const glyph of ['▲', '△', '○', '▢', '□', '✕', '✓']) {
      expect(facade, `${glyph} is not a corner glyph`).not.toContain(`glyph: '${glyph}'`);
    }
    expect(facade).toContain("return { glyph: CORNER_GLYPH_LIVE, label: 'WORKING' }");
    // Expansion rows and the standalone list render THE shared component.
    expect(channelsSource).toContain('<CornerGlyph status={corner.status}');
    const listSource = sourceFile('../../app/(app)/buzz/corners/[roomId].tsx');
    expect(listSource).toContain('<CornerGlyph status={item.status}');
    // No buzz screen draws a triangle as a corner's own glyph; identity marks
    // are the ONLY legitimate triangle source (identity-mark.ts/IdentityMark).
    for (const text of [channelsSource, chatSource, rowSource, indicatorsSource, listSource]) {
      expect(text).not.toMatch(/[▲△]/);
    }
  });
});
