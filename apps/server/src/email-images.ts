import sharp from 'sharp';
import type { ServerResponse } from 'node:http';
import { resolveFace } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { emailAnimals } from './email-art/animals.js';
import { emailPlateColor } from './email-art/palette.js';
import { emailLogoPath } from './email-art/logo.js';

const cache = new Map<string, { expires: number; bytes: Buffer }>();
let rendering = 0;
const logos = new Map<string, Buffer>();

/** Public mail images only: no remote fetches, caller XML, or identity metadata. */
export async function serveEmailImage(db: SqlDatabase, url: URL, response: ServerResponse): Promise<boolean> {
  const logo = url.pathname === '/v1/email-logo.png';
  if (!logo && !url.pathname.startsWith('/v1/email-faces/')) return false;
  const end = (status: number) => { response.writeHead(status, { 'cache-control': 'no-store' }); response.end(); return true; };
  const size = Number(url.searchParams.get('size') ?? 128);
  const tilt = Number(url.searchParams.get('tilt') ?? 0);
  const theme = url.searchParams.get('theme') ?? 'light';
  const match = url.pathname.match(/^\/v1\/email-faces\/([a-f0-9]{64})\.png$/);
  if (logo ? !['light','dark'].includes(theme) : !match || ![32,64,128,256].includes(size) || ![-6,0,5].includes(tilt)) return end(400);
  let bytes: Buffer | undefined;
  if (logo) {
    bytes = logos.get(theme);
    if (!bytes) {
      bytes = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 240 240"><path fill="${theme === 'dark' ? '#f0f0f3' : '#171310'}" d="${emailLogoPath}"/></svg>`)).png().toBuffer();
      logos.set(theme, bytes);
    }
  } else {
    const row = (await db.query<{ id: string; face_id: string | null; updated_at: Date; avatar_id: string | null; bytes: Uint8Array | null }>(
      `SELECT i.id,i.face_id,i.updated_at,a.id avatar_id,a.bytes FROM identities i
       LEFT JOIN agent_avatars a ON a.agent_id=i.id AND i.avatar='/v1/agent-avatars/'||a.id::text
       WHERE i.id=$1 AND i.kind='agent' AND NOT i.hidden_from_roster`, [match![1]])).rows[0];
    if (!row) return end(404);
    const key = `${row.id}:${row.face_id}:${row.updated_at}:${row.avatar_id}:${size}:${tilt}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) bytes = hit.bytes;
    if (!bytes) {
      if (rendering >= 4) return end(503);
      rendering++;
      try {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 100 100"><rect width="100" height="100" rx="${tilt ? 4.69 : size === 32 ? 15 : 7.5}" fill="${emailPlateColor(row.id)}"/><g transform="translate(10 10) scale(.8)">${emailAnimals[resolveFace(row.face_id,row.id)]}</g></svg>`;
        bytes = await sharp(row.bytes ? Buffer.from(row.bytes) : Buffer.from(svg), { limitInputPixels: 1_000_000 })
          .resize(size,size,{fit:'cover'}).rotate(tilt,{ background: '#00000000' }).png().toBuffer();
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        cache.set(key,{ bytes, expires: Date.now()+300_000 });
      } finally { rendering--; }
    }
  }
  response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(bytes.length),
    'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox" });
  response.end(bytes);
  return true;
}
