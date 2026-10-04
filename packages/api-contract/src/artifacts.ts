/**
 * Objects on S3-compatible storage (Fly Tigris in production) — the contract
 * shared by the server, the helper (`apps/body`) and the phone client.
 *
 * Two upload shapes live behind the same `objects` table: small artifacts
 * (≤ `ARTIFACT_MAXIMUM_BYTES`) stream through the server as one pass-through
 * request and land as `ready`, while large media mints a presigned POST policy
 * with an exact `content-length-range` and is confirmed by an explicit
 * finalize. Stored references stay `/v1/media/<id>` either way; only the read
 * path differs (a 302 to a short-lived signed GET).
 */

/** The artifact formats `post_artifact` accepts; the mime selects the
 *  validator and the viewer. HTML and SVG are self-contained-document
 *  validated; PDF is signature-checked; the rest are size-only. */
export const ARTIFACT_MIME_TYPES = [
  'text/html',
  'image/svg+xml',
  'application/pdf',
  'text/markdown',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'application/json',
  'text/csv',
  'application/zip',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/mp4',
  'application/octet-stream',
] as const;

export type ArtifactMimeType = (typeof ARTIFACT_MIME_TYPES)[number];

/**
 * Extensions for which `post_artifact({ path })` can infer a specific MIME.
 * An extension not listed here is still accepted, but is uploaded as
 * `application/octet-stream`. MIME remains authoritative when supplied.
 */
export const ARTIFACT_EXTENSIONS_BY_MIME = {
  'text/html': ['.html', '.htm'],
  'image/svg+xml': ['.svg'],
  'application/pdf': ['.pdf'],
  'text/markdown': ['.md'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'text/plain': ['.txt', '.log'],
  'application/json': ['.json'],
  'text/csv': ['.csv'],
  'application/zip': ['.zip'],
  'video/mp4': ['.mp4', '.m4v'],
  'video/quicktime': ['.mov'],
  'video/webm': ['.webm'],
  'audio/mpeg': ['.mp3'],
  'audio/wav': ['.wav'],
  'audio/mp4': ['.m4a'],
  'application/octet-stream': [],
} as const satisfies Record<ArtifactMimeType, readonly string[]>;

export const ARTIFACT_MIME_BY_EXTENSION: Readonly<Record<string, ArtifactMimeType>> =
  Object.fromEntries(
    Object.entries(ARTIFACT_EXTENSIONS_BY_MIME).flatMap(([mime, extensions]) =>
      extensions.map((extension) => [extension, mime as ArtifactMimeType]),
    ),
  );

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** Older QuickTime files open with one of these atoms instead of `ftyp`. */
const QUICKTIME_ATOMS = ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'];

/**
 * Returns a refusal sentence when a video or audio artifact's bytes do not
 * start with the signature of its declared mime; other mimes return undefined.
 */
export function artifactSignatureMismatch(mime: string, bytes: Uint8Array): string | undefined {
  const expected: Record<string, [string, () => boolean]> = {
    'video/mp4': ['an ISO-BMFF ftyp box', () => ascii(bytes, 4, 8) === 'ftyp'],
    'audio/mp4': ['an ISO-BMFF ftyp box', () => ascii(bytes, 4, 8) === 'ftyp'],
    'video/quicktime': ['a QuickTime ftyp or movie atom',
      () => QUICKTIME_ATOMS.includes(ascii(bytes, 4, 8))],
    'video/webm': ['the EBML header 1A 45 DF A3', () =>
      bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3],
    'audio/mpeg': ['an ID3 tag or MPEG frame sync', () => ascii(bytes, 0, 3) === 'ID3' ||
      (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)],
    'audio/wav': ['a RIFF/WAVE header',
      () => ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE'],
  };
  const check = expected[mime];
  if (!check || check[1]()) return undefined;
  return `a ${mime} artifact must start with ${check[0]}; these bytes do not`;
}

/** Artifacts upload through the server; this is also the `write_scratch_file`
 *  ceiling, so anything the helper can write it can post. */
export const ARTIFACT_MAXIMUM_BYTES = 25 * 1024 * 1024;

/**
 * `post_artifact` carries the title in the `x-artifact-title` header, and a
 * header value must be a ByteString: any character above U+00FF makes the
 * helper's `fetch` throw before the request leaves, with no hint. Percent-
 * encode the title on the way out and decode it on the way in so every
 * Unicode title survives.
 */
export function encodeArtifactTitleHeader(title: string): string {
  return encodeURIComponent(title);
}

/**
 * Decode a title the helper percent-encoded. A value with no `%` is a plain
 * ASCII title from an un-upgraded helper and passes through unchanged; a
 * malformed sequence also passes through rather than failing the upload.
 */
export function decodeArtifactTitleHeader(raw: string): string {
  if (!raw.includes('%')) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** How a presigned-POST upload object is created. `kind` is part of the storage key. */
export type UploadObjectKind = 'media' | 'artifact';

/** The projection shape of an artifact attachment on a message row. */
export interface ArtifactAttachment {
  kind: 'artifact';
  title: string;
  mimeType: string;
  size: number;
  /** The uploading agent, named by its canonical `@handle` (or name when it has none). */
  author: string;
}

export interface CreateUploadInput {
  kind: UploadObjectKind;
  mimeType: string;
  /** Exact size in bytes: the POST policy pins `content-length-range` to it. */
  size: number;
  /** Hex sha256 of the bytes, the dedupe key alongside the owner. */
  sha256: string;
  /** Artifact title; stored on the row and projected onto the attachment. */
  title?: string;
}

/** One presigned POST: `POST <url>` with `<fields>` plus the file as `file`. */
export interface PresignedPostUpload {
  url: string;
  fields: Record<string, string>;
}

export interface CreateUploadResult {
  objectId: string;
  /** True when identical bytes were already uploaded by this owner; no upload is needed. */
  deduped: boolean;
  /** The stored canonical reference, stable across both upload shapes. */
  url: string;
  /** Present only when `deduped` is false: the POST policy the client must use verbatim. */
  upload?: PresignedPostUpload;
  /** Epoch ms after which the policy (and the pending row) are no longer valid. */
  expiresAt: number;
}

export interface FinalizeUploadInput {
  objectId: string;
}

export interface FinalizeUploadResult {
  state: 'ready' | 'pending';
  /** Why the object is still pending; absent once it is ready. */
  reason?: 'not-found' | 'size-mismatch';
}
