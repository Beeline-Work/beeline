import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), agents: [] as any[] }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ Agent: class { constructor(options: unknown) { mocks.agents.push(options); } destroy() {} }, request: mocks.request }));
import { CompanyMcpDiscovery, companyForMcp, companyMcpResponse, companyMcpUrl } from './company-mcp-discovery.js';
import { McpRegistryClient } from './mcp-registry.js';
const metadata = { resource: 'https://mcp.fly.io', authorization_servers: ['https://fly.io/mcp/oauth'] };
const good = { status: 200, body: JSON.stringify(metadata) };
beforeEach(() => { vi.clearAllMocks(); mocks.agents.length = 0; mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]); });
describe('company-hosted MCP discovery', () => {
  it('recognizes company subdomains without accepting lookalike suffixes or credentials', () => {
    expect(companyForMcp('https://mcp.fly.io')?.id).toBe('fly');
    expect(companyForMcp('https://mcp.sentry.io/mcp')?.id).toBe('sentry');
    for (const value of ['https://mcp.fly.io.evil.test', 'https://evilfly.io', 'https://user:pass@mcp.fly.io', 'https://127.0.0.1']) {
      expect(companyForMcp(value)).toBeUndefined();
    }
  });
  it('discovers Fly on its own domain, coalesces and caches positive and negative probes', async () => {
    const transport = vi.fn(async () => good);
    const discovery = new CompanyMcpDiscovery(transport);
    const [a, b] = await Promise.all([discovery.discover('fly'), discovery.discover('Fly.io')]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ name: 'io.fly/company-mcp', title: 'Fly.io', websiteUrl: 'https://fly.io',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.fly.io/' }] });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0].toString()).toBe('https://mcp.fly.io/.well-known/oauth-protected-resource');
    await discovery.discover('fly'); expect(transport).toHaveBeenCalledTimes(1);
    const absent = vi.fn(async () => ({ status: 404, body: '' }));
    const negative = new CompanyMcpDiscovery(absent);
    await negative.discover('fly'); await negative.discover('fly'); expect(absent).toHaveBeenCalledTimes(2);
    await negative.discover('anything.internal'); await negative.discover('fly.evil'); expect(absent).toHaveBeenCalledTimes(2);
  });
  it('uses the standard authentication challenge metadata location when the well-known document is absent', async () => {
    const transport = vi.fn().mockResolvedValueOnce({ status: 404, body: '' })
      .mockResolvedValueOnce({ status: 401, body: '', challenge: 'Bearer resource_metadata="https://mcp.fly.io/.well-known/oauth-protected-resource/mcp"' })
      .mockResolvedValueOnce(good);
    expect(await new CompanyMcpDiscovery(transport).discover('fly')).toBeDefined();
    expect(transport.mock.calls[1]?.[3]).toBe('POST');
    expect(transport.mock.calls[2]?.[0].pathname).toBe('/.well-known/oauth-protected-resource/mcp');
  });
  it('rejects off-domain redirects, resource identities and authorization servers', async () => {
    for (const response of [
      { status: 302, body: '', location: 'https://internal.example/metadata' },
      { status: 200, body: JSON.stringify({ ...metadata, resource: 'https://127.0.0.1' }) },
      { status: 200, body: JSON.stringify({ ...metadata, authorization_servers: ['https://evil.test'] }) },
      { status: 200, body: '{}' },
    ]) {
      const transport = vi.fn(async () => response);
      expect(await new CompanyMcpDiscovery(transport).discover('fly')).toBeUndefined();
      expect(transport).toHaveBeenCalledTimes(1);
    }
    for (const url of ['http://mcp.fly.io', 'https://u:p@mcp.fly.io', 'https://mcp.fly.io:444', 'https://mcp.fly.io.evil.test', 'https://mcp.fly.io/#fragment'])
      expect(companyMcpUrl(url, 'fly.io')).toBeUndefined();
  });
  it('revalidates a server-owned company manifest and rejects changed identities and arbitrary selections', async () => {
    const transport = vi.fn(async () => good);
    const companies = new CompanyMcpDiscovery(transport);
    const registry = new McpRegistryClient(vi.fn(), undefined, companies);
    const manifest = (await companies.discover('fly'))!;
    expect(await registry.selected(manifest.name, manifest.version)).toEqual(manifest);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await registry.selected('local.internal/company-mcp', manifest.version)).toBeUndefined();
    transport.mockResolvedValueOnce({ status: 200, body: JSON.stringify({ ...metadata, resource: 'https://mcp.fly.io/new' }) });
    expect(await registry.selected(manifest.name, manifest.version)).toBeUndefined();
  });
  it('expires discovery results and limits concurrent probes', async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn(async () => good);
      const discovery = new CompanyMcpDiscovery(transport);
      await discovery.discover('fly'); vi.advanceTimersByTime(600_001); await discovery.discover('fly');
      expect(transport).toHaveBeenCalledTimes(2);
      const stalled = new CompanyMcpDiscovery(async () => new Promise(() => {}));
      void stalled.discover('fly'); void stalled.discover('sentry'); void stalled.discover('stripe'); void stalled.discover('linear');
      expect(await stalled.discover('notion')).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});
describe('company MCP network boundary', () => {
  it('rejects private, mixed, mapped, link-local and tailnet DNS before opening a socket', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', '2001:db8::1']) {
      mocks.lookup.mockResolvedValueOnce([{ address, family: address.includes(':') ? 6 : 4 }]);
      await expect(companyMcpResponse(new URL('https://mcp.fly.io'), 'fly.io', Date.now() + 1000)).rejects.toThrow('Non-public');
    }
    mocks.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.2', family: 4 }]);
    await expect(companyMcpResponse(new URL('https://mcp.fly.io'), 'fly.io', Date.now() + 1000)).rejects.toThrow('Non-public');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('pins the validated public address and bounds response bytes', async () => {
    mocks.request.mockImplementation((_url, _options, callback) => {
      const req = Object.assign(new EventEmitter(), { end() {}, destroy(error: Error) { this.emit('error', error); } });
      const res = Object.assign(new EventEmitter(), { headers: {}, statusCode: 200 });
      queueMicrotask(() => { callback(res); res.emit('data', Buffer.alloc(65537)); res.emit('end'); });
      return req;
    });
    await expect(companyMcpResponse(new URL('https://mcp.fly.io'), 'fly.io', Date.now() + 1000)).rejects.toThrow('too large');
    const callback = vi.fn(); mocks.agents[0].lookup('mcp.fly.io', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });
  it('bounds a stalled DNS lookup within the search deadline', async () => {
    mocks.lookup.mockImplementation(() => new Promise(() => {}));
    const keepAlive = setTimeout(() => {}, 100);
    try { await expect(companyMcpResponse(new URL('https://mcp.fly.io'), 'fly.io', Date.now() + 10)).rejects.toThrow('timed out'); }
    finally { clearTimeout(keepAlive); }
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
