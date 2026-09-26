import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { notifyConnectorAssignment } from './postgres-live.js';

/**
 * Public callback rendezvous for Registry MCP OAuth.
 *
 * The helper owns PKCE and provider credentials. The server retains only an
 * opaque state and the short-lived authorization code until that same helper
 * claims it; access and refresh tokens never cross this boundary.
 */
export class RegistryMcpOAuth {
  readonly redirectUri: string;

  constructor(
    private readonly database: SqlDatabase,
    publicOrigin: string,
  ) {
    this.redirectUri = new URL('/v1/registry-mcp/oauth/callback', publicOrigin).toString();
  }

  async begin(
    connectorId: string,
    helperAgentId: string,
  ): Promise<{ state: string; redirectUri: string }> {
    const connector = await this.database.query(
      `SELECT 1 FROM workspace_connectors
       WHERE id=$1::uuid AND helper_agent_id=$2 AND connector_type='registry-mcp'
         AND status='installing'`,
      [connectorId, helperAgentId],
    );
    if (!connector.rowCount) throw new Error('connector not found for this helper');
    const state = `${randomUUID()}${randomUUID()}`;
    await this.database.transaction(async (database) => {
      await database.query(`DELETE FROM registry_mcp_oauth_attempts WHERE connector_id=$1`, [
        connectorId,
      ]);
      await database.query(
        `INSERT INTO registry_mcp_oauth_attempts(state,connector_id,expires_at)
         VALUES($1,$2,now()+interval '10 minutes')`,
        [state, connectorId],
      );
    });
    return { state, redirectUri: this.redirectUri };
  }

  async complete(state: string, code: string): Promise<boolean> {
    if (!state || state.length > 200 || !code || code.length > 8_192) return false;
    const row = (
      await this.database.query<{ connector_id: string; helper_agent_id: string }>(
        `UPDATE registry_mcp_oauth_attempts attempt
         SET code=$2
         FROM workspace_connectors connector
         WHERE attempt.state=$1 AND attempt.expires_at>now() AND attempt.code IS NULL
           AND connector.id=attempt.connector_id AND connector.status='installing'
         RETURNING attempt.connector_id,connector.helper_agent_id`,
        [state, code],
      )
    ).rows[0];
    if (!row) return false;
    await notifyConnectorAssignment(this.database, row.helper_agent_id);
    return true;
  }

  async cancel(state: string): Promise<boolean> {
    const row = await this.database.query<{ connector_id: string }>(
      `DELETE FROM registry_mcp_oauth_attempts WHERE state=$1 AND expires_at>now()
       RETURNING connector_id`,
      [state],
    );
    if (!row.rowCount) return false;
    await this.database.query(
      `UPDATE workspace_connectors SET status='error',status_error='Provider authorization was denied',
         sign_in=NULL,updated_at=now() WHERE id=$1 AND status='installing'`,
      [row.rows[0]!.connector_id],
    );
    return true;
  }

  async claim(
    connectorId: string,
    state: string,
    helperAgentId: string,
  ): Promise<{ status: 'pending' } | { status: 'ready'; code: string }> {
    const row = (
      await this.database.query<{ code: string }>(
        `DELETE FROM registry_mcp_oauth_attempts attempt
         USING workspace_connectors connector
         WHERE attempt.state=$1 AND attempt.connector_id=$2::uuid
           AND attempt.expires_at>now() AND attempt.code IS NOT NULL
           AND connector.id=attempt.connector_id AND connector.helper_agent_id=$3
           AND connector.connector_type='registry-mcp' AND connector.status='installing'
         RETURNING attempt.code`,
        [state, connectorId, helperAgentId],
      )
    ).rows[0];
    return row ? { status: 'ready', code: row.code } : { status: 'pending' };
  }
}
