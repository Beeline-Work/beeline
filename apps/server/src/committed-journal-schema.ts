/** Retained for the separately authenticated MCP member stream. Phones do not
 * write or resume these journal cursors. */
export const JOURNAL_RETAINED_ENTRIES = 1024;
export const JOURNAL_RETAINED_BYTES = 4 * 1024 * 1024;

/** ID-only invalidations commit with their source rows. The stream row lock
 * orders cursors by commit, rather than by sequence allocation time. */
export const COMMITTED_JOURNAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS live_streams (
  id text PRIMARY KEY, epoch text NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
  sequence bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS live_journal (
  stream_id text NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
  sequence bigint NOT NULL, event jsonb NOT NULL,
  PRIMARY KEY(stream_id,sequence)
);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name='live_streams' AND column_name='byte_total') THEN
    ALTER TABLE live_streams ADD COLUMN byte_total bigint NOT NULL DEFAULT 0;
    ALTER TABLE live_journal ADD COLUMN byte_start bigint NOT NULL DEFAULT 0;
    WITH positions AS (
      SELECT stream_id,sequence,COALESCE(sum(octet_length(event::text)) OVER
        (PARTITION BY stream_id ORDER BY sequence ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS start
      FROM live_journal)
    UPDATE live_journal j SET byte_start=p.start FROM positions p
      WHERE j.stream_id=p.stream_id AND j.sequence=p.sequence;
    UPDATE live_streams s SET byte_total=totals.bytes FROM (
      SELECT stream_id,max(byte_start+octet_length(event::text)) bytes FROM live_journal GROUP BY stream_id
    ) totals WHERE s.id=totals.stream_id;
    DELETE FROM live_journal j USING live_streams s WHERE j.stream_id=s.id AND j.byte_start<s.byte_total-${JOURNAL_RETAINED_BYTES};
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS live_journal_byte_start_idx ON live_journal(stream_id,byte_start);
-- SPI may cache a tiny-table generic plan for an entire bulk source write.
-- This function owns indexed stream/retention keys; keep that plan bounded
-- from its first call without changing the caller's planner settings.
CREATE OR REPLACE FUNCTION beeline_journal(stream text, body jsonb) RETURNS void
SET enable_seqscan=off AS $$
DECLARE position bigint; total bigint; bytes integer := octet_length(body::text);
BEGIN
  INSERT INTO live_streams(id,sequence,byte_total) VALUES(stream,1,bytes)
    ON CONFLICT(id) DO UPDATE SET sequence=live_streams.sequence+1,byte_total=live_streams.byte_total+bytes
    RETURNING sequence,byte_total INTO position,total;
  INSERT INTO live_journal(stream_id,sequence,event,byte_start) VALUES(stream,position,body,total-bytes);
  -- Match the one count victim by PRIMARY KEY. Prefix <= scans revisit
  -- dead index entries until a bulk source transaction can commit/vacuum.
  -- Byte victims are bounded below by that count victim, or by the previous
  -- byte threshold when count history was already pruned. Each expired byte
  -- range is therefore visited once, including short/gapped histories.
  WITH count_victim AS MATERIALIZED (
    SELECT ctid,byte_start FROM live_journal
    WHERE stream_id=stream AND sequence=position-${JOURNAL_RETAINED_ENTRIES}
  )
  DELETE FROM live_journal WHERE ctid=ANY(ARRAY(
    SELECT ctid FROM count_victim
    UNION
    SELECT ctid FROM live_journal WHERE stream_id=stream
      AND byte_start>=COALESCE((SELECT byte_start FROM count_victim),total-bytes-${JOURNAL_RETAINED_BYTES})
      AND byte_start<total-${JOURNAL_RETAINED_BYTES}
  ));
END;
$$ LANGUAGE plpgsql;
`;
