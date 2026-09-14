import { createHash } from 'node:crypto';

/**
 * Artifacts and object uploads — the client half of the artifacts-on-object-
 * storage plan.
 *
 * NOTE (lane overlap): the server half (lane A1) owns `POST /v1/daemon/
 * artifacts`, `createUpload` and `finalizeUpload`. Until that lane merges,
 * these are the minimal shared types under the plan's exact names so both
 * lanes fit; when A1 lands, reconcile here first rather than renaming at the
 * call sites.
 */

/** Everything small enough to stream through the server as one artifact. */
export const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;

/** The mime types `post_artifact` accepts; the mime selects validator,
 *  preview, and renderer (one artifact kind, keyed by mime). */
export const ARTIFACT_MIME_TYPES = [
  'text/html',
  'image/svg+xml',
  'application/pdf',
  'text/markdown',
] as const;

export type ArtifactMime = (typeof ARTIFACT_MIME_TYPES)[number];

export function isArtifactMime(value: unknown): value is ArtifactMime {
  return (
    typeof value === 'string' && (ARTIFACT_MIME_TYPES as readonly string[]).includes(value)
  );
}

/** The `objects.kind` vocabulary from the plan. */
export type ObjectUploadKind = 'media' | 'artifact';

/** `createUpload {kind, mime, size, sha256}` — a presigned-POST policy with
 *  `content-length-range` pinned to the declared size. */
export type CreateUploadRequest = {
  readonly kind: ObjectUploadKind;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
};

/** The presigned POST policy: upload to `url` with `fields` plus the file,
 *  then call `finalizeUpload`. */
export type CreateUploadResult = {
  readonly objectId: string;
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
};

export type FinalizeUploadRequest = {
  readonly objectId: string;
};

/** `finalizeUpload(objectId)` — the server HEADs the object, checks size and
 *  ETag, and flips the row `pending → ready`. */
export type FinalizeUploadResult = {
  readonly objectId: string;
  readonly state: 'ready' | 'pending';
};

/** The response of the small-object pass-through `POST /v1/daemon/artifacts`:
 *  the bytes are already validated and stored, ready to attach to a message. */
export type ArtifactUploadResult = {
  readonly url: string;
  readonly mimeType: string;
  readonly size: number;
  readonly name?: string;
};

/** The gate surface `uploadObject` needs; DaemonApiClient and the phone
 *  client both provide it. */
export interface UploadGateClient {
  createUpload(request: CreateUploadRequest): Promise<CreateUploadResult>;
  finalizeUpload(request: FinalizeUploadRequest): Promise<FinalizeUploadResult>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The one shared upload path for LARGE objects (`uploadObject(client, bytes,
 * options)` from the plan): sha256 → createUpload → presigned POST →
 * finalizeUpload. The POST policy pins `content-length-range` to the declared
 * size, so storage itself refuses a drifted body. Used by apps/body and
 * apps/mobile for media so the two never drift; artifacts (≤ 2 MB) go through
 * the server pass-through instead.
 */
export async function uploadObject(
  client: UploadGateClient,
  bytes: Uint8Array,
  options: { kind: ObjectUploadKind; mime: string },
): Promise<{ objectId: string; sha256: string }> {
  const sha256 = sha256Hex(bytes);
  const created = await client.createUpload({
    kind: options.kind,
    mime: options.mime,
    size: bytes.byteLength,
    sha256,
  });
  const form = new FormData();
  for (const [name, value] of Object.entries(created.fields)) form.append(name, value);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: options.mime }));
  const response = await fetch(created.url, { method: 'POST', body: form });
  if (!response.ok) {
    throw new Error(`object upload failed (${response.status})`);
  }
  const finalized = await client.finalizeUpload({ objectId: created.objectId });
  if (finalized.state !== 'ready') {
    throw new Error(`object ${created.objectId} did not finalize (state ${finalized.state})`);
  }
  return { objectId: finalized.objectId, sha256 };
}
