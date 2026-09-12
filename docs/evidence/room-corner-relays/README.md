# Room/corner relay evidence

Captured in Chrome at **390 × 844**, using the production `RelayHandOff`, `DaemonFactCard`, and `HullSurface` declarations and styles. The preview extracts those declarations verbatim to avoid initializing unrelated native modules; its outer header is a component harness. Fonts and colors come from the mobile app. These are browser component captures backed by real `DaemonService` writes and `PhoneService` projections in isolated PGLite.

- [Collapsed steer](steer-collapsed.png) and [expanded steer](steer-expanded.png): Sol relays to Sol's active corner; the line has a source caption and received mark, with no speaker bubble.
- [Report in the Room](report-in-room.png): the up-relay appears beneath its corner card.
- [Corner transcript](corner-transcript.png) and [queued command](queued-steer.json): the visible received steer is also a pending `relay_steer` input for Sol. The JSON is returned by `getAgentCommands` after the real relay write. The intake test proves busy turns leave this input unclaimed until the next boundary.

Browser checks verified more/less in place and no toggle at 1280px when the report fits within two lines. Native line-layout behavior and short-text toggles are covered by the mobile component tests.

## Reproduce

From the repository root, with workspace dependencies installed:

```sh
npm run build -w @beeline/nostr
npm run build -w @beeline/api-contract
npm run build -w @beeline/buzz-client
node --import tsx docs/evidence/room-corner-relays/generate.mts
node docs/evidence/room-corner-relays/preview.mjs
```

Open `http://127.0.0.1:4187` for the corner or `http://127.0.0.1:4187/?room` for the parent Room. Resize to 390 × 844 with `chrome-devtools-axi resize 390 844`, then capture with `chrome-devtools-axi screenshot <path>`. The fixture uses invented identities and an in-memory database; it does not connect to production.

## Validation

`npm run typecheck` passes. Focused tests cover membership and active-command authority, both relay directions, same-agent delivery, queued intake, root-human stop authority, current-corner prompt context, card anchoring, unread boundaries, and collapse/expand.

The existing `phone-service.read-room-latency` concurrency-four gate exceeds its 250ms ceiling on both trees: **266ms on this branch**, **281ms on clean origin/main (`6d77cc6f`)**. Both have six passing cases and that one timing failure. The root-requester projection uses the existing `agent_commands_turn` index inside the existing read statement; it adds no Room-read round trip. Per the approved baseline comparison, this timing failure is recorded rather than chased.

## Release

Deploy the server first, then helper and phone/desktop. Relay metadata reuses `messages.card` with `card_type='relay'`; there is no new table or service. Server-first promotion is already enforced by the unified release workflow.
