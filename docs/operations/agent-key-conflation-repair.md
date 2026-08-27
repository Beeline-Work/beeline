# Agent-key conflation audit and repair

This procedure is gated. Do not change memberships or relay rows until the
read-only audit reports `CONFLATED` for the suspected human pubkey.

## Production finding for 93af5ee4… (2026-08-24)

The reported live conflation does not exist in the current relay data:

- Alan's `93af5ee4…` key has one global human kind:0 profile and zero
  self-signed `#t=buzz-agent` markers.
- Clara already owns the distinct key `3bdb326b33d4dce8c0d1b8f4972552b912d3eaaa00af395a5a477cd30f3490ce`.
  That key self-signed Clara's `#t=buzz-agent` record, owns Clara's Workspace
  and Room memberships, and publishes Clara's presence.
- The kind:30078 row signed by Alan is the expected human-authored soul
  overlay. Its `p` tag targets Clara's distinct key. The signer is the editor,
  not the agent identity.

Therefore the repair gate says **stop**: do not mint a replacement Clara, do
not remove Alan from any channel, and do not delete Alan's soul overlay.

Run the audit against any relay database with the production schema:

```sh
psql "$DATABASE_URL" \
  -v old_pubkey=93af5ee4bcb4b4910bd586a5bb07a7e6db065461ac44c365997dd467df921899 \
  -f scripts/audit-agent-key-conflation.sql
```

Expected current verdict: `HUMAN_ONLY: do not migrate this key`, followed by
Clara's `3bdb326b…` target with `target_has_self_signed_agent_marker = true`.

## Conditional repair for a genuinely conflated key

Use this only when the audit reports both a human profile and a self-signed
agent marker on the same key.

1. Record the Workspace id, the exact top-level Rooms served by the old
   runtime, and every open corner. Finish and archive open corners first. ACP
   sessions, feature worktrees, signatures, and presence leases cannot be
   transferred safely to a different Nostr key.
2. Upgrade Beeline. In Members, create one new pairing code. On the machine
   that will run the agent, pair once with the displayed command and record the
   printed new agent pubkey. Pairing creates the fresh key, self-signed agent
   record, Workspace membership, runtime record, and daemon.
3. Verify the new pubkey has a self-signed `#t=buzz-agent` record, no kind:0
   profile, and is not the pairing-code minter. Abort if any check fails.
4. In Members, set the new agent's existing name/soul/avatar seed. Add that
   agent to each recorded top-level Room. Do not bulk-copy the old pubkey's
   `channel_members` rows: those include the human's own Rooms and roles.
5. Wait for the new pubkey to publish an online presence lease in every served
   Room. Send one addressed test message and confirm the new daemon replies.
6. Stop the old daemon and recoverably archive its local runtime directory.
   Do not remove the old pubkey through the Members "Remove Agent" action:
   for a conflated key that would also remove the human's memberships.
7. In one database transaction, soft-delete only the invalid old-key agent
   artifacts shown below. Review the `RETURNING` rows before commit. Never
   touch the old key's kind:0 profile, ordinary kind:9 chat, approvals, or
   `channel_members` rows.

```sql
BEGIN;

-- Substitute the audited values; keep these as bytea expressions.
CREATE TEMP TABLE repair_keys AS
SELECT
  decode('<OLD_HUMAN_PUBKEY_HEX>', 'hex') AS old_key,
  decode('<NEW_AGENT_PUBKEY_HEX>', 'hex') AS new_key;

-- Preconditions: old is truly conflated; new is a clean agent identity.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM events e, repair_keys k
    WHERE e.deleted_at IS NULL AND e.kind = 0 AND e.pubkey = k.old_key
  ) OR NOT EXISTS (
    SELECT 1 FROM events e, repair_keys k
    WHERE e.deleted_at IS NULL AND e.kind = 9 AND e.pubkey = k.old_key
      AND e.tags @> '[["t","buzz-agent"]]'::jsonb
  ) THEN
    RAISE EXCEPTION 'old key is not proven conflated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM events e, repair_keys k
    WHERE e.deleted_at IS NULL AND e.kind = 0 AND e.pubkey = k.new_key
  ) OR NOT EXISTS (
    SELECT 1 FROM events e, repair_keys k
    WHERE e.deleted_at IS NULL AND e.kind = 9 AND e.pubkey = k.new_key
      AND e.tags @> '[["t","buzz-agent"]]'::jsonb
  ) THEN
    RAISE EXCEPTION 'new key is not a clean agent identity';
  END IF;
END $$;

-- The immutable old self-signed marker is what classifies the human as agent.
UPDATE events e SET deleted_at = now()
FROM repair_keys k
WHERE e.deleted_at IS NULL AND e.kind = 9 AND e.pubkey = k.old_key
  AND e.tags @> '[["t","buzz-agent"]]'::jsonb
RETURNING encode(e.id, 'hex'), e.kind, e.tags;

-- Remove overlays/configuration that TARGET the invalid old agent identity.
UPDATE events e SET deleted_at = now()
FROM repair_keys k
WHERE e.deleted_at IS NULL AND e.kind = 30078
  AND e.tags @> jsonb_build_array(jsonb_build_array('p', encode(k.old_key, 'hex')))
  AND (
    e.tags @> '[["t","buzz-agent-soul"]]'::jsonb OR
    e.tags @> '[["t","buzz-agent-model-config"]]'::jsonb
  )
RETURNING encode(e.id, 'hex'), e.kind, e.tags;

-- Retire self-authored ephemeral/runtime projections. Presence is not moved;
-- the new daemon has already published a fresh lease under its own key.
UPDATE events e SET deleted_at = now()
FROM repair_keys k
WHERE e.deleted_at IS NULL AND e.kind = 30078 AND e.pubkey = k.old_key
  AND (
    e.tags @> '[["t","agent-presence"]]'::jsonb OR
    e.tags @> '[["t","agent-draft"]]'::jsonb OR
    e.tags @> '[["t","buzz-agent-model-catalog"]]'::jsonb OR
    e.tags @> '[["t","buzz-agent-commands"]]'::jsonb OR
    e.tags @> '[["t","buzz-corner-state"]]'::jsonb
  )
RETURNING encode(e.id, 'hex'), e.kind, e.tags;

-- Inspect before changing ROLLBACK to COMMIT.
ROLLBACK;
```

Run the transaction once with `ROLLBACK`. Compare its returned ids with the
audit. Only then rerun it with `COMMIT`. Restart the materializer after commit
to clear presentation metadata caches; the new daemon supplies fresh presence.

### One instruction block for the machine owner

```sh
curl -fsSL https://usebeeline.app/install | sh
env -u BUZZ_AGENT_KEY -u BUZZ_PRIVATE_KEY beeline pair BUZZ-XXXX-XXXX
```

The owner should not export, paste, or reuse a Nostr secret. Firstmate handles
the gated old-runtime retirement and relay transaction after the new agent is
online.
