-- Historical storage from 5543606b6^; fixture for existing-install upgrade proof.
-- Agent-authored, code-free views shared by every member of one corner.
-- The definition is validated at the daemon boundary and interpreted by the
-- phone; no executable client payload is stored here.
CREATE TABLE IF NOT EXISTS corner_apps (
  corner_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  slug text NOT NULL,
  author_agent_id text NOT NULL REFERENCES identities(id),
  definition jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (corner_id, slug)
);
CREATE INDEX IF NOT EXISTS corner_apps_author_idx ON corner_apps(author_agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS corner_apps_command_idx
  ON corner_apps(corner_id,(definition->>'command'));

-- Workspace-installed apps and their zero-or-one binding to a corner. The
-- manifest separates human UI from agent broker capabilities; neither opaque
-- broker capability executes at this storage boundary.
CREATE TABLE IF NOT EXISTS corner_app_installations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installed_by text NOT NULL REFERENCES identities(id),
  developer_agent_id text REFERENCES identities(id),
  manifest jsonb NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS corner_app_installations_workspace_idx
  ON corner_app_installations(workspace_id,connected_at DESC);
CREATE TABLE IF NOT EXISTS corner_app_bindings (
  corner_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES corner_app_installations(id) ON DELETE RESTRICT,
  instance_id uuid NOT NULL UNIQUE,
  bound_by text NOT NULL REFERENCES identities(id),
  bound_at timestamptz NOT NULL DEFAULT now()
);
