/** Counter rows reserve numbers permanently; changing a display name or roster
 * never changes an identity's address. Existing addresses only seed counters.
 */
export const IDENTITY_HANDLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS identity_handle_counters (
  name text PRIMARY KEY,
  n numeric NOT NULL
);
WITH existing AS (
  SELECT lower(handle) handle FROM identities WHERE handle IS NOT NULL
), numbered AS (
  SELECT handle name,1::numeric n FROM existing
  UNION ALL
  SELECT regexp_replace(handle,'_?[0-9]+$','') name,
    substring(handle from '([0-9]+)$')::numeric n FROM existing WHERE handle ~ '[0-9]+$'
)
INSERT INTO identity_handle_counters(name,n)
SELECT name,max(n) FROM numbered WHERE name<>'' GROUP BY name
ON CONFLICT(name) DO UPDATE SET n=greatest(identity_handle_counters.n,excluded.n);

INSERT INTO identity_handle_counters(name,n)
VALUES('channel',1),('system',1),('play-review',1),('review',1),('scheduler',1)
ON CONFLICT(name) DO UPDATE SET n=greatest(identity_handle_counters.n,excluded.n);

CREATE OR REPLACE FUNCTION beeline_next_handle_number(base_name text)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT n FROM identity_handle_counters WHERE name=base_name),0)+1;
$$;

CREATE OR REPLACE FUNCTION beeline_identity_handle(who text,base text,explicit_choice boolean DEFAULT false)
RETURNS text LANGUAGE sql VOLATILE AS $$
  WITH known AS MATERIALIZED (
    SELECT handle FROM identities WHERE id=who AND (NOT explicit_choice OR lower(handle)=lower(base))
  ), naming AS MATERIALIZED (
    SELECT CASE WHEN explicit_choice THEN regexp_replace(lower(base),'_[0-9]+$','')
      ELSE regexp_replace(trim(both '_' from lower(base)),'(_[0-9]+)+$','') END name,
      CASE WHEN explicit_choice AND base ~ '_[0-9]+$' THEN substring(base from '([0-9]+)$')::numeric ELSE 1 END n
  ), reserved AS (
    INSERT INTO identity_handle_counters AS counter(name,n)
    SELECT name,CASE WHEN explicit_choice THEN n ELSE beeline_next_handle_number(name) END
    FROM naming WHERE NOT EXISTS(SELECT 1 FROM known)
      AND (NOT explicit_choice OR NOT EXISTS(SELECT 1 FROM identities WHERE id<>who AND lower(handle)=lower(base)))
    ON CONFLICT(name) DO UPDATE SET n=CASE WHEN explicit_choice THEN excluded.n ELSE counter.n+1 END
      WHERE NOT explicit_choice OR counter.n<excluded.n
    RETURNING CASE WHEN explicit_choice THEN lower(base) WHEN n=1 THEN name ELSE name||'_'||n::text END handle
  ) SELECT handle FROM known UNION ALL SELECT handle FROM reserved LIMIT 1;
$$;
`;
