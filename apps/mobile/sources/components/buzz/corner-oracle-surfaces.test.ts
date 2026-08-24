import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cornerActionSurface } from '../../buzz/corner-attention';
import { roomRowPresentation, type RoomRowInput } from '../../buzz/room-list-row';
import { selectPinnedCorner } from '../../buzz/room-indicators';
import type { CornerSummary } from '../../buzz/corners';
import type { CornerMachineState } from '@beeline/buzz-client';

const chatSource = sourceFile('../../app/(app)/buzz/chat/[channelId].tsx');
const channelsSource = sourceFile('../../app/(app)/buzz/channels.tsx');
const rowSource = sourceFile('../../buzz/room-list-row.ts');
const indicatorsSource = sourceFile('../../buzz/room-indicators.ts');
const transportSource = sourceFile('../../sync/transport/buzz-rig-transport.ts');
const verdictSource = sourceFile('../../sync/transport/corner-state-verdict.ts');

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
 * ONE durable state record, FOUR surfaces. Transcript history is deliberately
 * absent: every surface consumes the daemon-authored canonical machine state.
 */
describe('one canonical corner lifecycle record', () => {
  it('every surface consumes canonical state and none promotes transcript history', () => {
    // The surfaces, enumerated:
    // 1. deck rows (room-list-row), 2. deck expansion corner rows +
    //    standalone list (channels/corners screens via cornerStatusPresentation
    //    on oracle-fed CornerSummary), 3. pinned room bar (room-indicators),
    //    4. corner screen card/panel ([channelId].tsx via
    //    resolveCornerLifecycleStatus + corner-attention).
    expect(transportSource).toContain(
      "import { resolveCornerVerdict } from './corner-state-verdict'",
    );
    expect(verdictSource).toMatch(/isCornerStateRecordFresh[\s\S]*?from '@beeline\/buzz-client'/);
    expect(rowSource).toMatch(/roomState[\s\S]*?from '@\/buzz\/corners'/);
    expect(indicatorsSource).toMatch(/currentCornerStatus[\s\S]*?from '\.\/corners'/);
    expect(chatSource).toMatch(/resolveCornerLifecycleStatus[\s\S]*?from '@\/buzz\/corners'/);
    expect(chatSource).toMatch(/cornerActionSurface[\s\S]*?from '@\/buzz\/corner-attention'/);
    expect(indicatorsSource).toContain('if (!corner.machineState) continue;');
    expect(verdictSource).toContain('if (!input.stateRecord) return');

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

    // The durable state machine itself lives in exactly one shared module.
    const machine = repoSource('packages/buzz-client/src/corner-state.ts');
    expect(machine).toContain('export function canTransitionCornerState');
    expect(machine).toContain('export function isCornerStateRecordFresh');
    const facade = repoSource('apps/mobile/sources/buzz/corners.ts');
    expect(facade).toMatch(/from '@beeline\/buzz-client'/);
    expect(facade).toContain('machineState?: CornerMachineState');
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
    // Canonical working, never a draft/turn/control event, drives "active".
    expect(chatSource).toContain("canonicalCorner?.machineState === 'working'");
  });
});

/** The four surfaces, fed by one canonical record projection. */
function corner(machineState: CornerMachineState, status: CornerSummary['status']): CornerSummary {
  return {
    id: 'corner-1',
    name: 'fix-the-thing',
    openerPubkey: 'a'.repeat(64),
    status,
    machineState,
    ...(machineState === 'waiting'
      ? {
          machineReason:
            status === 'open'
              ? ('review' as const)
              : status === 'failed'
                ? ('failure' as const)
                : ('question' as const),
        }
      : {}),
    stateAt: Math.floor(Date.now() / 1_000),
    lastActivityAt: Math.floor(Date.now() / 1_000),
  };
}

describe('four surfaces agree on one verdict', () => {
  const cases: Array<{
    facts: string;
    machineState: CornerMachineState;
    status: CornerSummary['status'];
  }> = [
    {
      facts: 'working',
      machineState: 'working',
      status: 'live',
    },
    {
      facts: 'ready-for-review',
      machineState: 'waiting',
      status: 'open',
    },
    {
      facts: 'needs-decision',
      machineState: 'waiting',
      status: 'needs-attention',
    },
    { facts: 'idle: nothing reportable', machineState: 'idle', status: null },
  ] as const;

  for (const { facts, machineState, status } of cases) {
    it(`agrees on ${facts}`, () => {
      const corners = [corner(machineState, status)];
      const input: RoomRowInput = { corners };

      // 1+2. Deck row AND its expansion rows: same CornerSummary array.
      const row = roomRowPresentation(input, new Map());
      if (status === null) {
        expect(row.zone).toBe('idle');
        expect(row.corners).toHaveLength(1);
      } else {
        expect(row.corners.map((c) => c.status)).toEqual([status]);
        expect(row.zone).toBe(status === 'live' ? 'working' : 'needs-you');
        expect(row.attention).toBe(status !== 'live');
      }

      // 3. Pinned room bar.
      const pinned = selectPinnedCorner({
        lifecycle: corners,
      });
      if (status === null) expect(pinned).toBeNull();
      else expect(pinned).toMatchObject({ cornerId: 'corner-1', status });

      // 4. Corner screen action area.
      const action = cornerActionSurface({ status, hasMergeTarget: false });
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
    const corners = [corner('working', 'live')];
    expect(roomRowPresentation({ corners }, new Map()).zone).toBe('working');
    expect(selectPinnedCorner({ lifecycle: corners })).toMatchObject({ status: 'live' });
    expect(cornerActionSurface({ status: 'live', hasMergeTarget: false }).kind).toBe(
      'nothing-ready',
    );
  });

  it('Room and corner state use one three-state circle component with no visible label', () => {
    const facade = repoSource('apps/mobile/sources/buzz/corners.ts');
    const monoHull = sourceFile('./MonoHull.tsx');
    const stateCircleSource = monoHull.slice(
      monoHull.indexOf('export function StateCircle'),
      monoHull.indexOf('type HullWaveSignalProps'),
    );
    expect(facade).toContain("export type CornerVisualState = 'idle' | 'working' | 'needs-you'");
    expect(facade).toContain("case 'working':\n      return '◌'");
    expect(facade).toContain("const CORNER_GLYPH_FILLED = '●'");
    expect(facade).toContain("const CORNER_GLYPH_HOLLOW = '○'");
    expect(stateCircleSource).toContain('function StateCircle(');
    expect(stateCircleSource).toContain('accessibilityLabel={state}');
    expect(stateCircleSource).not.toMatch(/<Text[^>]*>\{state\}<\/Text>/);
    expect(stateCircleSource).not.toMatch(/[◆◇]/);
    // Expansion rows and the standalone list render THE shared component.
    expect(channelsSource).toContain('<CornerGlyph');
    const listSource = sourceFile('../../app/(app)/buzz/corners/[roomId].tsx');
    expect(listSource).toContain('<CornerGlyph');
    // No buzz screen draws a triangle as a corner's own glyph; identity marks
    // are the ONLY legitimate triangle source (identity-mark.ts/IdentityMark).
    for (const text of [channelsSource, chatSource, rowSource, indicatorsSource, listSource]) {
      expect(text).not.toMatch(/[▲△]/);
    }
  });
});
