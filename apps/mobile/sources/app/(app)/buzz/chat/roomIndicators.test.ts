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

const TURN_STATE = ['activeAgentTurn', 'sessionState', 'composerAck'];
const CORNER_STATE = ['pinnedCorner', 'pinnedCornerCard', 'cornerLifecycle'];

describe('the corner line and the turn indicator are independent', () => {
  it('never derives the pinned corner from any turn signal', () => {
    // `sessionState` is allowed inside the memo's *Corner* branch — there it
    // is this corner's own edit session, which is the corner's state. What may
    // never appear is the Room's turn signal.
    expect(memoBody('cornerLiveBar')).not.toContain('activeAgentTurn');
    expect(memoBody('cornerLiveBar')).not.toContain('agentsOffline');
  });

  it('resolves which corner may be pinned outside the screen, from corner state alone', () => {
    const selection = memoBody('pinnedCorner');
    for (const turnState of TURN_STATE) expect(selection).not.toContain(turnState);
    expect(selection).toContain('selectPinnedCorner');
    // Canonical lifecycle is the only input. Parent kind:9 corner-open/close
    // history and permission records are explicitly absent.
    expect(selection).toContain('lifecycle: cornerLifecycle');
    expect(selection).not.toContain('cornerSignals');
    expect(selection).not.toContain('permittedCorner');
  });

  it('never derives the turn indicator from any corner signal', () => {
    const turn = memoBody('composerAck');
    for (const cornerState of CORNER_STATE) expect(turn).not.toContain(cornerState);
    expect(turn).toContain('activeAgentTurn');
    expect(chatSource).toContain('roomSurface?.latestAgentTurns ?? []');
    expect(memoBody('activeAgentTurn')).not.toContain('liveOverlays');
  });

  it('runs the same thinking indicator for an active turn inside a corner', () => {
    const turn = memoBody('composerAck');
    expect(turn).not.toContain('sessionState');
    // The real receipt is resolved by the shared `selectComposerAckState` (it
    // calls `selectTurnProgressAgentPubkey` internally) rather than by a
    // second inline copy of the same check in the screen.
    expect(turn).toContain('selectComposerAckState');
    expect(turn).toContain('activeTurnPubkey: activeAgentTurn.agentPubkey');
    expect(turn).not.toContain('if (isCorner || agentsOffline) return null');
  });

  it('the local pre-receipt ack never derives from any corner signal either', () => {
    // "buzzing…" is armed the instant a message is sent and cleared the
    // instant the real receipt lands — it must not be able to see a corner's
    // pinned-selection state any more than the receipt-driven branch can.
    const turn = memoBody('composerAck');
    for (const cornerState of CORNER_STATE) expect(turn).not.toContain(cornerState);
    expect(turn).toContain('pendingAckSentAt');
    expect(turn).toContain('composerAckNow');
  });

  it('keeps the Corner-only transcript policy out of Room rendering', () => {
    expect(chatSource).toContain('const messages = unprojectedMessages;');
    expect(chatSource).not.toContain('projectCornerTranscript');
  });

  it('renders the two as separate, independently-gated lines', () => {
    // Neither is nested in the other's condition, so a Room can show one, the
    // other, both, or neither.
    expect(chatSource).toContain('{!isArchived && cornerLiveBar && (');
    expect(chatSource).toContain('{!isArchived && composerAck && (');
    expect(chatSource).toContain('<TurnProgressLine');
    expect(chatSource).toContain('label={composerAck.label}');
  });

  it('keeps the corner line the only tappable one', () => {
    // `TurnProgressLine` takes no `onPress` at all — a turn has no
    // destination, which is why it cannot strand a reader in a dead channel.
    expect(chatSource).not.toMatch(/<TurnProgressLine[^>]*onPress/);
  });
});
