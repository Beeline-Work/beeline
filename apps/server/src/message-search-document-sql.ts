


/**
 * `to_tsvector` output runs roughly 3x its input for distinct short tokens, and
 * Postgres refuses a tsvector over 1,048,575 bytes, so an unbounded call fails
 * the write itself. Nothing reads a vector for a non-`message` row either: the
 * GIN index and the only query are both scoped to conversational rows.
 */
export const MESSAGE_SEARCH_DOCUMENT_MAX_BYTES = 256 * 1024;



export function messageSearchDocumentSql(
  prefix: string,
  configuration: 'simple' | 'english' = 'simple',
): string {
  const vector = `to_tsvector('${configuration}',coalesce(${prefix}text,''))`;
  // Coverage ranking needs one occurrence per stem, not word positions.
  const document = configuration === 'english' ? `strip(${vector})` : vector;
  return `CASE
    WHEN ${prefix}presentation='message'
      AND octet_length(convert_to(coalesce(${prefix}text,''),'UTF8'))
          <=${MESSAGE_SEARCH_DOCUMENT_MAX_BYTES}
    THEN ${document}
    ELSE ''::tsvector
  END`;
}
