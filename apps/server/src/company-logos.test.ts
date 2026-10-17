import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn(), agents: [] as any[] }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({
  Agent: class { constructor(options: unknown) { mocks.agents.push(options); } destroy() {} }, get: mocks.get,
}));
import { companyLogo, publicIconResponse, readCompanyLogo } from './company-logos.js';
import { COMPANY_MARK_IDS } from './company-registry.js';
beforeEach(() => { vi.clearAllMocks(); mocks.agents.length = 0; mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]); });
function response(body: Buffer | string, mime = 'image/png', status = 200, location?: string) {
  mocks.get.mockImplementationOnce((_url, _options, callback) => {
    const req = new EventEmitter(); const res = Object.assign(new EventEmitter(), { headers: { 'content-type': mime, location }, statusCode: status });
    queueMicrotask(() => { callback(res); res.emit('data', Buffer.from(body)); res.emit('end'); }); return req;
  });
}
describe('server company logos', () => {
  it('serves every built-in mark from its shipped asset without external IO', async () => {
    for (const id of COMPANY_MARK_IDS) { const icon = await readCompanyLogo(id); expect(icon?.mime).toBe('image/png'); expect((await sharp(icon!.bytes).metadata()).width).toBe(64); }
    expect(mocks.get).not.toHaveBeenCalled();
    expect(companyLogo({ id: 'sentry', name: 'Sentry', domain: 'sentry.io', hosts: [] }, 'https://api')).toMatchObject({ kind: 'image', uri: 'https://api/v1/company-logos/sentry' });
    expect(companyLogo({ id: 'other', name: 'Other', hosts: [] }, '')).toEqual({ kind: 'monogram' });
  });
  it('rejects private, loopback, link-local, mapped and mixed DNS answers before opening a socket', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '2001:db8::1']) {
      mocks.lookup.mockResolvedValueOnce([{ address, family: address.includes(':') ? 6 : 4 }]);
      await expect(publicIconResponse(new URL('https://site.example/icon'))).rejects.toThrow('non-public');
    }
    mocks.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.2', family: 4 }]);
    await expect(publicIconResponse(new URL('https://site.example/icon'))).rejects.toThrow('non-public'); expect(mocks.get).not.toHaveBeenCalled();
  });
  it('rejects protocols, ports, credentials, IP literals and exhausted deadlines', async () => {
    for (const url of ['http://site.example/icon', 'https://site.example:444/icon', 'https://user:pass@site.example/icon', 'https://127.0.0.1/icon'])
      await expect(publicIconResponse(new URL(url))).rejects.toThrow('invalid');
    await expect(publicIconResponse(new URL('https://site.example'), 0, Date.now() - 1)).rejects.toThrow('timeout'); expect(mocks.get).not.toHaveBeenCalled();
  });
  it('pins vetted DNS and independently rejects a private redirect destination', async () => {
    response('', 'text/html', 302, 'https://internal.example/icon'); mocks.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    await expect(publicIconResponse(new URL('https://site.example'))).rejects.toThrow('non-public');
    const callback = vi.fn(); mocks.agents[0].lookup('site.example', {}, callback); expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4); expect(mocks.get).toHaveBeenCalledTimes(1);
  });
  it('discovers the company icon, rasterizes it, coalesces requests and caches the result', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#123456' } }).png().toBuffer();
    response('<link rel="icon" href="/mark.png">', 'text/html'); response(png);
    const [a, b] = await Promise.all([readCompanyLogo('fresh.example'), readCompanyLogo('fresh.example')]);
    expect(a?.mime).toBe('image/png'); expect(a).toBe(b); expect(await readCompanyLogo('fresh.example')).toBe(a); expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.get.mock.calls[1]?.[0].pathname).toBe('/mark.png');
  });
  it('negative-caches unavailable site icons without issuing repeated requests', async () => {
    mocks.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    expect(await readCompanyLogo('unavailable.example')).toBeUndefined(); const calls = mocks.lookup.mock.calls.length;
    expect(await readCompanyLogo('unavailable.example')).toBeUndefined(); expect(mocks.lookup).toHaveBeenCalledTimes(calls);
    expect(await readCompanyLogo('../sentry')).toBeUndefined();
  });
});
