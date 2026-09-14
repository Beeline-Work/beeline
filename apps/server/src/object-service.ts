/**
 * The server-side brain of the `objects` table: uploads, dedupe, finalize and
 * the read facts the media route turns into a 302.
 *
 * Two upload shapes (plan D-decision): artifacts (≤ `ARTIFACT_MAXIMUM_BYTES`)
 * stream through the server with `putObject` and land as `ready` in one step —
 * no pending state, no orphans. Large media mints a presigned POST policy with
 * an exact `content-length-range`; the client uploads directly to storage and
 * then calls `finalizeUpload`, which checks the stored size with one
 * `headObject` before flipping `pending → ready`.
 *
 * Dedupe mirrors `media`: identical bytes from the same owner resolve onto the
 * existing row and restart its TTL window. A storage-less server (no S3 env)
 * refuses every write with a clear error; reads and the legacy bytea path are
 * unaffected.
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  CreateUploadInput,
  CreateUploadResult,
  FinalizeUploadInput,
  FinalizeUploadResult,
} from '@beeline/api-contract/daemon';
import { ARTIFACT_MAXIMUM_BYTES, ARTIFACT_MIME_TYPES } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import { mediaTtlHours } from './media-ttl.js';
import type { ObjectStorage } from './object-storage.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Upload shape (a) — the mime types an artifact may carry. */
export function isArtifactMimeType(mime: string): boolean {
  return (ARTIFACT_MIME_TYPES as readonly string[]).includes(mime);
}

export interface UploadArtifactResult {
  objectId: string;
  url: string;
  title: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export interface MediaObjectRead {
  kind: 'redirect' | 'expired' | 'pending';
  location?: string;
}

export class ObjectService {
  readonly ttlHours: number;

  constructor(
    private readonly database: SqlDatabase,
    private readonly storage: ObjectStorage | undefined,
    private readonly publicOrigin: string,
    /** The large-media ceiling for mint-and-finalize uploads; artifacts are
     *  capped separately and more tightly by `uploadArtifact`. */
    private readonly maximumBytes: number = Number.MAX_SAFE_INTEGER,
    ttlHours: number = mediaTtlHours(),
  ) {
    this.ttlHours = ttlHours;
  }

  #requireStorage(): ObjectStorage {
    if (!this.storage) throw new Error('object storage is not configured');
    return this.storage;
  }

  /**
   * Pass-through artifact upload: validate, stream to storage, write the row
   * as `ready` in one step. Identical bytes from the same owner restart the
   * existing row's TTL window and return it, exactly like `uploadMedia`.
   */
  async uploadArtifact(
    agentId: string,
    bytes: Uint8Array,
    mimeType: string,
    title: string,
  ): Promise<UploadArtifactResult> {
    if (!isArtifactMimeType(mimeType))
      throw new Error(`artifact mime must be one of ${ARTIFACT_MIME_TYPES.join(', ')}`);
    if (!bytes.length || bytes.length > ARTIFACT_MAXIMUM_BYTES)
      throw new Error(`artifact size must be between 1 and ${ARTIFACT_MAXIMUM_BYTES} bytes`);
    if (!title.trim()) throw new Error('artifact title is required');
    const normalizedTitle = title.slice(0, 200);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const existing = await this.database.query<{
      id: string;
      kind: string;
      mime: string;
      title: string | null;
      size: string;
    }>(`SELECT id,kind,mime,title,size FROM objects WHERE owner_id=$1 AND sha256=$2`, [
      agentId,
      digest,
    ]);
    if (existing.rows[0]) {
      // Same bytes again is an upload: restart the TTL window and clear any
      // tombstone so the read path's invariant holds.
      await this.database.query(
        `UPDATE objects SET expires_at=now()+($2 || ' hours')::interval WHERE id=$1`,
        [existing.rows[0].id, String(this.ttlHours)],
      );
      await this.database.query(`DELETE FROM object_expirations WHERE id=$1`, [
        existing.rows[0].id,
      ]);
      return this.#result(existing.rows[0], agentId, digest);
    }
    const storage = this.#requireStorage();
    const key = `artifact/${agentId}/${digest}`;
    await storage.putObject(key, bytes, mimeType);
    const id = randomUUID();
    const stored = await this.database.query<{
      id: string;
      kind: string;
      mime: string;
      title: string | null;
      size: string;
    }>(
      `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
       VALUES ($1,$2,'artifact',$3,$4,$5,$6,$7,'ready',now()+($8 || ' hours')::interval)
       ON CONFLICT(owner_id,sha256) DO UPDATE SET expires_at=EXCLUDED.expires_at
       RETURNING id,kind,mime,title,size`,
      [id, agentId, key, mimeType, normalizedTitle, bytes.length, digest, String(this.ttlHours)],
    );
    await this.database.query(`DELETE FROM object_expirations WHERE id=$1`, [stored.rows[0]!.id]);
    return this.#result(stored.rows[0]!, agentId, digest);
  }

  #result(
    row: { id: string; kind: string; mime: string; title: string | null; size: string },
    _ownerId: string,
    digest: string,
  ): UploadArtifactResult {
    return {
      objectId: row.id,
      url: `${this.publicOrigin}/v1/media/${row.id}`,
      title: row.title ?? 'artifact',
      mimeType: row.mime,
      size: Number(row.size),
      sha256: digest,
    };
  }

  /**
   * Upload shape (b): mint the presigned POST policy, record the pending row.
   * Dedupe on owner+sha256 returns the existing object with no upload field.
   */
  async createUpload(agentId: string, input: CreateUploadInput): Promise<CreateUploadResult> {
    if (input.kind !== 'media' && input.kind !== 'artifact')
      throw new Error("upload kind must be 'media' or 'artifact'");
    if (!input.mimeType || input.mimeType.length > 255)
      throw new Error('upload mimeType is invalid');
    if (
      !Number.isSafeInteger(input.size) ||
      input.size <= 0 ||
      input.size > this.maximumBytes
    )
      throw new Error(`upload size must be between 1 and ${this.maximumBytes} bytes`);
    if (!SHA256_PATTERN.test(input.sha256)) throw new Error('upload sha256 is not a hex digest');
    const digest = input.sha256.toLowerCase();
    const existing = await this.database.query<{ id: string; state: string }>(
      `SELECT id,state FROM objects WHERE owner_id=$1 AND sha256=$2`,
      [agentId, digest],
    );
    const canonicalUrl = (id: string) => `${this.publicOrigin}/v1/media/${id}`;
    if (existing.rows[0]?.state === 'ready') {
      await this.database.query(
        `UPDATE objects SET expires_at=now()+($2 || ' hours')::interval WHERE id=$1`,
        [existing.rows[0].id, String(this.ttlHours)],
      );
      await this.database.query(`DELETE FROM object_expirations WHERE id=$1`, [
        existing.rows[0].id,
      ]);
      return {
        objectId: existing.rows[0].id,
        deduped: true,
        url: canonicalUrl(existing.rows[0].id),
        expiresAt: Date.now() + this.ttlHours * 3_600_000,
      };
    }
    const key = `${input.kind}/${agentId}/${digest}`;
    const storage = this.#requireStorage();
    const upload = await storage.presignPost(key, {
      contentType: input.mimeType,
      size: input.size,
    });
    const expiresAt = Date.now() + this.ttlHours * 3_600_000;
    const objectId =
      existing.rows[0]?.id ??
      (
        await this.database.query<{ id: string }>(
          `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',now()+($9 || ' hours')::interval)
           ON CONFLICT(owner_id,sha256) DO UPDATE SET mime=EXCLUDED.mime,title=EXCLUDED.title
           RETURNING id`,
          [
            randomUUID(),
            agentId,
            input.kind,
            key,
            input.mimeType,
            input.title ?? null,
            input.size,
            digest,
            String(this.ttlHours),
          ],
        )
      ).rows[0]!.id;
    return { objectId, deduped: false, url: canonicalUrl(objectId), upload, expiresAt };
  }

  /**
   * One `headObject`, one size comparison, then the flip. Anything else stays
   * pending with a reason, and the sweep reaps it after an hour.
   */
  async finalizeUpload(
    agentId: string,
    input: FinalizeUploadInput,
  ): Promise<FinalizeUploadResult> {
    const row = (
      await this.database.query<{ id: string; key: string; size: string; state: string }>(
        `SELECT id,key,size,state FROM objects WHERE id=$1 AND owner_id=$2`,
        [input.objectId, agentId],
      )
    ).rows[0];
    if (!row) throw new Error('object not found');
    if (row.state === 'ready') return { state: 'ready' };
    const head = await this.#requireStorage().headObject(row.key);
    if (!head) return { state: 'pending', reason: 'not-found' };
    if (head.size !== Number(row.size)) return { state: 'pending', reason: 'size-mismatch' };
    await this.database.transaction(async (database) => {
      await database.query(
        `UPDATE objects SET state='ready',expires_at=now()+($2 || ' hours')::interval WHERE id=$1`,
        [row.id, String(this.ttlHours)],
      );
      await database.query(`DELETE FROM object_expirations WHERE id=$1`, [row.id]);
    });
    return { state: 'ready' };
  }

  /**
   * The object branch of the media read: a ready object becomes a 10-minute
   * signed GET with the disposition inside the signature; a swept object is an
   * expired fact; a pending one never existed for readers.
   */
  async readMediaObject(mediaId: string): Promise<MediaObjectRead | undefined> {
    // The tombstone is the fact, not the absence of a row: a swept object
    // answers expired whether or not its row still exists.
    const expired = await this.database.query(`SELECT 1 FROM object_expirations WHERE id=$1`, [
      mediaId,
    ]);
    if (expired.rows.length) return { kind: 'expired' };
    const row = (
      await this.database.query<{ key: string; state: string }>(
        `SELECT key,state FROM objects WHERE id=$1`,
        [mediaId],
      )
    ).rows[0];
    if (!row) return undefined;
    if (row.state !== 'ready') return { kind: 'pending' };
    const location = await this.#requireStorage().presignGet(row.key, { expiresIn: 600 });
    return { kind: 'redirect', location };
  }

  /**
   * The `open in browser` link: the same signed GET the 302 hands out, minted
   * at tap time because a browser has no bearer token for `/v1/media/<id>`.
   * Only stored objects have a storage link; legacy media answers undefined.
   */
  async mediaLink(mediaId: string): Promise<{ url: string; expiresIn: number } | undefined> {
    const row = (
      await this.database.query<{ key: string; mime: string; title: string | null; state: string }>(
        `SELECT key,mime,title,state FROM objects WHERE id=$1`,
        [mediaId],
      )
    ).rows[0];
    if (!row || row.state !== 'ready') return undefined;
    const expiresIn = 600;
    const url = await this.#requireStorage().presignGet(row.key, {
      expiresIn,
      responseContentDisposition: `inline; filename="${(row.title ?? 'download').replaceAll('"', '')}"`,
      responseContentType: row.mime,
    });
    return { url, expiresIn };
  }
}
