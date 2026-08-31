# Direct snapshot import

The import has three read-only inputs and one target:

- an old PostgreSQL transaction snapshot;
- the version 1/2 push registry JSON;
- a media manifest whose entries contain `legacyUrl`, `path` or `bytesBase64`, `ownerId`, `mimeType`, and `name`;
- an empty or previously interrupted new PostgreSQL database.

`readOldPostgresSnapshot` maps the actual legacy `channels`, `channel_members`, `users`, and `events` rows. Workspace, parent/corner, direct-message, repository, agent declaration, soul, model, schedule, read-mark, and GitHub facts are decoded directly. Message/card projection calls `@beeline/push-gateway/projection`, the existing RoomView projection authority.

The relay-internal audit log is deliberately absent from every query and destination table. Deleted events and deleted channels are excluded. Removed memberships are retained with `removed_at` so an import cannot resurrect a removed person.

Each source item is claimed in the same target transaction as its mapped write. If the process stops after any row, rerunning the same snapshot and `IMPORT_ID` skips committed items and continues. A changed source fingerprint cannot reuse an import ID.

Parity normalizes only intentional attachment URL changes. The production-shaped fixture in `src/importer.test.ts` covers DM, corner, archived room, reply, attachment bytes, permission card, target branch, daemon fact, plan, soul/model selection, read mark, GitHub state, schedule, push registry/receipt, and removed member.
