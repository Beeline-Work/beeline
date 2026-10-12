# Computer-use round 3 proof

2026-10-11. Pre-release isolated validation; the fixed server has not been deployed.

## Squire full view

A fresh real Squire `operate_start`/`operate_share` session displayed Example Domain. The benchmark rendered the actual `ComputerSessionCard` and `ComputerSessionViewer` in a minified production React/react-native-web bundle. Its Beeline proxy ran the repository's real authorization, HTTP handler and WebSocket relay against an isolated PGlite database. Safe-area values, the modal mount and phone-operation transport were adapted to the local harness; the conversation dock was omitted. No artificial upstream delays or fixture JPEGs were used.

The card's capture-phase click timestamp starts each sample. The endpoint is a first-frame callback with a decoded, nonempty canvas, recorded on the next animation frame. The baseline's receive-based first-frame signal was checked for decoded canvas dimensions and waited for decode when necessary. The fixed handler emits the signal after `drawImage`. The preview remained mounted while the full view opened and closed five times. Raw epoch timestamps are in [timing.json](timing.json).

| Sample | Baseline ms | Fixed ms | Fixed <=1 s |
|---|---:|---:|---|
| 1 | 985 | 64 | pass |
| 2 | 1131 | 51 | pass |
| 3 | 972 | 52 | pass |
| 4 | 918 | 56 | pass |
| 5 | 939 | 49 | pass |
| Mean | 989.0 | 54.4 | pass |

The baseline repeatedly opened new Squire tunnels, with first-JPEG startup around 0.84–0.86 s. The fixed proxy replays the preview's cached JPEG immediately, embeds it in the cached HTML for the first canvas paint, and continues on the existing upstream connection. Cached WebSocket frame sends logged 0–1 ms. The card also retains its preview token: minting a full-view token previously changed the preview URL and reloaded the iframe. Regression coverage verifies five reopenings with one HTML fetch and one upstream tunnel, ongoing frames, forwarded input, blocked preview input, and HTTP affinity to the source Fly Machine.

These local numbers do **not** replace the earlier deployed measurements of 1.81–2.11 s: production network, Fly routing and PostgreSQL pool latency are absent from this timing harness. They establish removal of the measured tunnel/frame startup dependency and leave substantial margin for the 1 s target. A post-release production timing run is still required. No new share-to-card acceptance claim is made.

## Activity and claims

The source helper ran as one throwaway agent, Lumen, with model `gpt-6.1-sol`. It used the isolated supervisor/XDG root `/tmp/cu3/s` and runtime directory `/tmp/cu3/r`, authorized by firstmate after the original worktree path exceeded the Unix socket length limit. The shared helper was not restarted or updated.

The browser entered production through `/review`; only Beeline Review was used. The agent started and shared its own Squire session. Real viewer opening, a canvas click, handback and closing delivered four recorded activity kinds: `viewer-opened`, `takeover`, `handback`, and `viewer-closed`. Every activity turn completed with one attempt, zero tool calls and no durable agent reply. There were no `command claim conflict`, `no answer text`, `turn failed`, or stopped-retrying diagnostics in this isolated helper. The only prose replies answered the explicit setup and cleanup requests. [activity.json](activity.json) preserves the event ids and turn traces.

This production check used the existing server with the fixed helper. Server coalescing and failure suppression were validated separately through the real database/service integration tests. They verify one pending update per share, latest-source refresh at claim, the action list, withholding activity while requested work is pending or claimed, idempotent replay of an already accepted claim, and no failure line/retry for activity. A deterministic intake test reproduces the original race: a stale snapshot received during claim was mistaken for a later requeue and claimed again after completion. The fixed intake checks the authoritative queue before replay.

The deployed Squire activity recorder did not recognize its web canvas's `pointer` messages, so the click recorded takeover but no pointer-input event. The fixed recorder recognizes that message type, with integration coverage; phone `touch`, keyboard and scrolling continue through the existing paths.

## Composer

Two deterministic regressions demonstrate notification loops in `TextDraft`: an unchanged controlled-field echo, and a synchronous subscriber replacement during notification. Both failed without the fix. The fixed store notifies a snapshot once and does not repaint unchanged text. Identical replacement edits still advance the revision, preserving send and hydration fencing.

The actual composer and draft hook were exercised in a production React/RNW browser harness at widths 200, 260, 320, 390 and 600 px, replacing an existing leading-mention draft with multiline text. Each retained the tags and replacement text, with no browser errors. Ordinary replacement alone did not recreate the original release's React 185; that original exact input sequence was not retained. The regression tests isolate the two store notification mechanisms consistent with its `notify`/`set`/`onChangeText` stack, rather than claiming attribution to one specific original event.

## Verification

- Server: 144 related tests passed; the final computer-session suite (9 tests) passed again after adding web-pointer recording.
- Helper: 116 related tests passed, including silent Room and corner activity, real command transport, and normal human-answer failure behavior.
- Mobile: 54 related tests passed, including draft persistence/send fencing and preservation of the preview token.
- Type checks passed for server, helper and mobile; the API contract was rebuilt.
- The Squire cache, activity-coalescing, duplicate-claim, preview-token and draft-notification regression tests were confirmed to fail without their fixes.

Re-run the maintained coverage with:

```sh
npm run build -w @beeline/api-contract
npm test -w @beeline/server -- src/computer-session.test.ts src/agent-command.integration.test.ts src/turn-silence-notice.test.ts
npm test -w @beeline/body -- src/server-command-intake.test.ts src/monolith-room-turn.failure.test.ts src/monolith-corner-turn.test.ts
npm test --prefix apps/mobile -- --run sources/buzz/text-draft-store.test.ts sources/buzz/text-drafts.integration.test.tsx sources/components/buzz/ComputerSession.test.tsx sources/components/buzz/ConversationComposer.test.tsx
npm run typecheck -w @beeline/server
npm run typecheck -w @beeline/body
npm run typecheck --prefix apps/mobile
```

## Cleanup and limits

The benchmark Squire session was finished. Lumen finished its own operate session; the server confirmed its share ended. Lumen was then retired through the review identity's `removeAgent` operation. The source helper's installed MCP shim did not expose `end_browser_share`; finishing the underlying session was the cleanup path exercised. Worktree-owned browser/server processes were stopped after evidence capture.

No captain Workspace, live helper, shared no-mistakes daemon, shared Squire broker or other emulator was stopped, restarted or updated. No emulator was needed. This is not native Android, store-artifact or post-deployment certification.
