import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatSource = readFileSync(new URL('./[channelId].tsx', import.meta.url), 'utf8');

/**
 * Two indicators, two unrelated facts, and the rule is enforced here as
 * structure rather than as intent.
 *
 * A Room turn in progress ("beebee thinking…") and an open corner
 * ("beebee active: feat/x · view →") were once one derivation: the pinned
 * gold corner line's `live` flag was the agent-busy flag, and its destination
 * was whatever corner was last on record — so a plain question lit the corner
 * line and offered a tap into an archived channel. The fix is that neither
 * memo can see the other's input, which is exactly what a dependency list can
 * be read for.
 */
/** One `useMemo(...)` call, from its name to its own closing paren — the
 * factory and the dependency list together, and nothing of its neighbours. */
function memoBody(name: string): string {
  const start = chatSource.indexOf(`  const ${name} = useMemo(`);
  expect(start, `missing the ${name} derivation`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = chatSource.indexOf('(', start); index < chatSource.length; index += 1) {
    if (chatSource[index] === '(') depth += 1;
    if (chatSource[index] === ')') depth -= 1;
    if (depth === 0) return chatSource.slice(start, index + 1);
  }
  throw new Error(`Unclosed useMemo for ${name}`);
}

const TURN_STATE = ['activeAgentTurn', 'sessionState', 'turnProgressLabel'];
const CORNER_STATE = ['pinnedCorner', 'pinnedCornerCard', 'cornerLifecycle', 'permittedCornerId'];

describe('the corner line and the turn indicator are independent', () => {
  it('never derives the pinned corner from any turn signal', () => {
    // `sessionState` is allowed inside the memo's *Corner* branch — there it
    // is this corner's own edit session, which is the corner's state. What may
    // never appear is the Room's turn signal.
    expect(memoBody('cornerLiveBar')).not.toContain('activeAgentTurn');
  });

  it('resolves which corner may be pinned outside the screen, from corner state alone', () => {
    const selection = memoBody('pinnedCorner');
    for (const turnState of TURN_STATE) expect(selection).not.toContain(turnState);
    expect(selection).toContain('selectPinnedCorner');
    // Both sources are consulted, so a corner terminal in either is excluded.
    expect(selection).toContain('lifecycle: cornerLifecycle');
    expect(selection).toContain('signals: cornerSignals');
  });

  it('never derives the turn indicator from any corner signal', () => {
    const turn = memoBody('turnProgressLabel');
    for (const cornerState of CORNER_STATE) expect(turn).not.toContain(cornerState);
    expect(turn).toContain('activeAgentTurn');
  });

  it('runs the same thinking indicator for an active turn inside a corner', () => {
    const turn = memoBody('turnProgressLabel');
    expect(turn).toContain("if (sessionState !== 'working') return null");
    expect(turn).toContain("`${cornerAgentDisplay?.name ?? 'agent'} thinking…`");
    expect(turn).not.toContain('if (isCorner || agentsOffline) return null');
  });

  it('renders the two as separate, independently-gated lines', () => {
    // Neither is nested in the other's condition, so a Room can show one, the
    // other, both, or neither.
    expect(chatSource).toContain('{!isArchived && cornerLiveBar && (');
    expect(chatSource).toContain('{!isArchived && turnProgressLabel && (');
    expect(chatSource).toContain('<TurnProgressLine label={turnProgressLabel}');
  });

  it('keeps the corner line the only tappable one', () => {
    // `TurnProgressLine` takes no `onPress` at all — a turn has no
    // destination, which is why it cannot strand a reader in a dead channel.
    expect(chatSource).not.toMatch(/<TurnProgressLine[^>]*onPress/);
  });
});
