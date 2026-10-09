import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

export type JsonEncoding = 'br' | 'gzip';

/** Below this a JSON body goes out as is: compressing it would not save a packet. */
export const JSON_COMPRESSION_MINIMUM_BYTES = 1024;

/**
 * The encoding to answer with, from a request's `accept-encoding`. Brotli
 * when offered (browsers, iOS), else gzip (Android's OkHttp offers only
 * gzip and inflates it transparently); nothing for a client that offers
 * neither, or refuses both with `q=0`.
 */
export function acceptedJsonEncoding(header: string | undefined): JsonEncoding | undefined {
  const offered = new Set<string>();
  for (const part of (header ?? '').split(',')) {
    const [token, ...params] = part.split(';').map((value) => value.trim().toLowerCase());
    if (token && !params.some((param) => /^q=0(\.0{0,3})?$/.test(param))) offered.add(token);
  }
  if (offered.has('br')) return 'br';
  if (offered.has('gzip')) return 'gzip';
  return undefined;
}

/** The wire bytes for one JSON response, compressed when that is worth it. */
export function encodeJsonBody(
  body: unknown,
  encoding: JsonEncoding | undefined,
): { readonly bytes: Buffer; readonly encoding?: JsonEncoding } {
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`);
  if (!encoding || bytes.length < JSON_COMPRESSION_MINIMUM_BYTES) return { bytes };
  // Quality 5 is the knee for small JSON: within a few percent of the best
  // ratio at a fraction of the time, so a Room read pays well under 1 ms.
  const compressed =
    encoding === 'br'
      ? brotliCompressSync(bytes, {
          params: {
            [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
            [constants.BROTLI_PARAM_QUALITY]: 5,
            [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
          },
        })
      : gzipSync(bytes, { level: 6 });
  return { bytes: compressed, encoding };
}
