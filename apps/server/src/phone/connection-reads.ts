import { queueOwnerSquireWork, squireMachineId } from '../squire-machine.js';
import { notifyConnectorHelper } from '../postgres-live.js';
import { isMetadataStale } from '../workbench.js';
import { connectorAdapter, connectorRequesterRole, faviconDomain } from '@beeline/api-contract/workbench';
import type { PhoneContext } from './context.js';
import { Input, Output } from './types.js';
import { phoneAssertWorkbenchViewer } from './workbench-catalog.js';
import { seconds } from './values.js';



  export async function phoneReadConnectionDetail(ctx: PhoneContext,
    input: Input<'readConnectionDetail'>,
    viewerId: string,
  ): Promise<Output<'readConnectionDetail'>> {
    await phoneAssertWorkbenchViewer(ctx, input.workspaceId, viewerId);
    const connection = (
      await ctx.database.query<{
        id: string;
        connector_id: string;
        reference: string;
        service: string;
        label: string | null;
        hosts: string[];
        state: 'active' | 'error';
        grants: unknown[];
        connection_metadata: Record<string, unknown>;
        last_synced_at: Date | null;
        created_at: Date;
      }>(
        `SELECT id,COALESCE(connector_id::text,'squire:' || machine_id) connector_id,reference,service,label,hosts,state,grants,
                connection_metadata,last_synced_at,created_at
         FROM workspace_connections WHERE id=$1::uuid AND owner_identity_id=$2`,
        [input.connectionId, viewerId],
      )
    ).rows[0];
    if (!connection) throw new Error('connection not found (access denied)');
    // Live detail reads: cached provider metadata older than the TTL queues a
    // `sync` op and wakes the helper for a fresh snapshot now; its recovery
    // poll only catches a wake that reached no socket.
    if (isMetadataStale(connection.last_synced_at)) {
      if (squireMachineId(connection.connector_id)) {
        await ctx.database.transaction((db) => queueOwnerSquireWork(db, viewerId,
          squireMachineId(connection.connector_id)!, 'sync'));
      } else {
        await ctx.database.query(
          `UPDATE workspace_connectors
           SET pending_ops = pending_ops || '"sync"'::jsonb, updated_at=now()
           WHERE id=$1::uuid AND NOT pending_ops @> '"sync"'::jsonb`,
          [connection.connector_id],
        );
        await notifyConnectorHelper(ctx.database, connection.connector_id);
      }
    }
    const ledger = (
      await ctx.database.query<{
        id: string;
        agent_name: string | null;
        operation: string;
        status_code: number | null;
        bytes: string;
        grant_info: string | null;
        created_at: Date;
      }>(
        `SELECT r.id,r.operation,r.status_code,r.bytes,r.grant_info,r.created_at,
                i.name agent_name
         FROM connection_receipts r
         LEFT JOIN identities i ON i.id=r.agent_id
         WHERE r.connection_id=$1::uuid
         ORDER BY r.created_at DESC LIMIT 50`,
        [connection.id],
      )
    ).rows;
    return {
      connection: {
        connectionId: connection.id,
        connectorId: connection.connector_id,
        reference: connection.reference,
        service: connection.service,
        label: connection.label ?? connection.reference,
        allowedHosts: connection.hosts ?? [],
        fieldNames: Array.isArray(connection.connection_metadata.fieldNames)
          ? connection.connection_metadata.fieldNames.filter(
              (field): field is string => typeof field === 'string',
            )
          : [],
        faviconDomain: faviconDomain(connection.hosts ?? []),
        state: connection.state,
        ...(connection.last_synced_at
          ? {
              lastSyncedAt: seconds(connection.last_synced_at),
              ...(isMetadataStale(connection.last_synced_at) ? { stale: true } : {}),
            }
          : { stale: true }),
        createdAt:
          typeof connection.connection_metadata.vaultCreatedAt === 'number' &&
          Number.isFinite(connection.connection_metadata.vaultCreatedAt) &&
          connection.connection_metadata.vaultCreatedAt > 0
            ? connection.connection_metadata.vaultCreatedAt
            : seconds(connection.created_at),
      },
      grants: (connection.grants ?? []) as Output<'readConnectionDetail'>['grants'],
      ledger: ledger.map((row) => ({
        id: row.id,
        ...(row.agent_name ? { agentName: row.agent_name } : {}),
        operation: row.operation,
        ...(row.status_code !== null ? { statusCode: row.status_code } : {}),
        ...(Number(row.bytes) > 0 ? { bytes: Number(row.bytes) } : {}),
        ...(row.grant_info ? { grant: row.grant_info } : {}),
        createdAt: seconds(row.created_at),
      })),
    };
  }


  export async function phoneRevokeConnectionGrants(ctx: PhoneContext,
    input: Input<'revokeConnectionGrants'>,
    viewerId: string,
  ): Promise<Output<'revokeConnectionGrants'>> {
    await phoneAssertWorkbenchViewer(ctx, input.workspaceId, viewerId);
    const connection = (
      await ctx.database.query<{
        id: string;
        connector_id: string;
        connector_type: Input<'pairConnector'>['connectorType'];
        reference: string;
        grants: Array<Record<string, unknown>>;
        owner_identity_id: string;
      }>(
        `SELECT c.id,COALESCE(c.connector_id::text,'squire:' || c.machine_id) connector_id,
                COALESCE(k.connector_type,'trusty-squire') connector_type,c.reference,c.grants,
                c.owner_identity_id
         FROM workspace_connections c
         LEFT JOIN workspace_connectors k ON k.id=c.connector_id
         WHERE c.id=$1::uuid`,
        [input.connectionId],
      )
    ).rows[0];
    if (!connection) throw new Error('connection not found (access denied)');
    const adapter = connectorAdapter(connection.connector_type);
    const role = connectorRequesterRole(viewerId, connection.owner_identity_id);
    if (adapter) {
      if (!adapter.authorize('revoke-grants', role).allowed)
        throw new Error('connection not found (access denied)');
    } else if (connection.owner_identity_id !== viewerId) {
      throw new Error('connection not found (access denied)');
    }
    const live = (connection.grants ?? []).filter((grant) => !grant.revokedAt && !grant.revokingAt);
    const alreadyPending = (connection.grants ?? []).filter(
      (grant) => !grant.revokedAt && grant.revokingAt,
    ).length;
    const revokingAt = Math.floor(Date.now() / 1000);
    const updated = (connection.grants ?? []).map((grant) =>
      grant.revokedAt || grant.revokingAt ? grant : { ...grant, revokingAt },
    );
    await ctx.database.query(
      `UPDATE workspace_connections SET grants=$2::jsonb, updated_at=now() WHERE id=$1::uuid`,
      [connection.id, JSON.stringify(updated)],
    );
    if (live.length) {
      if (squireMachineId(connection.connector_id)) {
        await ctx.database.transaction((db) => queueOwnerSquireWork(db, viewerId,
          squireMachineId(connection.connector_id)!, `revoke-grants:${connection.reference}`));
      } else {
        await ctx.database.query(
          `UPDATE workspace_connectors
           SET pending_ops = pending_ops || $2::jsonb, updated_at=now()
           WHERE id=$1::uuid`,
          [connection.connector_id, JSON.stringify([`revoke-grants:${connection.reference}`])],
        );
        await notifyConnectorHelper(ctx.database, connection.connector_id);
      }
    }
    const pending = live.length + alreadyPending;
    return pending ? { revoked: 0, failed: 0, pending } : { revoked: 0, failed: 0 };
  }
