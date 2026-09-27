import type { SqlDatabase } from './database.js';
import type { AgentDiscoveryChanges, AgentDiscoverySnapshot } from '@beeline/api-contract/daemon';

// A single transactional version row orders commits, not sequence allocation.
// Without it, a slow transaction could commit a lower sequence after a helper
// has already advanced past it and its Room would never be discovered.
export const AGENT_DISCOVERY_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_discovery_clock (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  version bigint NOT NULL DEFAULT 0
);
INSERT INTO agent_discovery_clock(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS agent_discovery_changes (
  version bigint PRIMARY KEY,
  identity_id text,
  room_id uuid,
  workspace_id uuid,
  installation_id bigint,
  repository_id bigint,
  removed boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS agent_discovery_changes_identity_idx
  ON agent_discovery_changes(identity_id,version) WHERE identity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_discovery_changes_room_idx
  ON agent_discovery_changes(room_id,version) WHERE room_id IS NOT NULL;
CREATE OR REPLACE FUNCTION beeline_record_agent_discovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_version bigint;
DECLARE changed_room uuid;
DECLARE changed_workspace uuid;
DECLARE changed_identity text;
DECLARE is_removed boolean;
BEGIN
  IF TG_TABLE_NAME='github_installations' THEN
    UPDATE agent_discovery_clock SET version=version+1 WHERE singleton=true
      RETURNING version INTO next_version;
    IF TG_OP='DELETE' THEN
      INSERT INTO agent_discovery_changes(version,installation_id) VALUES(next_version,OLD.installation_id);
      RETURN OLD;
    END IF;
    INSERT INTO agent_discovery_changes(version,installation_id) VALUES(next_version,NEW.installation_id);
    RETURN NEW;
  ELSIF TG_TABLE_NAME='github_repositories' THEN
    UPDATE agent_discovery_clock SET version=version+1 WHERE singleton=true
      RETURNING version INTO next_version;
    IF TG_OP='DELETE' THEN
      INSERT INTO agent_discovery_changes(version,repository_id) VALUES(next_version,OLD.repository_id);
      RETURN OLD;
    END IF;
    INSERT INTO agent_discovery_changes(version,repository_id) VALUES(next_version,NEW.repository_id);
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='memberships' THEN
    IF TG_OP='UPDATE' AND NEW.removed_at IS NOT DISTINCT FROM OLD.removed_at
      AND NEW.room_id IS NOT DISTINCT FROM OLD.room_id
      AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id THEN
      RETURN NEW;
    END IF;
    changed_room := CASE WHEN TG_OP='DELETE' THEN OLD.room_id ELSE NEW.room_id END;
    changed_workspace := CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
    changed_identity := CASE WHEN TG_OP='DELETE' THEN OLD.identity_id ELSE NEW.identity_id END;
    is_removed := TG_OP='DELETE' OR (TG_OP<>'DELETE' AND NEW.removed_at IS NOT NULL);
  ELSE
    IF TG_OP='UPDATE' AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at
      AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id
      AND NEW.repository_key IS NOT DISTINCT FROM OLD.repository_key
      AND NEW.repository_remote IS NOT DISTINCT FROM OLD.repository_remote
      AND NEW.repository_target_branch IS NOT DISTINCT FROM OLD.repository_target_branch
      AND NEW.repository_resolution IS NOT DISTINCT FROM OLD.repository_resolution
      AND NEW.repository_updated_at IS NOT DISTINCT FROM OLD.repository_updated_at
      AND NEW.github_installation_id IS NOT DISTINCT FROM OLD.github_installation_id THEN
      RETURN NEW;
    END IF;
    changed_room := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
    changed_workspace := CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
    changed_identity := NULL;
    is_removed := TG_OP='DELETE';
  END IF;
  UPDATE agent_discovery_clock SET version=version+1 WHERE singleton=true
    RETURNING version INTO next_version;
  INSERT INTO agent_discovery_changes(version,identity_id,room_id,workspace_id,removed)
    VALUES(next_version,changed_identity,changed_room,changed_workspace,is_removed);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='beeline_discovery_memberships' AND NOT tgisinternal) THEN
    CREATE TRIGGER beeline_discovery_memberships AFTER INSERT OR UPDATE OR DELETE ON memberships
      FOR EACH ROW EXECUTE FUNCTION beeline_record_agent_discovery();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='beeline_discovery_rooms' AND NOT tgisinternal) THEN
    CREATE TRIGGER beeline_discovery_rooms AFTER INSERT OR UPDATE OR DELETE ON rooms
      FOR EACH ROW EXECUTE FUNCTION beeline_record_agent_discovery();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='beeline_discovery_installations' AND NOT tgisinternal) THEN
    CREATE TRIGGER beeline_discovery_installations AFTER INSERT OR UPDATE OR DELETE ON github_installations
      FOR EACH ROW EXECUTE FUNCTION beeline_record_agent_discovery();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='beeline_discovery_repositories' AND NOT tgisinternal) THEN
    CREATE TRIGGER beeline_discovery_repositories AFTER INSERT OR UPDATE OR DELETE ON github_repositories
      FOR EACH ROW EXECUTE FUNCTION beeline_record_agent_discovery();
  END IF;
END $$;
`;

const ROOM_DESCRIPTOR_SQL = `
  SELECT room.id room_id,room.parent_id parent_room_id,
    COALESCE(fact.owner_agent_id,room.created_by) opened_by,
    room.archived_at IS NOT NULL archived,
    concat_ws(':',room.repository_resolution,COALESCE(room.repository_key,''),
      COALESCE(room.repository_remote,''),room.repository_target_branch,
      COALESCE(room.repository_updated_at::text,''),COALESCE(installation.status,''),
      COALESCE(installation.updated_at::text,''),COALESCE(repository.active::text,''),
      COALESCE(repository.updated_at::text,'')) repository_revision
  FROM memberships member
  JOIN rooms room ON room.id=member.room_id
  LEFT JOIN rooms parent ON parent.id=room.parent_id
  LEFT JOIN corner_facts fact ON fact.corner_id=room.id
  LEFT JOIN github_installations installation ON installation.installation_id=room.github_installation_id
  LEFT JOIN github_repositories repository ON room.repository_key='github:' || repository.repository_id::text
  WHERE member.identity_id=$1 AND member.removed_at IS NULL
    AND room.archived_at IS NULL
    AND (room.parent_id IS NULL OR parent.archived_at IS NULL)`;

type RoomRow = {
  room_id: string;
  parent_room_id: string | null;
  opened_by: string | null;
  archived: boolean;
  repository_revision: string;
};

function descriptor(row: RoomRow) {
  return {
    roomId: row.room_id,
    ...(row.parent_room_id ? { parentRoomId: row.parent_room_id } : {}),
    ...(row.parent_room_id && row.opened_by ? { openedBy: row.opened_by } : {}),
    archived: row.archived,
    ...(row.parent_room_id ? {} : { repositoryRevision: row.repository_revision }),
  };
}

export async function agentDiscoveryCursor(database: SqlDatabase): Promise<string> {
  const result = await database.query<{ version: string }>(
    `SELECT version::text FROM agent_discovery_clock WHERE singleton=true`,
  );
  return result.rows[0]?.version ?? '0';
}

export async function agentDiscoverySnapshot(
  database: SqlDatabase,
  agentId: string,
): Promise<AgentDiscoverySnapshot> {
  return database.transaction(async (transaction) => {
    await transaction.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const cursor = await agentDiscoveryCursor(transaction);
    const workspaces = await transaction.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM memberships
       WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL ORDER BY workspace_id`,
      [agentId],
    );
    const rooms = await transaction.query<RoomRow>(`${ROOM_DESCRIPTOR_SQL} ORDER BY room.id`, [agentId]);
    return {
      cursor,
      workspaceIds: workspaces.rows.map((row) => row.workspace_id),
      rooms: rooms.rows.map(descriptor),
    };
  });
}

export async function agentDiscoveryChanges(
  database: SqlDatabase,
  agentId: string,
  after: string,
): Promise<AgentDiscoveryChanges> {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(after) || BigInt(after) > 9223372036854775807n)
    throw new Error('invalid discovery cursor');
  return database.transaction(async (transaction) => {
    await transaction.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const fence = await agentDiscoveryCursor(transaction);
    if (BigInt(after) > BigInt(fence))
      return { cursor: fence, changes: [], hasMore: false, resetRequired: true };
    const result = await transaction.query<RoomRow & {
      version: string;
      workspace_id: string | null;
      removed: boolean;
      changed_room_id: string | null;
      installation_id: string | null;
      repository_id: string | null;
    }>(
      `SELECT change.version::text,change.workspace_id,change.removed,
         change.installation_id,change.repository_id,
         room.id room_id,room.parent_id parent_room_id,
         COALESCE(fact.owner_agent_id,room.created_by) opened_by,
         COALESCE(room.archived_at IS NOT NULL,false) archived,
         concat_ws(':',room.repository_resolution,COALESCE(room.repository_key,''),
           COALESCE(room.repository_remote,''),room.repository_target_branch,
           COALESCE(room.repository_updated_at::text,''),COALESCE(installation.status,''),
           COALESCE(installation.updated_at::text,''),COALESCE(repository.active::text,''),
           COALESCE(repository.updated_at::text,'')) repository_revision,
         change.room_id changed_room_id
       FROM agent_discovery_changes change
       LEFT JOIN rooms room ON room.id=change.room_id
       LEFT JOIN corner_facts fact ON fact.corner_id=room.id
       LEFT JOIN github_installations installation ON installation.installation_id=room.github_installation_id
       LEFT JOIN github_repositories repository ON room.repository_key='github:' || repository.repository_id::text
       WHERE change.version>$2::bigint AND change.version<=$3::bigint
         AND (change.identity_id=$1 OR (change.identity_id IS NULL AND change.room_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM memberships member WHERE member.room_id=change.room_id
             AND member.identity_id=$1 AND member.removed_at IS NULL))
           OR (change.installation_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM memberships member JOIN rooms target ON target.id=member.room_id
             WHERE member.identity_id=$1 AND member.removed_at IS NULL
               AND target.github_installation_id=change.installation_id))
           OR (change.repository_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM memberships member JOIN rooms target ON target.id=member.room_id
             WHERE member.identity_id=$1 AND member.removed_at IS NULL
               AND target.repository_key='github:' || change.repository_id::text)))
       ORDER BY change.version LIMIT 101`,
      [agentId, after, fence],
    );
    const page = result.rows.slice(0, 100);
    return {
      cursor: result.rows.length > 100 ? page[page.length - 1]!.version : fence,
      changes: page.filter((row) => !row.installation_id && !row.repository_id).map((row) => ({
        ...(row.room_id ? descriptor(row) : {}),
        ...(!row.room_id && row.changed_room_id ? { roomId: row.changed_room_id } : {}),
        ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
        removed: row.removed,
      })),
      hasMore: result.rows.length > 100,
      ...(page.some((row) => row.installation_id || row.repository_id)
        ? { resetRequired: true } : {}),
    };
  });
}
