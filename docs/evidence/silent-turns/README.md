# Silent turns and lifecycle wakes

## Reproduced

The regression tests were run with the affected implementation files restored to the original corner HEAD, then the fixes were restored. All four assertions failed against the original behavior:

- Reproduction ST-silent: a normal empty final reply in the Room turn loop ran twice instead of completing once, then failed.
- Reproduction ST-silent (receipt): completing with `completionKind: no-reply` posted a `turn-no-reply` card saying the agent had nothing to add.
- Reproduction ST-opened: an opener watching its corner received a private `watched_corner` input for its own opened event.
- Reproduction ST-closed: closing a corner delivered a private lifecycle input to an existing closed watcher.

## Demonstrated

The same user paths now pass:

- The Room turn loop accepts an empty final reply, posts nothing, and records one complete receipt without a provider retry. A normal corner turn also completes with no Room message.
- The server records the no-reply receipt and completes its command without a message, a placeholder, or a new agent command. There is no new message row for notification delivery to select.
- `createCorner` registers its automatic watch without waking its opener. A lifecycle emitter also suppresses the opener's legacy Room subscription; another watcher still receives opened.
- Closing still archives the corner and preserves its existing state/cleanup path, but emits no closed event and delivers no closed wake, including for existing watches.
- The actual GitHub merge webhook still wakes the opener once with the merge commit.

Regression suites: `monolith-room-turn.failure.test.ts`, `monolith-corner-turn.test.ts`, `turn-silence-notice.test.ts`, `corner-watch.test.ts`, `corner-open-watch.test.ts`, `corner-lifecycle.test.ts`, and commander integration tests. Prompt snapshots, tool descriptions, and the event catalog cover the documented contract.

## Live browser limitation

Trusty Squire reached `https://web.usebeeline.app` and opened Ruby's DM read-only. It used an existing lunchboxfortwo owner session, not a reviewer-bypass session. No test message was sent and no corner was created through that browser. The reviewer bypass was absent from this turn's environment and the checked vault services. The branch has not been deployed to that production server, so the requested production check of fixed behavior is not obtained. After release, repeat agent corner creation with the reviewer bypass and verify that the parent DM contains no opener lifecycle reply.

Revision 2 uses the integration proof above as the browser alternative. The report tool description includes the exact completion/decision/blocker sentence, verified by `read-only-mcp.test.ts` (23 passing tests).
