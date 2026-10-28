import { lookup } from 'node:dns/promises';
import { Agent, request } from 'node:https';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { publicMcpAddress } from './company-mcp-discovery.js';

/** No redirects; pin one public DNS answer for the whole TLS request. */
export async function fetchMcpLogo(value: string, size = 96): Promise<string> {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || value.length > 2048)
    throw new Error('Invalid logo URL');
  const signal = AbortSignal.timeout(3000);
  const answers = await Promise.race([lookup(url.hostname, { all: true, verbatim: true }), new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Logo DNS timeout')), { once: true });
  })]);
  if (!answers.length || answers.some(a => !publicMcpAddress(a.address))) throw new Error('Non-public logo address');
  const address = answers[0]!;
  const agent = new Agent({ autoSelectFamily: false, lookup(host, _options, callback) {
    if (host !== url.hostname) return callback(new Error('Logo hostname mismatch'), '', 4);
    callback(null, address.address, address.family);
  } });
  try {
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const req = request(url, { agent, signal, headers: { accept: 'image/png,image/jpeg,image/webp' } }, res => {
        if (res.statusCode !== 200 || !['image/png', 'image/jpeg', 'image/webp'].includes(res.headers['content-type']?.split(';')[0] ?? '')) {
          res.resume(); reject(new Error('Unsupported logo')); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 262144) req.destroy(new Error('Logo too large')); else chunks.push(chunk);
        });
        res.on('error', reject); res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject); req.end();
    });
    const png = await sharp(bytes, { limitInputPixels: 4_000_000 }).resize(size, size, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } finally { agent.destroy(); }
}

const bundled = new Map<string, Promise<string>>();
const bundledKey = (name: string) =>
  /^(grok|grok bot)$/i.test(name) ? 'grok' : /^(meta muse|muse)$/i.test(name) ? 'muse' : undefined;
export function bundledMcpLogo(name: string): Promise<string | undefined> {
  const key = bundledKey(name);
  if (!key) return Promise.resolve(undefined);
  if (!bundled.has(key)) bundled.set(key, sharp(readFileSync(new URL(`../assets/mcp/${key}.svg`, import.meta.url)))
    .resize(96, 96, { fit: 'inside' }).png().toBuffer().then(bytes => `data:image/png;base64,${bytes.toString('base64')}`));
  return bundled.get(key)!;
}

const AVATAR_SIZE = 256;
/**
 * The picture a client's member shows in Members and on its messages, served
 * from /v1/agent-avatars/ like any generated portrait. A bundled mark renders
 * sharp from its vector; otherwise the image is the client's cached logo or
 * an avatar the client set for itself.
 */
export async function mcpMemberAvatar(name: string, image: string | null): Promise<Buffer | undefined> {
  const key = bundledKey(name);
  const vector = key && (!image || image === await bundledMcpLogo(name));
  const source = vector ? readFileSync(new URL(`../assets/mcp/${key}.svg`, import.meta.url))
    : image?.startsWith('data:image/') ? Buffer.from(image.slice(image.indexOf(',') + 1), 'base64') : undefined;
  if (!source) return undefined;
  // A brand mark sits inset on one bone plate, so it reads the same on every
  // member hue and in both themes.
  const inset = Math.round(AVATAR_SIZE * 0.14), plate = { r: 0xF3, g: 0xEE, b: 0xE4, alpha: 1 };
  const mark = await sharp(source, { limitInputPixels: 4_000_000, density: 300 })
    .resize(AVATAR_SIZE - inset * 2, AVATAR_SIZE - inset * 2, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  return sharp(mark).extend({ top: inset, bottom: inset, left: inset, right: inset, background: plate })
    .flatten({ background: plate }).webp().toBuffer();
}
