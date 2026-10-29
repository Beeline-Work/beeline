// Start clean: transcript predicates cannot establish trustworthy release authority.
export const CORNER_MERGE_HOLDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS corner_merge_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corner_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES identities(id),
  standing text NOT NULL CHECK (standing IN ('owner','admin','member')),
  set_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by text REFERENCES identities(id),
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);
`;
