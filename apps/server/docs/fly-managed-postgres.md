# Fly Managed Postgres migration

This is the production procedure used to move `beeline-server` from Neon to the Fly Managed
Postgres cluster in `iad`. Keep every database URL in Fly secrets and execute the commands from a
Fly Machine; never place a URL in a shell argument, log, dump, or repository file.

## Prepare and copy

1. Provision a Basic Fly Managed Postgres cluster in the `beeline-server` organization and region.
2. Provision a schema-administrator application role and store its direct private-network URL as
   `FLY_PG_URL` on every server machine. The Fly CLI attach output is not used.
3. From one server machine, point all three schema owners at `FLY_PG_URL`: the server database
   migration, `AuthStore.migrate()`, and the push-gateway materializer migrations. This creates the
   target schema with application-owned migrations rather than database-version-specific dump DDL.
4. Upload `apps/server/scripts/copy-postgres-data.mjs` to a machine scratch directory and run it
   there with the machine's existing environment. It reads Neon through `DATABASE_URL`, writes Fly
   through `FLY_PG_URL`, and never prints either. It refuses a target not named `fly-db`, copies a
   repeatable-read source snapshot in foreign-key order, advances owned sequences, and verifies all
   source table counts before committing. Application-owned tables introduced by a newer schema
   migration may exist only on Fly; the script preserves them and requires them to be empty.

The copy is a full reload of the unused Fly target. It truncates only `fly-db`; it never mutates the
Neon source. Repeat the copy after quiescing writers if the preliminary copy and cutover are not in
one downtime window. Once Fly is live, run the script with `--delta`: it performs insert-only,
conflict-safe reconciliation, proves every source primary key is present, and never truncates or
overwrites a row already accepted by Fly.

## Cut over and verify

The production cutover used two idempotent reconciliation passes around the secret swap so a write
accepted during the transition could not be lost:

1. Run the full reload once more while Neon is still live (`delta-1`).
2. Change `DATABASE_URL` on every application that holds it to the already-vaulted Fly URL. Set
   `DATABASE_LISTENER_URL` to that same direct, non-pooled URL for `beeline-server` when the
   LISTEN/NOTIFY release is deployed.
3. With Fly serving production, retain the Neon URL in an in-machine migration variable and run
   the script with `--delta` (`delta-2`). This inserts missing Neon rows without truncating or
   overwriting rows Fly has already accepted, then verifies source primary-key coverage.
4. Verify `/ready` returns 200.
5. Run `apps/server/scripts/verify-fly-cutover.mjs` inside a server machine. It signs in through
   the existing review boundary, sends a uniquely identified real message to a reachable helper,
   and requires the stored message, turn receipt, and correlated helper answer to appear through
   the running server.
6. Confirm the dedicated listener reports connected after the Stage 2 release is deployed.

Keep the Neon project intact, enabled, and unchanged until the captain separately approves its
retirement.

Production completed the cutover on PostgreSQL 16.15 with readiness returning HTTP 200. Delta-2
verified all source primary keys/count floors across 65 Neon tables and advanced three owned
sequences. The running-server verification stored its real message, observed the helper's turn
receipt, and read the correlated reply; the post-verification Fly count was 2,440 messages. The
direct private connection was exercised by schema creation and both copy passes. Dedicated LISTEN
verification remains due with the Stage 2 release.

## Roll back

Use the secret value retained by the operator; do not expand or print it:

```sh
flyctl secrets set -a beeline-server DATABASE_URL="${NEON_ROLLBACK_DATABASE_URL}"
```

Restore any other application secret changed during cutover the same way, then verify `/ready` and
a real message round trip. Any writes accepted only by Fly after cutover must be reconciled before a
rollback; do not silently discard them.
