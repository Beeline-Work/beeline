# Corner list freshness — Reproduction 5b25dbcb

Base: `6771892c615b63789d705740ce0794b48cceca9b`.

## Reproduced

The new `room-corner-store.test.ts` case subscribes a real server `LiveHub`,
applies two working corner projections, publishes changes in 257 other Rooms,
then publishes an idle projection in the parent Room without reconnecting.
On the unchanged base implementation it fails: expected `idle`, received
`working`. The server has restarted the sequence at 1 under a different epoch.
This is the brief's server/client stand-in, not an Android production recording.

## Demonstrated

With this branch, the same test passes. The transport regression also verifies
that the same open socket accepts the new epoch, rejects its duplicate sequence,
and reconnects with the new epoch's resume cursor. Server WebSocket tests prove
that an unchanged status is resent after eviction, and that an old epoch's
in-flight projection cannot arrive after the new epoch's projection.

The actual Corners component test mounts a previously current record, holds
its GET pending, and verifies the existing rows remain painted. Completing the
GET updates the list. A background/foreground transition then issues another
GET and paints the changed server row. Existing tests exercise the header and
list together.

Validation: 89 mobile tests in the corner-store, live-connection and mounted
Corners suites; 82 server WebSocket/service tests; root typecheck; workflow path
lint.

## Outstanding acceptance evidence

The Android production recording and measured browser check within about two
seconds have not been obtained. The attached emulator was running a separate
Tap selection preview, rather than this branch's authenticated app; it was
inspected without changing its state.

An authenticated session at `web.usebeeline.app` was inspected. A disposable
`calm-atlas-corner` (`b6a10d20-94ad-498a-9646-560f2200f9b3`) was created and
Close corner selected. The parent list subsequently still showed `idle`.
Later the corner no longer exposed actions or a composer, but the browser
runner returned stale controls, so this is not a reliable archive timing proof.
The session was closed. The existing session was already signed in as the
owner; a fresh GitHub reviewer-bypass sign-in was not demonstrated.

This PR stays draft pending an isolated authenticated Android/web proof with
the branch client and server, or an approved replacement for those acceptance
steps. Production does not contain this unmerged fix; no release was attempted.
