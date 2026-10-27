import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
const state = vi.hoisted(() => ({ answers: [{ address: '93.184.216.34', family: 4 }], status: 200,
  type: 'image/png', bytes: Buffer.alloc(0), calls: 0, lookup: undefined as any }));
vi.mock('node:dns/promises', () => ({ lookup: async () => state.answers }));
vi.mock('node:https', () => ({
  Agent: class { constructor(options: any) { state.lookup = options.lookup; } destroy() {} },
  request: (_url: URL, _options: unknown, receive: (res: any) => void) => {
    state.calls++;
    const req = new EventEmitter() as any;
    req.destroy = (error: Error) => req.emit('error', error);
    req.end = () => {
      const res = new EventEmitter() as any;
      res.statusCode = state.status; res.headers = { 'content-type': state.type }; res.resume = () => {};
      receive(res); res.emit('data', state.bytes); res.emit('end');
    };
    return req;
  },
}));
import { bundledMcpLogo, fetchMcpLogo } from './rooms-mcp-logos.js';
afterEach(() => { state.answers = [{ address: '93.184.216.34', family: 4 }]; state.status = 200; state.type = 'image/png'; state.calls = 0; });
it('rejects unsafe URL schemes and any private DNS answer before connecting', async () => {
  for (const url of ['http://example.com/a', 'file:///etc/passwd', 'https://user:password@example.com/a', 'https://example.com:8443/a'])
    await expect(fetchMcpLogo(url)).rejects.toThrow();
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1']) {
    state.answers = [{ address: '93.184.216.34', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }];
    await expect(fetchMcpLogo('https://example.com/a')).rejects.toThrow('Non-public');
  }
  expect(state.calls).toBe(0);
});
it('pins the public socket and caches decoded pixels without hotlinking', async () => {
  state.bytes = await sharp({ create: { width: 120, height: 120, channels: 4, background: 'red' } }).png().toBuffer();
  const logo = await fetchMcpLogo('https://example.com/logo');
  expect(logo).toMatch(/^data:image\/png;base64,/);
  const cb = vi.fn(); state.lookup('example.com', {}, cb); expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  const metadata = await sharp(Buffer.from(logo.split(',')[1]!, 'base64')).metadata();
  expect(metadata.width).toBe(96);
});
it('rejects redirects, active content, spoofed images and oversized responses', async () => {
  state.status = 302; await expect(fetchMcpLogo('https://example.com/a')).rejects.toThrow();
  state.status = 200; state.type = 'image/svg+xml'; await expect(fetchMcpLogo('https://example.com/a')).rejects.toThrow();
  state.type = 'image/png'; state.bytes = Buffer.from('<html>not pixels</html>'); await expect(fetchMcpLogo('https://example.com/a')).rejects.toThrow();
  state.bytes = Buffer.alloc(262145); await expect(fetchMcpLogo('https://example.com/a')).rejects.toThrow('too large');
});
it('bundles the official client marks and leaves unknown clients to the monogram', async () => {
  expect(await bundledMcpLogo('Grok')).toMatch(/^data:image\/png;base64,/);
  expect(await bundledMcpLogo('Meta Muse')).toMatch(/^data:image\/png;base64,/);
  expect(await bundledMcpLogo('Other')).toBeUndefined();
});
