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
  'application/octet-stream',
] as const;

export type ArtifactMimeType = (typeof ARTIFACT_MIME_TYPES)[number];

/** Artifacts upload through the server; this is also the `write_scratch_file`
 *  ceiling, so anything the helper can write it can post. */
export const ARTIFACT_MAXIMUM_BYTES = 25 * 1024 * 1024;

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
