import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CONNECTABLE_CONNECTOR_KINDS,
  CONNECTOR_KINDS,
  isConnectorKind,
  type ConnectorAssignment,
  type ConnectorKind,
  type ConnectorStatus,
  type ConnectorStep,
  type ConnectionUsageRecord,
  type PostConnectionUsageInput,
  type VaultConnectionMeta,
  type WorkbenchCatalogEntry,
} from '@beeline/api-contract/workbench';
import type { ConnectionGrant } from '@beeline/api-contract/daemon';
import { SQUIRE_MCP_TARGET } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { notifyAgentConfigChange } from './postgres-live.js';
import {
  directMessageRoomId,
  restateSystemLine,
  systemLine,
  type SystemPhrase,
} from './system-line.js';

/**
 * The server authority for Workbench connector provisioning.
 *
 * A connection belongs to the HUMAN who provisioned it; every read and write
 * re-checks `owner_identity_id` against the viewer. Receipts the helper
 * reports land as DMs from a hidden CONNECTOR IDENTITY — one per connector
 * type, provisioned exactly the way `@system` is (apps/server/src/system-line.ts):
 * an ordinary `kind='human'` row with a fixed id and `hidden_from_roster=true`,
 * holding one read-only DM per provisioning person.
 */

export const CONNECTOR_METADATA_TTL_MS = 5 * 60_000;

export type ConnectorCatalogEntry = WorkbenchCatalogEntry;

const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  { connectorType: 'trusty-squire', name: 'Trusty Squire', available: true },
  { connectorType: 'wallet', name: 'Wallet', available: true },
  { connectorType: 'tailscale', name: 'Tailscale', available: true },
  { connectorType: 'google-gmail', name: 'Gmail', available: true },
  { connectorType: 'google-calendar', name: 'Google Calendar', available: true },
  { connectorType: 'google-drive', name: 'Google Drive', available: true },
  { connectorType: 'google-youtube', name: 'YouTube', available: true },
];

export function connectorCatalog(): readonly ConnectorCatalogEntry[] {
  return CONNECTOR_CATALOG;
}

export function connectorDisplayName(type: ConnectorKind): string {
  return CONNECTOR_CATALOG.find((entry) => entry.connectorType === type)?.name ?? type;
}

export function isConnectableConnector(type: ConnectorKind): boolean {
  return CONNECTABLE_CONNECTOR_KINDS.includes(type);
}

const logoCache = new Map<string, string>();

/** The connector's avatar/logo, served publicly at /v1/connectors/logo/<type>.svg. */
export function connectorLogo(type: string): string | undefined {
  if (!isConnectorKind(type)) return undefined;
  const cached = logoCache.get(type);
  if (cached) return cached;
  try {
    const svg = readFileSync(
      fileURLToPath(new URL(`../assets/connectors/${type}.svg`, import.meta.url)),
      'utf8',
    );
    logoCache.set(type, svg);
    return svg;
  } catch {
    return undefined;
  }
}

/** The deterministic hidden identity that speaks FOR one connector type. */
export function connectorIdentityId(type: ConnectorKind): string {
  return createHash('sha256').update(`beeline:connector-identity:${type}`).digest('hex');
}

const CONNECTOR_TYPES_BY_ID = new Map(
  CONNECTOR_KINDS.map((type) => [connectorIdentityId(type), type]),
);

/** Every fixed connector speaker id, for read surfaces that distinguish its ledger DM. */
export function connectorIdentityIds(): readonly string[] {
  return [...CONNECTOR_TYPES_BY_ID.keys()];
}

/**
 * True when any direct participant of this DM is a connector identity. Those
 * DMs are receipt ledgers, not conversations: only the connector identity
 * itself may post there.
 */
export function dmParticipantsIncludeConnectorIdentity(
  participants: readonly string[] | null,
): boolean {
  return Boolean(participants?.some((participant) => CONNECTOR_TYPES_BY_ID.has(participant)));
}

export async function ensureConnectorIdentity(
  database: SqlDatabase,
  type: ConnectorKind,
): Promise<string> {
  const id = connectorIdentityId(type);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle,hidden_from_roster,avatar)
     VALUES ($1,'human',$2,$3,true,$4) ON CONFLICT(id) DO UPDATE
     SET name=EXCLUDED.name,handle=EXCLUDED.handle,
         hidden_from_roster=true,avatar=EXCLUDED.avatar,updated_at=now()`,
    [id, connectorDisplayName(type), type, `/v1/connectors/logo/${type}.svg`],
  );
  return id;
}

/** The deterministic read-only DM between one connector identity and one human. */
export async function ensureConnectorDirectMessageRoom(
  database: SqlDatabase,
  workspaceId: string,
  type: ConnectorKind,
  personId: string,
): Promise<string> {
  const connectorId = await ensureConnectorIdentity(database, type);
  const participants = [connectorId, personId].sort() as [string, string];
  const roomId = directMessageRoomId(workspaceId, participants);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,visibility,direct_participants)
     VALUES ($1,$2,$3,'Direct message','invite-only',$4::jsonb)
     ON CONFLICT(id) DO UPDATE SET visibility='invite-only'`,
    [roomId, workspaceId, connectorId, JSON.stringify(participants)],
  );
  for (const memberId of participants)
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES ($1,$2,$3,'member')
       ON CONFLICT (room_id,identity_id) WHERE room_id IS NOT NULL
       DO UPDATE SET removed_at=NULL`,
      [workspaceId, roomId, memberId],
    );
  return roomId;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One batched helper usage report (one per agent turn): a ledger row per
 * record ALWAYS, and one receipt card DM per connection from the connector
 * identity to the connection's human - but only for records the helper
 * classed as needing the human (`eventClass`: an approval request or a vault
 * change made on the owner's behalf; captain ruling 2026-09-15). Ordinary
 * use stays on the key's own Workbench record and never arrives as a DM.
 * The turn's request id is the batch key, so a turn that used a connection
 * five times reads as one line.
 *
 * Sovereignty boundary: the receipt goes to the connection's owner only, and
 * only while that person remains a current member of the Workspace.
 */
export async function receiveConnectionUsage(
  database: SqlDatabase,
  input: PostConnectionUsageInput,
  helperAgentId: string,
): Promise<{ connectionId: string; messageId: string | null }[]> {
  // One report may touch several connections; resolve each ref against the
  // connectors this helper serves (the authenticated daemon agent is the
  // helper — the reported agentId is only the turn's speaker).
  const results: { connectionId: string; messageId: string | null }[] = [];
  const byRef = new Map<string, { connection: ConnectionRow; connector: ConnectorRow }>();
  for (const record of input.usage) {
    const resolved = await resolveUsageConnection(database, helperAgentId, record, input);
    if (!resolved) continue;
    const { connection, connector } = resolved;
    byRef.set(connection.reference, { connection, connector });
    const agentId = input.agentId;
    await database.query(
      `INSERT INTO connection_receipts(
         id,connection_id,workspace_id,owner_identity_id,agent_id,
         operation,status_code,bytes,grant_info,turn_key,event_class
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        randomUUID(),
        connection.id,
        connector.workspace_id,
        connection.owner_identity_id,
        agentId,
        record.operation,
        record.statusCode ?? null,
        Math.max(0, Math.round(record.bytes ?? 0)),
        record.grantId ?? null,
        input.requestId,
        record.eventClass ?? null,
      ],
    );
  }
  for (const [reference, { connection, connector }] of byRef) {
    const records = input.usage.filter((record) => record.ref === reference);
    // Only events the human must see become a receipt DM; the ledger rows
    // above already carry the full record of the turn.
    const receiptRecords = records.filter((record) => record.eventClass !== undefined);
    const messageId = receiptRecords.length
      ? await postUsageReceiptCard(database, input, connection, connector, receiptRecords)
      : null;
    results.push({ connectionId: connection.id, messageId });
  }
  return results;
}

type ConnectorRow = {
  id: string;
  workspace_id: string;
  owner_identity_id: string;
  connector_type: ConnectorKind;
};
type ConnectionRow = {
  id: string;
  reference: string;
  label: string | null;
  service: string | null;
  owner_identity_id: string;
};

async function resolveUsageConnection(
  database: SqlDatabase,
  helperAgentId: string,
  record: ConnectionUsageRecord,
  input: PostConnectionUsageInput,
): Promise<{ connection: ConnectionRow; connector: ConnectorRow } | undefined> {
  const candidates = (
    await database.query<ConnectionRow & { connector: ConnectorRow }>(
      `SELECT c.id,c.reference,c.label,c.service,c.owner_identity_id,
              to_jsonb(w) connector
       FROM workspace_connections c
       JOIN workspace_connectors w ON w.id=c.connector_id
       WHERE w.helper_agent_id=$1 AND c.reference=$2
       ORDER BY w.created_at`,
      [helperAgentId, record.ref],
    )
  ).rows;
  let picked = candidates[0];
  if (candidates.length > 1 && (input.roomId || input.cornerId)) {
    const scope = (
      await database.query<{ workspace_id: string }>(`SELECT workspace_id FROM rooms WHERE id=$1`, [
        input.cornerId ?? input.roomId,
      ])
    ).rows[0];
    if (scope)
      picked = candidates.find(
        (candidate) => candidate.connector.workspace_id === scope.workspace_id,
      );
  }
  return picked ? { connection: picked, connector: picked.connector } : undefined;
}

async function postUsageReceiptCard(
  database: SqlDatabase,
  input: PostConnectionUsageInput,
  connection: ConnectionRow,
  connector: ConnectorRow,
  records: readonly ConnectionUsageRecord[],
): Promise<string | null> {
  const agentId = input.agentId;
  // Receipts reach a person only while they remain a current Workspace member.
  const membership = await database.query(
    `SELECT 1 FROM memberships
     WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL`,
    [connector.workspace_id, connection.owner_identity_id],
  );
  if (!membership.rowCount) return null;

  const agent = (
    await database.query<{ name: string; handle: string | null }>(
      `SELECT name,handle FROM identities WHERE id=$1`,
      [agentId],
    )
  ).rows[0];
  const connectionName = connection.label ?? connection.service ?? connection.reference;
  const totalBytes = records.reduce((sum, record) => sum + Math.max(0, record.bytes ?? 0), 0);
  const consequence =
    records.length > 1
      ? `${records.length} calls · ${formatBytes(totalBytes)}`
      : [
          records[0]!.operation,
          records[0]!.statusCode !== undefined ? String(records[0]!.statusCode) : undefined,
          records[0]!.bytes ? formatBytes(records[0]!.bytes) : undefined,
          (records[0]!.grantLabel ?? records[0]!.grantId)
            ? `grant ${records[0]!.grantLabel ?? records[0]!.grantId}`
            : undefined,
        ]
          .filter(Boolean)
          .join(' · ');

  const phrase: SystemPhrase = {
    subject: { id: agentId, kind: 'agent', name: agent?.name ?? 'agent' },
    verb: 'used',
    object: { id: undefined, text: connectionName },
    consequence,
  };
  const messageId = createHash('sha256')
    .update(`connection-receipt:${connection.id}:${agentId}:${input.requestId}`)
    .digest('hex');
  const card = receiptCard(connector, connection, agent);

  // One card per agent turn: restate the existing card in place, aggregating
  // every receipt-worthy ledger row this turn has already written.
  const existing = (
    await database.query<{ message_id: string }>(
      `SELECT message_id FROM connection_receipts
       WHERE connection_id=$1 AND turn_key=$2 AND message_id IS NOT NULL
         AND event_class IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [connection.id, input.requestId],
    )
  ).rows[0];
  if (existing) {
    const totals = (
      await database.query<{ calls: string; total_bytes: string }>(
        `SELECT count(*)::text calls, COALESCE(SUM(bytes),0)::text total_bytes
         FROM connection_receipts
         WHERE connection_id=$1 AND turn_key=$2 AND event_class IS NOT NULL`,
        [connection.id, input.requestId],
      )
    ).rows[0]!;
    await restateSystemLine(
      database,
      existing.message_id,
      {
        ...phrase,
        consequence: `${totals.calls} calls · ${formatBytes(Number(totals.total_bytes))}`,
      },
      card,
    );
    return existing.message_id;
  }

  const roomId = await ensureConnectorDirectMessageRoom(
    database,
    connector.workspace_id,
    connector.connector_type,
    connection.owner_identity_id,
  );
  const line = await systemLine(database, {
    roomId,
    authorId: connectorIdentityId(connector.connector_type),
    id: messageId,
    ...phrase,
    presentation: 'card',
    cardType: 'connection-receipt',
    card,
  });
  await database.query(
    `UPDATE connection_receipts SET message_id=$3
     WHERE connection_id=$1 AND turn_key=$2`,
    [connection.id, input.requestId, line.id],
  );
  return line.id;
}

function receiptCard(
  connector: { workspace_id: string; connector_type: ConnectorKind },
  connection: { id: string; label: string | null; service: string | null },
  agent: { name: string; handle: string | null } | undefined,
): Record<string, unknown> {
  return {
    connectionId: connection.id,
    connectionName: connection.label ?? connection.service,
    connectorType: connector.connector_type,
    agentId: agent?.handle ? `@${agent.handle}` : agent?.name,
    ledgerWorkspaceId: connector.workspace_id,
  };
}

export function isMetadataStale(lastSyncedAt: Date | null): boolean {
  return !lastSyncedAt || Date.now() - lastSyncedAt.getTime() > CONNECTOR_METADATA_TTL_MS;
}

/** Upserts one helper vault report into the sovereign connection rows. */
export async function applyVaultList(
  database: SqlDatabase,
  connector: { id: string; owner_identity_id: string },
  connections: readonly VaultConnectionMeta[],
): Promise<void> {
  const seen = new Set<string>();
  for (const entry of connections) {
    seen.add(entry.reference);
    await database.query(
      `INSERT INTO workspace_connections(
         id,connector_id,owner_identity_id,reference,service,label,hosts,state,
         connection_metadata,last_synced_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,now())
       ON CONFLICT (connector_id,reference) DO UPDATE SET
         service=EXCLUDED.service,
         label=EXCLUDED.label,
         hosts=EXCLUDED.hosts,
         state=EXCLUDED.state,
         connection_metadata=EXCLUDED.connection_metadata,
         last_synced_at=now(),
         updated_at=now()`,
      [
        randomUUID(),
        connector.id,
        connector.owner_identity_id,
        entry.reference,
        entry.service,
        entry.label,
        JSON.stringify(entry.allowedHosts ?? []),
        entry.state,
        JSON.stringify({ fieldNames: entry.fieldNames, vaultCreatedAt: entry.createdAt }),
      ],
    );
  }
  // A reference the vault no longer holds is gone; its ledger history goes
  // with it (the vault is the record of what exists, not what existed).
  const existing = await database.query<{ id: string; reference: string }>(
    `SELECT id,reference FROM workspace_connections WHERE connector_id=$1`,
    [connector.id],
  );
  for (const row of existing.rows) {
    if (!seen.has(row.reference))
      await database.query(`DELETE FROM workspace_connections WHERE id=$1`, [row.id]);
  }
  await database.query(`UPDATE workspace_connectors SET updated_at=now() WHERE id=$1`, [
    connector.id,
  ]);
}

/** The default steps a freshly paired connector shows while installing. */
export function defaultConnectorSteps(): readonly ConnectorStep[] {
  return [
    { label: 'Install on helper', status: 'pending' },
    { label: 'Connect provider account', status: 'pending' },
  ];
}

const SQUIRE_MACHINE_GRANT_REASON = 'Trusty Squire connected on this machine';

/**
 * Standing owner-approved mcp/squire grants for every agent this person owns
 * on this machine, recorded in the grant ledger. Idle sessions restart through
 * the existing agent-config wake so the next turn mounts the route.
 */
export async function grantSquireToOwnerMachineAgents(
  database: SqlDatabase,
  input: {
    workspaceId: string;
    ownerIdentityId: string;
    machineId: string;
    agentId?: string;
  },
): Promise<string[]> {
  const dmRoomId = await ensureConnectorDirectMessageRoom(
    database,
    input.workspaceId,
    'trusty-squire',
    input.ownerIdentityId,
  );
  const agents = await database.query<{ agent_id: string }>(
    input.agentId
      ? `SELECT a.agent_id FROM agents a
         JOIN memberships m ON m.identity_id=a.agent_id AND m.workspace_id=$1
           AND m.room_id IS NULL AND m.removed_at IS NULL
         WHERE a.agent_id=$4 AND a.owner_id=$2
           AND COALESCE(a.machine_id, a.agent_id)=$3`
      : `SELECT a.agent_id FROM agents a
         JOIN memberships m ON m.identity_id=a.agent_id AND m.workspace_id=$1
           AND m.room_id IS NULL AND m.removed_at IS NULL
         WHERE a.owner_id=$2 AND COALESCE(a.machine_id, a.agent_id)=$3`,
    input.agentId
      ? [input.workspaceId, input.ownerIdentityId, input.machineId, input.agentId]
      : [input.workspaceId, input.ownerIdentityId, input.machineId],
  );
  const granted: string[] = [];
  for (const agent of agents.rows) {
    const inserted = await database.query<{ id: string }>(
      `INSERT INTO agent_grants(
         id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,
         decided_by,decided_at,auto
       )
       SELECT $1,$2,$3,'mcp',$4,$5,$6,$7,'approved',$6,now(),false
       WHERE NOT EXISTS (
         SELECT 1 FROM agent_grants
         WHERE agent_id=$2 AND workspace_id=$3 AND kind='mcp' AND target=$4
           AND requested_by=$6 AND status IN ('approved','once')
           AND (expires_at IS NULL OR expires_at>now())
       )
       RETURNING id`,
      [
        randomUUID(),
        agent.agent_id,
        input.workspaceId,
        SQUIRE_MCP_TARGET,
        SQUIRE_MACHINE_GRANT_REASON,
        input.ownerIdentityId,
        dmRoomId,
      ],
    );
    if (inserted.rowCount) {
      granted.push(agent.agent_id);
      await notifyAgentConfigChange(database, agent.agent_id, input.workspaceId);
    }
  }
  return granted;
}

