import { lookup } from 'node:dns/promises';
import { Agent, request } from 'node:https';
import { createHash } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { appIdentity } from '@beeline/api-contract/workbench';
import type { RegistryMcpManifest } from '@beeline/api-contract/daemon';
import { COMPANY_REGISTRY, companyHost, type CompanyProvider } from './company-registry.js';

const BUDGET_MS = 1000;
const MAX_BYTES = 64 * 1024;
type ProbeResponse = { status: number; body: string; challenge?: string; location?: string };
export type CompanyMcpTransport = (url: URL, domain: string, deadline: number, method?: 'GET' | 'POST') => Promise<ProbeResponse>;

export function companyForMcp(query: string): CompanyProvider | undefined {
  const q = query.trim().toLowerCase();
  const key = q.includes('.') || q.includes('/') ? undefined : appIdentity(q)?.key;
  const host = companyHost(q);
  return COMPANY_REGISTRY.find(p => p.domain && (q === p.id || host && p.hosts.includes(host) || q === p.name.toLowerCase()
    || key === appIdentity(p.domain)?.key));
}
export function companyMcpUrl(value: unknown, domain: string): URL | undefined {
  try {
    if (typeof value !== 'string' || value.length > 2048) return undefined;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      && (url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url : undefined;
  } catch { return undefined; }
}
export function publicMcpAddress(address: string): boolean {
  try {
    const ip = ipaddr.parse(address);
    return ip.range() === 'unicast' && (ip.kind() === 'ipv4'
      || ip.match(ipaddr.parseCIDR('2000::/3')) && !ip.match(ipaddr.parseCIDR('2001:db8::/32')));
  } catch { return false; }
}
/** Resolve once, reject every non-public answer and pin the socket against DNS rebinding. */
export const companyMcpResponse: CompanyMcpTransport = async (url, domain, deadline, method = 'GET') => {
  if (!companyMcpUrl(url.toString(), domain)) throw new Error('Invalid company MCP URL');
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const answers = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const abort = () => reject(new Error('Company MCP DNS timed out'));
    signal.addEventListener('abort', abort, { once: true });
    lookup(url.hostname, { all: true, verbatim: true }).then(value => {
      signal.removeEventListener('abort', abort); resolve(value);
    }, reject);
  });
  if (!answers.length || answers.some(a => !publicMcpAddress(a.address))) throw new Error('Non-public company MCP address');
  if (signal.aborted) throw new Error('Company MCP timed out');
  const address = answers[0]!;
  const agent = new Agent({ autoSelectFamily: false, lookup(host, _options, callback) {
    if (host !== url.hostname) return callback(new Error('MCP hostname mismatch'), '', 4);
    callback(null, address.address, address.family);
  } });
  try {
    return await new Promise<ProbeResponse>((resolve, reject) => {
      const req = request(url, { agent, method, signal, headers: { accept: 'application/json, text/event-stream',
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) } }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BYTES) req.destroy(new Error('Company MCP response too large')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf8'),
          challenge: res.headers['www-authenticate'], location: res.headers.location }));
      });
      req.on('error', reject);
      req.end(method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Beeline discovery', version: '1' } } }) : undefined);
    });
  } finally { agent.destroy(); }
};

export class CompanyMcpDiscovery {
  private readonly cache = new Map<string, { until: number; value: Promise<RegistryMcpManifest | undefined> }>();
  private active = 0;
  constructor(private readonly transport: CompanyMcpTransport = companyMcpResponse) {}

  async discover(query: string, fresh = false): Promise<RegistryMcpManifest | undefined> {
    const company = companyForMcp(query);
    if (!company?.domain) return undefined;
    const held = this.cache.get(company.id);
    if (!fresh && held && held.until > Date.now()) return held.value;
    if (this.active >= 4) return undefined;
    this.active++;
    const value = this.probe(company).catch(() => undefined).finally(() => { this.active--; });
    this.cache.set(company.id, { until: Date.now() + 60_000, value });
    void value.then(manifest => { if (this.cache.get(company.id)?.value === value)
      this.cache.set(company.id, { until: Date.now() + (manifest ? 10 * 60_000 : 60_000), value }); });
    return value;
  }

  private async probe(company: CompanyProvider): Promise<RegistryMcpManifest | undefined> {
    const domain = company.domain!;
    const deadline = Date.now() + BUDGET_MS;
    const remote = new URL(`https://mcp.${domain}`);
    const get = async (url: URL, method: 'GET' | 'POST' = 'GET'): Promise<ProbeResponse> => {
      for (let redirects = 0; redirects < 3; redirects++) {
        if (Date.now() >= deadline || !companyMcpUrl(url.toString(), domain)) throw new Error('MCP discovery outside budget or domain');
        const response = await this.transport(url, domain, deadline, method);
        if (response.status < 300 || response.status >= 400) return response;
        const next = response.location && companyMcpUrl(new URL(response.location, url).toString(), domain);
        if (!next) throw new Error('MCP redirect outside company domain');
        url = next;
      }
      throw new Error('Too many MCP redirects');
    };
    let response = await get(new URL('/.well-known/oauth-protected-resource', remote));
    if (response.status !== 200) {
      const challenge = await get(remote, 'POST');
      const metadata = /\bresource_metadata="([^"]+)"/i.exec(challenge.challenge ?? '')?.[1];
      const metadataUrl = companyMcpUrl(metadata, domain);
      if (challenge.status !== 401 || !metadataUrl) return undefined;
      response = await get(metadataUrl);
    }
    if (response.status !== 200) return undefined;
    const metadata = JSON.parse(response.body) as Record<string, unknown>;
    const resource = companyMcpUrl(metadata.resource, domain);
    if (!resource || !Array.isArray(metadata.authorization_servers) || !metadata.authorization_servers.length
      || !metadata.authorization_servers.every(server => companyMcpUrl(server, domain))) return undefined;
    // The manifest is server-owned and versioned by endpoint identity, not arbitrary agent input.
    return { name: `${domain.split('.').reverse().join('.')}/company-mcp`,
      version: createHash('sha256').update(JSON.stringify([resource.toString(), metadata.authorization_servers])).digest('hex').slice(0, 16),
      title: company.name, websiteUrl: `https://${domain}`, description: `${company.name} MCP`,
      remotes: [{ type: 'streamable-http', url: resource.toString() }], packages: [], secretInputNames: [] };
  }
}
