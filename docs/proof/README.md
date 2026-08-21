# Agent pairing and soul proof

Captured on an Android API 36 emulator against the local relay at
`http://127.0.0.1:3010` with `adb reverse tcp:3010 tcp:3010` and the local soul
service with `adb reverse tcp:8789 tcp:8789`.

The mobile app created a short pairing command, and the built `beeline pair` CLI
redeemed it using a separately generated agent identity. The agent appeared in
the community list under pubkey
`502ea950d8de74ca62ba159d869ba3be013fa274ae622d4c488e5e89b58a6a2b`.

The intent `keep the test suite green and refactor mercilessly` was sent from
the app to the local body soul service. The service used the server-held LLM
egress grant and returned the name **Cautious Code Guardian** plus its
personality. The app saved that result as the human-signed, community-scoped
display overlay and rendered the deterministic pubkey sigil.

- [Soul generation result](./agent-soul-generation.png)
- [Community agent list](./community-agent-list.png)

Fresh-clone verification of the feature commit completed with exit code 0 for
root `npm install`, `npx turbo run build`, mobile `npm install`, the root
typecheck and full tests, and the mobile full test suite.

## Identity fill axis

The [identity fill-axis proof](./identity-axis.md) renders the shipped
`IdentityMark` at 26, 28, 30, 38, and 44dp across every kind and compares the
chosen solid/hollow/half field against stroke weight, orientation, and interior
density.
