# Beeline network contracts and command intents

Phone screens send ordinary `{op,args}` requests through `apps/mobile/sources/sync/transport/live-connection.ts`. The server dispatches each operation to its existing handler. Screens render the validated answer and keep a cached copy visible while reading. A failed read reconnects and reads again, for three attempts total; Retry starts the same loop. Pushes use the same socket and its event switch. There are no phone read lanes, admission passes, projection groups, snapshot negotiation, or read certificates.

This package retains transport-free generated codecs and the existing durable command intent owner. Commands persist immutable bytes and identity before dispatch, and never downgrade or automatically repeat an uncertain effect. `@beeline/net/owner` belongs to the persisted command owner; helper codecs belong to their existing machine channels. Reads need no private capability.

`scripts/generate-network-codecs.mjs` derives structural codecs from the operation contracts. Unsupported TypeScript shapes and compiler errors fail generation; CI checks drift. Binary uploads/downloads retain their documented leaves in `apps/mobile/network-channels.json`.

Validation: `npm test -w @beeline/net`, `npm run lint:router`, `npm run test:router-boundaries`, and `npm run test:phone-network`. The phone manifest only shrinks. Its planted fetch/WebSocket tests reject another channel; the core remains transport-free.
