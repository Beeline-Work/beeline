/** The account stores complete reads; a cached older read keeps the shown numbers. */
export const USAGE_ACCOUNT_READ_SCHEMA = `
CREATE OR REPLACE FUNCTION beeline_account_read(previous jsonb,incoming jsonb,received_at double precision)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  WITH normalized AS (
    SELECT COALESCE((SELECT jsonb_agg(value||jsonb_build_object('updatedAt',
      least((value->>'updatedAt')::double precision,received_at)) ORDER BY ordinal)
      FROM jsonb_array_elements(incoming->'windows') WITH ORDINALITY item(value,ordinal)),'[]'::jsonb) windows,
      least((incoming->>'updatedAt')::double precision,received_at) stamp
  ), verdict AS (
    SELECT normalized.*,incoming->'read'->>'status'='fresh' OR
      COALESCE((SELECT min((value->>'updatedAt')::double precision) FROM jsonb_array_elements(normalized.windows)),
        CASE WHEN incoming ? 'credits' THEN stamp END)>=
      COALESCE((SELECT min((value->>'updatedAt')::double precision) FROM jsonb_array_elements(previous->'windows')),
        CASE WHEN previous ? 'credits' THEN (previous->>'updatedAt')::double precision END,'-Infinity'::double precision) replace
    FROM normalized
  ), kept AS (
    SELECT CASE WHEN replace THEN windows ELSE COALESCE(previous->'windows','[]'::jsonb) END windows,
      CASE WHEN replace THEN incoming->'plan' ELSE previous->'plan' END plan,
      CASE WHEN replace THEN incoming->'credits' ELSE previous->'credits' END credits,
      CASE WHEN replace THEN stamp ELSE COALESCE((previous->>'updatedAt')::double precision,received_at) END stamp,
      COALESCE(CASE WHEN incoming ? 'read' THEN incoming->'read'||jsonb_build_object('at',
        least((incoming->'read'->>'at')::double precision,received_at)) END,previous->'read') read
    FROM verdict
  ) SELECT jsonb_strip_nulls(jsonb_build_object('updatedAt',
      COALESCE((SELECT min((value->>'updatedAt')::double precision) FROM jsonb_array_elements(windows)),stamp),
    'windows',windows,'plan',plan,'credits',credits,'read',read)) FROM kept;
$$;
`;
