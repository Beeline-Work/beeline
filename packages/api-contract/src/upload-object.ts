import { createHash } from 'node:crypto';
import type {
  CreateUploadResult,
  FinalizeUploadResult,
  UploadObjectKind,
} from './artifacts.js';

/** The gate surface `uploadObject` needs; DaemonApiClient and the phone
 *  client both provide it against `POST /v1/daemon/uploads` and
 *  `POST /v1/daemon/uploads/<id>/finalize`. */
export interface UploadGateClient {
  createUpload(input: {
    kind: UploadObjectKind;
    mimeType: string;
    size: number;
    sha256: string;
    title?: string;
  }): Promise<CreateUploadResult>;
  finalizeUpload(input: { objectId: string }): Promise<FinalizeUploadResult>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The one shared upload path for large objects: sha256 → createUpload →
 * presigned POST → finalizeUpload. The POST policy pins `content-length-range`
 * to the declared size, so storage itself refuses a drifted body. Identical
 * bytes from the same owner dedupe onto the existing object and skip the
 * upload and finalize round trips entirely. Used by apps/body and
 * apps/mobile for media so the two never drift; artifacts (≤ 25 MB) go through
 * the server pass-through instead.
 */
export async function uploadObject(
  client: UploadGateClient,
  bytes: Uint8Array,
  options: { kind: UploadObjectKind; mimeType: string; title?: string },
): Promise<{ objectId: string; url: string; sha256: string }> {
  const sha256 = sha256Hex(bytes);
  const created = await client.createUpload({
    kind: options.kind,
    mimeType: options.mimeType,
    size: bytes.byteLength,
    sha256,
    title: options.title,
  });
  if (created.deduped || !created.upload) {
    return { objectId: created.objectId, url: created.url, sha256 };
  }
  const form = new FormData();
  for (const [name, value] of Object.entries(created.upload.fields)) form.append(name, value);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: options.mimeType }));
  const response = await fetch(created.upload.url, { method: 'POST', body: form });
  if (!response.ok) {
    throw new Error(`object upload failed (${response.status})`);
  }
  const finalized = await client.finalizeUpload({ objectId: created.objectId });
  if (finalized.state !== 'ready') {
    throw new Error(`object ${created.objectId} did not finalize (state ${finalized.state})`);
  }
  return { objectId: created.objectId, url: created.url, sha256 };
}
