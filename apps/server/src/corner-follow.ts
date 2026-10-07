import { tagsKnownIdentitySql } from './message-mentions.js';
import type { SqlDatabase } from './database.js';

/**
 * A person follows a corner they started (opened it, or their message
 * commissioned it), posted in, steered from its Room, or were tagged in.
 * Push's Followed level and every "Mine" corner list read this one table.
 *
 * Triggers record each follow when it happens, so no reader scans a corner's
 * transcript. A tag is checked once, against the message that carries it. A
 * follow is a past fact: a later rename or deletion does not take it back.
 */
export function cornerFollowsSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS corner_follows (
  corner_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  PRIMARY KEY (corner_id, identity_id)
);

CREATE OR REPLACE FUNCTION corner_follows_room_created() RETURNS trigger
LANGUAGE plpgsql AS $corner_follows$
BEGIN
  IF NEW.parent_id IS NOT NULL AND NEW.created_by IS NOT NULL THEN
    INSERT INTO corner_follows(corner_id,identity_id) VALUES(NEW.id,NEW.created_by)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END
$corner_follows$;
DROP TRIGGER IF EXISTS corner_follows_room_insert ON rooms;
CREATE TRIGGER corner_follows_room_insert AFTER INSERT ON rooms
  FOR EACH ROW EXECUTE FUNCTION corner_follows_room_created();

CREATE OR REPLACE FUNCTION corner_follows_commissioned() RETURNS trigger
LANGUAGE plpgsql AS $corner_follows$
BEGIN
  IF NEW.commissioned_by IS NOT NULL THEN
    INSERT INTO corner_follows(corner_id,identity_id) VALUES(NEW.corner_id,NEW.commissioned_by)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END
$corner_follows$;
DROP TRIGGER IF EXISTS corner_follows_facts_insert ON corner_facts;
CREATE TRIGGER corner_follows_facts_insert AFTER INSERT ON corner_facts
  FOR EACH ROW EXECUTE FUNCTION corner_follows_commissioned();
DROP TRIGGER IF EXISTS corner_follows_facts_update ON corner_facts;
CREATE TRIGGER corner_follows_facts_update AFTER UPDATE OF commissioned_by ON corner_facts
  FOR EACH ROW WHEN (OLD.commissioned_by IS DISTINCT FROM NEW.commissioned_by)
  EXECUTE FUNCTION corner_follows_commissioned();

-- The author follows the corner they post in; the people the message tags
-- follow it too. Only this message is read.
CREATE OR REPLACE FUNCTION corner_follows_message() RETURNS trigger
LANGUAGE plpgsql AS $corner_follows$
BEGIN
  IF NEW.deleted_at IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM rooms WHERE id=NEW.room_id AND parent_id IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  IF TG_OP='INSERT' AND NEW.author_id IS NOT NULL THEN
    INSERT INTO corner_follows(corner_id,identity_id) VALUES(NEW.room_id,NEW.author_id)
    ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO corner_follows(corner_id,identity_id)
  SELECT NEW.room_id,person.id FROM memberships member
  JOIN identities person ON person.id=member.identity_id
  WHERE member.room_id=NEW.room_id AND member.removed_at IS NULL
    AND ${tagsKnownIdentitySql('NEW', 'person.id', 'person.handle', 'person.kind')}
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$corner_follows$;
DROP TRIGGER IF EXISTS corner_follows_message_insert ON messages;
CREATE TRIGGER corner_follows_message_insert AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION corner_follows_message();
DROP TRIGGER IF EXISTS corner_follows_message_update ON messages;
CREATE TRIGGER corner_follows_message_update AFTER UPDATE OF text ON messages
  FOR EACH ROW WHEN (OLD.text IS DISTINCT FROM NEW.text)
  EXECUTE FUNCTION corner_follows_message();

-- Steering a corner from its Room: the person whose Room message started it.
CREATE OR REPLACE FUNCTION corner_follows_steer() RETURNS trigger
LANGUAGE plpgsql AS $corner_follows$
BEGIN
  IF NEW.reason='relay_steer' THEN
    INSERT INTO corner_follows(corner_id,identity_id)
    SELECT NEW.room_id,steered_by.author_id FROM messages steered_by
    WHERE steered_by.id=NEW.root_source_message_id AND steered_by.author_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END
$corner_follows$;
DROP TRIGGER IF EXISTS corner_follows_steer_insert ON agent_commands;
CREATE TRIGGER corner_follows_steer_insert AFTER INSERT ON agent_commands
  FOR EACH ROW EXECUTE FUNCTION corner_follows_steer();
`;
}

/** Fill `corner_follows` for corners that predate its triggers. Run once. */
export async function backfillCornerFollows(database: SqlDatabase): Promise<void> {
  await database.query(`
    INSERT INTO corner_follows(corner_id,identity_id)
    SELECT corner.id,corner.created_by FROM rooms corner
    JOIN identities person ON person.id=corner.created_by
    WHERE corner.parent_id IS NOT NULL
    UNION
    SELECT fact.corner_id,fact.commissioned_by FROM corner_facts fact
    JOIN identities person ON person.id=fact.commissioned_by
    UNION
    SELECT posted.room_id,posted.author_id FROM messages posted
    JOIN rooms corner ON corner.id=posted.room_id AND corner.parent_id IS NOT NULL
    JOIN identities person ON person.id=posted.author_id
    WHERE posted.deleted_at IS NULL
    UNION
    SELECT steer.room_id,steered_by.author_id FROM agent_commands steer
    JOIN messages steered_by ON steered_by.id=steer.root_source_message_id
    JOIN identities person ON person.id=steered_by.author_id
    WHERE steer.reason='relay_steer'
      AND EXISTS (SELECT 1 FROM rooms corner WHERE corner.id=steer.room_id AND corner.parent_id IS NOT NULL)
    UNION
    SELECT tagged.room_id,person.id FROM messages tagged
    JOIN rooms corner ON corner.id=tagged.room_id AND corner.parent_id IS NOT NULL
    JOIN memberships member ON member.room_id=tagged.room_id AND member.removed_at IS NULL
    JOIN identities person ON person.id=member.identity_id
    WHERE tagged.deleted_at IS NULL
      AND ${tagsKnownIdentitySql('tagged', 'person.id', 'person.handle', 'person.kind')}
    ON CONFLICT DO NOTHING`);
}

/** Whether `identityIdExpr` follows the corner row `corner`. */
export function followsCornerSql(corner: string, identityIdExpr: string): string {
  return `EXISTS (SELECT 1 FROM corner_follows follow
    WHERE follow.corner_id=${corner}.id AND follow.identity_id=${identityIdExpr})`;
}
