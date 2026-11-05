# Beeline network contracts

Phone screens send ordinary `{op,args}` requests through `apps/mobile/sources/sync/transport/live-connection.ts`. The server dispatches each operation to its existing handler. Screens render the validated answer and keep a cached copy visible while reading. A failed read reconnects and reads again, for three attempts total; Retry starts the same loop. Pushes use the same socket and its event switch. There are no phone read lanes, admission passes, projection groups, snapshot negotiation, or read certificates.

This package retains transport-free generated codecs. Phone writes use the same socket request as reads; the optional persisted command owner and its package entrypoint are removed. Helper codecs belong to their existing machine channels.

`scripts/generate-network-codecs.mjs` derives structural codecs from the operation contracts. Unsupported TypeScript shapes and compiler errors fail generation; CI checks drift. Binary uploads/downloads retain their documented leaves in `apps/mobile/network-channels.json`.

Validation: `npm test -w @beeline/net`, `npm run lint:router`, `npm run test:phone-network`. The phone manifest only shrinks. Its planted fetch/WebSocket tests reject another channel; the core remains transport-free.
