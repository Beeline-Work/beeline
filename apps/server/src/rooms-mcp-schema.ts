/** OAuth credentials are independent of phone and helper credentials. */
export const ROOMS_MCP_SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms_mcp_clients (
  id text PRIMARY KEY, name text NOT NULL, redirects jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rooms_mcp_clients_created ON rooms_mcp_clients(created_at);
CREATE TABLE IF NOT EXISTS rooms_mcp_flows (
  id text PRIMARY KEY, browser_hash text NOT NULL, client_id text NOT NULL REFERENCES rooms_mcp_clients(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL, state text NOT NULL, challenge text NOT NULL, scope text NOT NULL,
  identity_id text REFERENCES identities(id) ON DELETE CASCADE,
  provider text, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_mcp_flows_identity ON rooms_mcp_flows(identity_id);
CREATE INDEX IF NOT EXISTS rooms_mcp_flows_client ON rooms_mcp_flows(client_id);
CREATE INDEX IF NOT EXISTS rooms_mcp_flows_expiry ON rooms_mcp_flows(expires_at);
CREATE TABLE IF NOT EXISTS rooms_mcp_codes (
  hash text PRIMARY KEY, client_id text NOT NULL REFERENCES rooms_mcp_clients(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL, challenge text NOT NULL, scope text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_mcp_codes_identity ON rooms_mcp_codes(identity_id);
CREATE INDEX IF NOT EXISTS rooms_mcp_codes_client ON rooms_mcp_codes(client_id);
CREATE INDEX IF NOT EXISTS rooms_mcp_codes_expiry ON rooms_mcp_codes(expires_at);
CREATE TABLE IF NOT EXISTS rooms_mcp_tokens (
  hash text PRIMARY KEY, client_id text NOT NULL REFERENCES rooms_mcp_clients(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  scope text NOT NULL, expires_at timestamptz NOT NULL,
  revoked_at timestamptz, window_at timestamptz NOT NULL DEFAULT now(), calls integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rooms_mcp_tokens_identity ON rooms_mcp_tokens(identity_id);
CREATE INDEX IF NOT EXISTS rooms_mcp_tokens_client ON rooms_mcp_tokens(client_id);
CREATE INDEX IF NOT EXISTS rooms_mcp_tokens_expiry ON rooms_mcp_tokens(expires_at);
CREATE TABLE IF NOT EXISTS rooms_mcp_audit (
  id bigserial PRIMARY KEY, client_id text NOT NULL, identity_id text NOT NULL,
  operation text NOT NULL, outcome text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rooms_mcp_audit_created ON rooms_mcp_audit(created_at);
CREATE TABLE IF NOT EXISTS rooms_mcp_admission (
  key text PRIMARY KEY, window_at timestamptz NOT NULL DEFAULT now(), calls integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rooms_mcp_admission_window ON rooms_mcp_admission(window_at);
`;
