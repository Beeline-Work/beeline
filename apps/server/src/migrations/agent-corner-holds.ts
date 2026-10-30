// Preserve legacy holds as person-set; never infer an agent setter.
export const AGENT_CORNER_HOLDS_SCHEMA = `
ALTER TABLE corner_merge_holds ADD COLUMN IF NOT EXISTS set_by_agent_id text REFERENCES identities(id);
DROP INDEX IF EXISTS corner_merge_holds_active_actor;
CREATE UNIQUE INDEX IF NOT EXISTS corner_merge_holds_active_setter
 ON corner_merge_holds(corner_id,(COALESCE(set_by_agent_id,actor_id))) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS corner_merge_holds_agent ON corner_merge_holds(set_by_agent_id);
`;
