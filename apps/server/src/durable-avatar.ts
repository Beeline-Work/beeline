import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { SqlDatabase } from './database.js';
import { isMediaId } from './media-ttl.js';

export const AVATAR_EDGE = 256;
export const AVATAR_MAX_BYTES = 128 * 1024;
export const AVATAR_INPUT_MAX_BYTES = 5 * 1024 * 1024;

/** Shared byte policy, independent of whose mark might use an avatar later. */
export async function normalizeAvatar(input: Uint8Array): Promise<Buffer> {
  if (!input.length || input.length > AVATAR_INPUT_MAX_BYTES)
    throw new Error('avatar size is outside the allowed range');
  try {
    const image = sharp(Buffer.from(input), { limitInputPixels: 16_000_000 });
    const metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1)
      throw new Error('unsupported avatar format');
    // Re-encoding retains pixels, not EXIF, location or the full-size image.
    const bytes = await image
      .rotate()
      .resize(AVATAR_EDGE, AVATAR_EDGE, { fit: 'cover' })
      .webp({ quality: 80 })
      .toBuffer();
    if (bytes.length > AVATAR_MAX_BYTES) throw new Error('avatar output too large');
    return bytes;
  } catch {
    throw new Error('avatar image is invalid or too large');
  }
}

/** Runs in the workspace setter transaction after manager authorization.
 * No caller URL is fetched. Installed clients can keep uploading through
 * /media: committing the setter retains a small re-encoded avatar durably.
 */
export async function storeWorkspaceAvatar(
  database: SqlDatabase,
  workspaceId: string,
  viewerId: string,
  source: string,
  publicOrigin: string,
): Promise<string> {
  if (!source) {
    await database.query('DELETE FROM avatars WHERE workspace_id=$1', [workspaceId]);
    return '';
  }
  let url: URL;
  try {
    url = new URL(source, publicOrigin);
  } catch {
    throw new Error('avatar URL is invalid');
  }
  const match = url.pathname.match(/^\/v1\/(media|avatars)\/([^/]+)$/);
  if (url.origin !== new URL(publicOrigin).origin || !match || !isMediaId(match[2]!))
    throw new Error('avatar must name an image uploaded to this server; external URLs are invalid');
  const [, kind, id] = match;
  if (kind === 'avatars') {
    const existing = await database.query('SELECT 1 FROM avatars WHERE id=$1 AND workspace_id=$2', [
      id,
      workspaceId,
    ]);
    if (!existing.rowCount) throw new Error('avatar not found for this workspace');
    return `/v1/avatars/${id}`;
  }
  const media = (
    await database.query<{ bytes: Uint8Array }>(
      'SELECT bytes FROM media WHERE id=$1 AND owner_id=$2',
      [id, viewerId],
    )
  ).rows[0];
  if (!media) throw new Error('avatar upload not found; choose the picture again');
  const bytes = await normalizeAvatar(media.bytes);
  const avatarId = randomUUID();
  // One bounded object per workspace. A replacement changes the URL so a
  // device/CDN cache cannot keep showing the previous picture.
  await database.query(
    `INSERT INTO avatars(id,workspace_id,bytes) VALUES($1,$2,$3)
     ON CONFLICT(workspace_id) DO UPDATE SET id=EXCLUDED.id,bytes=EXCLUDED.bytes`,
    [avatarId, workspaceId, bytes],
  );
  return `/v1/avatars/${avatarId}`;
}
