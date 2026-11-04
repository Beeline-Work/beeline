-- B8: one-time contract, only after every serving and supported rollback image
-- is free of agent-class-retirement.ts (docs/release-pipeline.md). Not run here.
BEGIN;
SET LOCAL lock_timeout='500ms';
ALTER TABLE messages DROP COLUMN IF EXISTS turn_id;
ALTER TABLE agents DROP COLUMN IF EXISTS custom_tags;
ALTER TABLE workspaces DROP COLUMN IF EXISTS weight_tier_rules;
COMMIT;
