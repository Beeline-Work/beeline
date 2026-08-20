import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/**
 * The daemon-published agent state-notice feature is DELETED and must stay
 * deleted (captain's order).
 *
 * `agent-state-messages.ts` (#231) mapped five real daemon states —
 * relay-disconnected, harness-auth-missing, harness-unavailable,
 * repo-unavailable, rate-limited — to hard-coded copy the daemon published
 * into the Room as an ordinary `#t=agent-message`. Two properties made it
 * indefensible in practice:
 *
 *   - `relay-disconnected` fired from `runRoomPushLoop`'s reconnect-failure
 *     catch, and its "one per state transition" dedup lives in a
 *     `Map` on the `Body` instance — so it re-armed on every daemon restart
 *     and on every recycle of a Room. A day of ordinary WS blips and ~17
 *     daemon restarts produced a WALL of identical
 *     "I lost my connection to the relay — reconnecting." messages in the
 *     captain's live Room.
 *   - None of the five is something a person can act on from a chat
 *     transcript. A daemon's own health belongs in the daemon's log; what a
 *     Room needs is honest silence plus the signals that already exist — the
 *     presence lease (the OFFLINE banner, the per-agent dot) and the
 *     corner/turn state.
 *
 * The wanted machine-authored publishes are unaffected and deliberately out of
 * scope here: the land recap (`postCornerLandSummary`), CI results, and the
 * corner status cards (`postControlMessage` with a `status`/`display-status`
 * tag) all describe work the human asked for, not the daemon's own weather.
 *
 * The reader-side half of this deletion — hiding the notices already published
 * to real Rooms, which cannot be unpublished — lives in
 * `apps/mobile/sources/buzz/retired-agent-notices.ts`. Any string added back
 * here has to be added there too, which is exactly the friction this file
 * exists to create.
 */
describe('the daemon-published agent state notices stay deleted', () => {
  const src = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
  const body = src('./body.ts');
  const supervisor = src('./supervisor.ts');
  const activity = src('./activity.ts');
  const acp = src('./acp.ts');

  /**
   * The exact copy shipped in `AGENT_ERROR_STATE_MESSAGES`. These are the
   * strings sitting in real relay history today; they are also what the mobile
   * reader-side filter matches on, so they may never be republished under a
   * new mechanism either.
   */
  const RETIRED_NOTICES = [
    'I lost my connection to the relay — reconnecting.',
    "I can't reach my model — my host's credentials need a refresh.",
    "My coding backend won't start — the host may need attention.",
    "I can't get to this room's repo — check the repo link or my access.",
    "I've hit a usage limit for now.",
  ];

  it('has no module left to import', () => {
    expect(existsSync(new URL('./agent-state-messages.ts', import.meta.url))).toBe(false);
  });

  it('has no classifier, copy table, or per-channel state bookkeeping left', () => {
    for (const symbol of [
      'agent-state-messages',
      'AgentErrorState',
      'AGENT_ERROR_STATE_MESSAGES',
      'classifyAgentErrorState',
      'notifyAgentErrorStateOnce',
      'clearAgentErrorState',
      'erroredStateByChannel',
      'repoUnavailableNotified',
    ]) {
      expect(body, `body.ts still references ${symbol}`).not.toContain(symbol);
      expect(supervisor, `supervisor.ts still references ${symbol}`).not.toContain(symbol);
      expect(acp, `acp.ts still references ${symbol}`).not.toContain(symbol);
    }
  });

  it('never publishes any of the retired sentences', () => {
    for (const notice of RETIRED_NOTICES) {
      for (const [name, source] of [
        ['body.ts', body],
        ['supervisor.ts', supervisor],
        ['activity.ts', activity],
      ] as const) {
        expect(source, `${name} still carries: ${notice}`).not.toContain(notice);
      }
    }
  });

  /**
   * The reconnect loop is where the wall came from, so this asserts the shape
   * and not just the string: whatever that catch block grows later, it reports
   * to the console and waits — it does not speak in the Room.
   */
  it('reports a failed reconnect to the console, never to the Room', () => {
    const loop = body.slice(
      body.indexOf('private async runRoomPushLoop'),
      body.indexOf('async runChannelLoop('),
    );
    expect(loop.length).toBeGreaterThan(0);
    const reconnectCatch = loop.slice(loop.indexOf('const delayMs = reconnectBackoff.failed('));
    expect(reconnectCatch).toContain('console.error');
    expect(reconnectCatch).not.toContain('postAgentMessage');
    expect(reconnectCatch).not.toContain('postControlMessage');
  });

  /**
   * A Room whose repository cannot be materialized never starts. That is a
   * host problem the operator reads in the log; it was #231's one genuinely
   * new signal and it is going with the rest.
   */
  it('leaves an unservable Room silent on the relay', () => {
    const start = supervisor.slice(
      supervisor.indexOf('private async startRepositoryRoom'),
      supervisor.indexOf('canonical checkout unavailable') + 400,
    );
    expect(start.length).toBeGreaterThan(0);
    expect(start).toContain('console.error');
    expect(start).not.toContain('postAgentMessage');
  });
});
