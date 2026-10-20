# Client protocol invariants

- **The phone has one write transport:** the authenticated monolith API. `BuzzRigTransport` is an alias of `MonolithRigTransport`.
- **A stalled request moves to a fresh connection.** RN Android's OkHttp (no read timeout) multiplexes onto a silently dead pooled HTTP/2 connection, and an abort never evicts it. `MonolithSession` repeats a repeatable request (`phoneOperationRequestOptions`) on `beeline-server.fly.dev` after `MONOLITH_STALL_PROBE_MS`; its certificate is disjoint, so OkHttp cannot coalesce onto the dead connection.
- Community and Room tenancy authority: `community.ts` and server-stamped `channels.community_id`. Workspace membership covers every live top-level Room. In a two-member agent DM every human message addresses that agent (`routeHumanMessage`).
- **App links** live in `web/.well-known/` (paths/packages: `scripts/app-associations.mjs`; drift: `app-association-drift.yml`). Store review uses `beeline://review/<secret>`; the HTTPS form is a fallback.
