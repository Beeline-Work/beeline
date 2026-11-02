# Staged Saved live head and stable history proof

This implementation remains unselected. It does not close F04, F06, F13 or T7.
The complete cohort/workload matrix and production clock/source composition are
still required before negotiation.

A new bookmark incarnation triggers a bounded canonical head projection. The
existing build coordinator shares that projection by reader, query, committed
cut, authority and clock. A `needs-you-saved-page` scope replacement must have
no `before` anchor; the group assembler applies it only to the live head.
Historical windows receive complete exact-incarnation row replacements/removals,
never insertion or hole refill. No client possession is sent or stored.

The phone keeps coherent held pages visible and follows server-authored cursor
links to the first missing continuation. A shifted head cannot make Load More
skip the gap ahead of a previously held page. Only the existing button admits
that read; source traffic and observer mounts admit none.

## Executable evidence

- `packages/net/src/read-lanes.tray-group.test.ts`: 100 bounded head updates
  preserve held history and advance the complete group together, with three
  initial reads and zero additional reads. Malformed head/row facts park the
  group without persisting partial coverage.
- `apps/mobile/sources/buzz/router-tray.test.ts`: 100 shifted head cursors make
  no page request. The explicit button reads the missing bridge once; overlap
  is deduplicated and the existing older page remains visible.
- `apps/server/src/tray-saved-source.test.ts`: a new incarnation builds only the
  unanchored 30-row head; ordinary content edits and removal do not rebuild it.
- `apps/server/src/router-projections.integration.test.ts`: two real protocol
  consumers reuse one head build at the same cut. An injected head-budget
  refusal parks Tray while Room-list delivery succeeds; this case tests failure
  isolation, not a full oversized-content presentation proof.
- `apps/server/src/tray-saved-window.postgres.test.ts` and
  `tray-saved-source.postgres.test.ts`: isolated PostgreSQL cursor precision,
  incarnation/source transactions and private audiences.

Server and mobile typechecks, generated codec freshness, the phone network
scanner and router boundary gate pass. The full phone consumer remains inside
the owner-approved 90112 raw / 24576 gzip hard limit. These checks do not replace
physical native40, release/rollback, full server fanout or all-consumer proofs.
