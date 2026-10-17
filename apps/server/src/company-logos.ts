import { lookup } from 'node:dns/promises';
import { Agent, get } from 'node:https';
import { readFileSync } from 'node:fs';
import ipaddr from 'ipaddr.js';
import sharp from 'sharp';
import type { CompanyLogo } from '@beeline/api-contract/workbench';
import { COMPANY_MARK_IDS, companyHost, type CompanyProvider } from './company-registry.js';

type Image = { bytes: Buffer; mime: string };
const cache = new Map<string, { until: number; image?: Image; pending?: Promise<Image | undefined> }>();
const LIMIT = 512 * 1024;
let fetching = 0;

export function companyLogo(provider: CompanyProvider, origin: string): CompanyLogo {
  if (!provider.domain) return { kind: 'monogram' };
  const id = COMPANY_MARK_IDS.has(provider.id) ? provider.id : provider.domain;
  return { kind: 'image', uri: `${origin}/v1/company-logos/${encodeURIComponent(id)}`,
    plate: COMPANY_MARK_IDS.has(provider.id) ? 'dark' : 'light' };
}
function publicAddress(address: string): boolean {
  try {
    const ip = ipaddr.parse(address);
    return ip.range() === 'unicast' && (ip.kind() === 'ipv4' ||
      (ip.match(ipaddr.parseCIDR('2000::/3')) && !ip.match(ipaddr.parseCIDR('2001:db8::/32'))));
  } catch { return false; }
}
/** Resolve once and pin the HTTPS socket; redirects resolve and validate independently. */
export async function publicIconResponse(url: URL, redirects = 0, deadline = Date.now() + 10_000): Promise<{ bytes: Buffer; mime: string; url: URL }> {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !companyHost(url.hostname) || redirects > 3)
    throw new Error('invalid company icon address');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('company icon timeout');
  const answers = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('icon DNS timeout')), Math.min(2000, remaining)); timer.unref(); }),
  ]);
  if (!answers.length || answers.some(a => !publicAddress(a.address))) throw new Error('non-public company icon');
  const address = answers[0]!;
  const agent = new Agent({ autoSelectFamily: false, lookup(hostname, _options, callback) {
    if (hostname !== url.hostname) return callback(new Error('icon hostname mismatch'), '', 4);
    callback(null, address.address, address.family);
  } });
  try {
    const response = await new Promise<{ bytes: Buffer; mime: string; location?: string; status: number }>((resolve, reject) => {
      const req = get(url, { agent, signal: AbortSignal.timeout(Math.max(1, Math.min(4500, deadline - Date.now()))), headers: { accept: 'image/*,text/html;q=0.5', 'user-agent': 'Beeline company icons' } }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > LIMIT) req.destroy(new Error('company icon too large')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => resolve({ bytes: Buffer.concat(chunks), mime: (res.headers['content-type'] ?? '').split(';')[0]!,
          status: res.statusCode ?? 500, location: res.headers.location }));
      });
      req.on('error', reject);
    });
    if (response.status >= 300 && response.status < 400 && response.location)
      return publicIconResponse(new URL(response.location, url), redirects + 1, deadline);
    if (response.status !== 200) throw new Error('company icon unavailable');
    return { bytes: response.bytes, mime: response.mime, url };
  } finally { agent.destroy(); }
}
async function siteIcon(domain: string): Promise<Image | undefined> {
  const urls: URL[] = [];
  const deadline = Date.now() + 10_000;
  try {
    const page = await publicIconResponse(new URL(`https://${domain}/`), 0, deadline);
    if (page.mime === 'text/html') {
      const html = page.bytes.toString('utf8');
      for (const tag of html.match(/<link\b[^>]{0,2048}>/gi) ?? []) {
        const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        if (rel?.split(/\s+/).some(r => r.toLowerCase() === 'icon' || r.toLowerCase() === 'apple-touch-icon') && href) {
          try { urls.push(new URL(href.replace(/&amp;/g, '&'), page.url)); } catch { /* invalid site metadata */ }
        }
        if (urls.length >= 3) break;
      }
    }
  } catch { /* root unavailable; still try the conventional site icon */ }
  urls.push(new URL(`https://${domain}/favicon.ico`));
  for (const url of urls.slice(0, 4)) {
    try {
      const image = await publicIconResponse(url, 0, deadline);
      if (!image.mime.startsWith('image/')) continue;
      const bytes = await sharp(image.bytes, { limitInputPixels: 1_000_000, animated: false })
        .resize(64, 64, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      return { bytes, mime: 'image/png' };
    } catch { /* try the next site-provided icon */ }
  }
  return undefined;
}
/** Bounded process cache; icon IO never runs as part of the Workbench DTO read. */
export async function readCompanyLogo(id: string): Promise<Image | undefined> {
  if (COMPANY_MARK_IDS.has(id)) {
    const held = cache.get(id)?.image;
    if (held) return held;
    const bytes = await sharp(readFileSync(new URL(`../assets/companies/${id}.svg`, import.meta.url))).resize(64, 64, { fit: 'inside' }).png().toBuffer();
    const image = { bytes, mime: 'image/png' };
    cache.set(id, { until: Infinity, image }); return image;
  }
  const domain = companyHost(id);
  if (!domain || domain !== id || id.length > 253) return undefined;
  const held = cache.get(id);
  if (held && held.until > Date.now()) return held.pending ?? held.image;
  if (fetching >= 4) return undefined;
  if (cache.size >= 512) { for (const key of cache.keys()) { if (!COMPANY_MARK_IDS.has(key) && !cache.get(key)?.pending) { cache.delete(key); break; } } }
  fetching++;
  const pending = siteIcon(domain).then(image => { cache.set(id, { image, until: Date.now() + (image ? 86400_000 : 10 * 60_000) }); return image; })
    .finally(() => { fetching--; });
  cache.set(id, { until: Date.now() + 30_000, pending });
  return pending;
}
