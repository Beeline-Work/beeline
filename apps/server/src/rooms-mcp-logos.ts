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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
/**
 * Bundled marks are only for these exact callbacks. A self-chosen name with any
 * other redirect, including another path on the same host, stays unverified.
 * Cursor's agents callback is Grok Bot; the desktop and other web callback stay Cursor.
 */
const MCP_VENDOR_CALLBACKS: readonly { names: RegExp; redirect: string; display: string }[] = [
  { names: /^Cursor$/, redirect: 'https://www.cursor.com/agents/mcp/oauth/callback', display: 'Grok Bot' },
  { names: /^Cursor$/, redirect: 'cursor://anysphere.cursor-mcp/oauth/callback', display: 'Cursor' },
  { names: /^Cursor$/, redirect: 'https://cursor.com/agents/oauth/callback', display: 'Cursor' },
  { names: /^(meta muse|metamuse|muse)$/i, redirect: 'https://agent.meta.ai/api/hatch/oauth/callback', display: 'Meta Muse' },
];

/** The bundled name for this sign-in's redirect, or undefined when the name is only self-declared. */
export function mcpVendorDisplay(name: string, redirect: string): string | undefined {
  return MCP_VENDOR_CALLBACKS.find(item => item.names.test(name) && item.redirect === redirect)?.display;
}

function unknownHttpsRedirect(name: string, redirect: string): boolean {
  let url: URL;
  try { url = new URL(redirect); } catch { return false; }
  return url.protocol === 'https:' && !LOOPBACK_HOSTS.has(url.hostname) && !mcpVendorDisplay(name, redirect);
}

/**
 * Vendor label for a client whose redirects are all known callbacks, loopback,
 * or private-use schemes. One unknown https redirect keeps the self-declared name.
 */
export function mcpVerifiedDisplay(name: string, redirects: readonly string[]): string | undefined {
  if (redirects.some(redirect => unknownHttpsRedirect(name, redirect))) return undefined;
  for (const redirect of redirects) {
    const display = mcpVendorDisplay(name, redirect);
    if (display) return display;
  }
  return undefined;
}

export interface RedirectTrust {
  kind: 'vendor' | 'loopback' | 'device' | 'handoff' | 'confirm';
  display: string;
  host: string;
  reason: string;
}

/** Why this sign-in's redirect may receive a code, and the host the consent page must show. */
export function redirectTrust(name: string, redirect: string, handoff: string): RedirectTrust {
  const url = new URL(redirect);
  const host = url.host || url.protocol.replace(/:$/, '');
  const vendor = mcpVendorDisplay(name, redirect);
  if (vendor) return { kind: 'vendor', display: vendor, host, reason: `Allowed because this is ${vendor}'s known callback.` };
  if (redirect === handoff) return { kind: 'handoff', display: name, host, reason: 'Allowed because it returns to this Beeline session.' };
  if (LOOPBACK_HOSTS.has(url.hostname)) return { kind: 'loopback', display: name, host, reason: 'Allowed because it returns to an app on this computer.' };
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'device', display: name, host, reason: 'Allowed because it returns to the app on this device.' };
  return { kind: 'confirm', display: name, host, reason: 'This name is unverified. Allowed only after you type this host. If someone sent you this link, close this page.' };
}

/** Registration identity shared by consent and member defaults. */
export function mcpClientName(name: string, redirects: readonly string[] = []): string {
  return mcpVerifiedDisplay(name, redirects) ?? name;
}

const bundled = new Map<string, Promise<string>>();
const bundledKey = (name: string) =>
  /^(grok bot|grokbot)$/i.test(name) ? 'grok-bot.svg'
    : /^grok$/i.test(name) ? 'grok.svg'
    : /^(meta muse|metamuse|muse)$/i.test(name) ? 'muse.webp'
    : /^(codex|openai codex)$/i.test(name) ? 'codex.png'
    : /^(claude|claude code)$/i.test(name) ? 'claude.png'
    : /^cursor$/i.test(name) ? 'cursor.svg'
    : /^(dots|openai dots)$/i.test(name) ? 'dots.png' : undefined;
export function bundledMcpLogo(name: string): Promise<string | undefined> {
  const key = bundledKey(name);
  if (!key) return Promise.resolve(undefined);
  if (!bundled.has(key)) bundled.set(key, sharp(readFileSync(new URL(`../assets/mcp/${key}`, import.meta.url)))
    .resize(96, 96, { fit: 'inside' }).png().toBuffer().then(bytes => `data:image/png;base64,${bytes.toString('base64')}`));
  return bundled.get(key)!;
}

const AVATAR_SIZE = 256;
/**
 * The picture a client's member shows in Members and on its messages, served
 * from /v1/agent-avatars/ like any generated portrait. A bundled mark renders
 * from the bundled asset; otherwise the image is the client's cached logo.
 * Member-selected portraits are stored separately and never pass this path.
 */
export async function mcpMemberAvatar(name: string, image: string | null): Promise<Buffer | undefined> {
  const key = bundledKey(name);
  const source = key ? readFileSync(new URL(`../assets/mcp/${key}`, import.meta.url))
    : image?.startsWith('data:image/') ? Buffer.from(image.slice(image.indexOf(',') + 1), 'base64') : undefined;
  if (!source) return undefined;
  // A brand mark sits inset on one bone plate, so it reads the same on every
  // member hue and in both themes.
  const inset = Math.round(AVATAR_SIZE * 0.14), plate = { r: 0xF3, g: 0xEE, b: 0xE4, alpha: 1 };
  const mark = await sharp(source, { limitInputPixels: 4_000_000, density: 96 })
    .resize(AVATAR_SIZE - inset * 2, AVATAR_SIZE - inset * 2, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  return sharp(mark).extend({ top: inset, bottom: inset, left: inset, right: inset, background: plate })
    .flatten({ background: plate }).webp().toBuffer();
}
