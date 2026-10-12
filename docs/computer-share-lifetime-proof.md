# Squire share lifetime and navigation consumer proof

This change implements the Squire 1.1.33 contract supplied by firstmate: repeated `operate_share {session_id}` calls retain the URL and advance `expires_at`; the stream supplies main-frame `{type: 'navigation', url, origin}` notifications. It is independent of the phone-opening change at https://github.com/Beeline-Work/beeline/pull/2373.

`SquireShareRenewals` runs on the owning helper connection between model turns, without extending the conversation's idle lease. Room and corner callbacks persist renewed expiry through `refreshComputerSession`. The server matches the agent, Room, source session, and upstream URL, advances expiry monotonically, and cannot resurrect an ended card.

A stored deadline is upstream lease metadata, not proof that the browser ended. Readers preserve the live state while renewal is delayed. The sweep confirms a gone upstream URL before ending a stale share, tolerates transport/service failures, and rechecks expiry at the ending write so a concurrent renewal wins. Existing explicit agent ends and source-reap notifications remain authoritative.

Navigation is recorded only from an explicit upstream notification while the human controls the browser. Only its HTTP(S) origin enters the agent activity context; page paths, queries, and form values are excluded. Pointer events and changing frames cannot synthesize navigation.

## Regression evidence

- Renewal scheduler crosses three shortened upstream lifetimes with the same URL and human control; transient failure, explicit end, owner reap, and a late response after helper close are covered.
- The real helper relay instance renews between model turns on one owning connection over more than two shortened lifetimes. This test uses the supplied provider contract fixture, not a live Squire broker.
- Server tests cover persisted renewals over successive old deadlines, wrong-owner/URL refusals, explicit-end non-resurrection, a renewal racing a previously selected sweep, a still-live upstream after stale expiry, service unavailability, and confirmed source reap.
- URL and origin-only navigation notifications flow through the actual stream proxy into a claimed agent turn. Initial agent navigation, pointer input, and changed frame pixels produce no navigation observation. This verifies the consumer protocol; production Squire form-submit emission is upstream work.

Focused helper tests: 58 passed. Computer-session server tests: 16 passed. Daemon access tests: 5 passed. Shared api-contract tests: 465 passed. Root typecheck and workspace build/dead-code checks are recorded in the PR's validation results.

## Live proof boundary

The isolated production helper and real Chromium/Squire cards used for the separate F3 proof were cleaned up: all four test cards ended, the throwaway review agent Echo was retired, the helper was stopped after verifying its exact `/tmp/b5.J1mbQU` state root, both named task browsers stopped, and emulator-5572 stopped. The shared helper and Squire broker were not restarted or updated.

At consumer validation time npm still advertised Squire 1.1.32. Full live renewal/navigation proof against Squire 1.1.33 remains pending its upstream publication and deployment; these consumer regressions do not claim production form-submit or two ten-minute lifetime acceptance.
