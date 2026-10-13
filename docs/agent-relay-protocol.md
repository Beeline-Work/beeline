# Relay and client protocol invariants

Paths and commands below are relative to the repository root. Read these invariants before editing this area; named code and tests hold implementation detail.

## Relay and client protocol

- **kind:30078 reads filter by `#d`, never `#h`** (a `#h` filter matches nothing). `agentPresenceKey` (`packages/buzz-client/src/agent-presence.ts`) builds presence keys. Test with `matchesFilterRelayFaithfully`/`deliverRelayFaithfully` (`client.test.ts`); generic stubs miss this.
- **Production relays may answer a multi-value `#h`/`#d` filter for one key only**, so every `packages/buzz-client` fan-out sends one single-key filter per key inside one batched query.
- `relay-stack/compose.yml` is an isolated, credential-free stack; use repo-less Rooms there because its materializer cannot serve GitHub-backed corners. Gate live tests: `npm run stack:up`, then `cd apps/gate && npm run test:live`.
- **The phone has one write transport:** the authenticated monolith API. `BuzzRigTransport` is an alias of `MonolithRigTransport`; the `@beeline/buzz-client` HTTP bridge and `apps/gate` serve only the isolated relay stack and scripts.
- **A stalled request moves to a fresh connection.** RN Android's OkHttp (no read timeout) multiplexes onto a silently dead pooled HTTP/2 connection, and an abort never evicts it. `MonolithSession` repeats a repeatable request (`phoneOperationRequestOptions`) on `beeline-server.fly.dev` after `MONOLITH_STALL_PROBE_MS`; its certificate is disjoint, so OkHttp cannot coalesce onto the dead connection.
- Community and Room tenancy authority: `community.ts` and server-stamped `channels.community_id`. Workspace membership covers every live top-level Room. In a two-member agent DM every human message addresses that agent (`routeHumanMessage`). Private pairing proof: `npm run prove:private-pairing`.
- **App links** live in `relay-stack/web/.well-known/` (paths/packages: `scripts/app-associations.mjs`; drift: `app-association-drift.yml`). Store review uses `beeline://review/<secret>`; the HTTPS form is a fallback.
