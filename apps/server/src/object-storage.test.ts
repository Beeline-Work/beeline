import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectStorage } from './object-storage.js';

// Fixed clock: every signed date and policy expiration below derives from it.
const FIXED_NOW = Date.parse('2026-09-14T12:00:00.000Z');

const config = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  endpoint: 'https://fly.storage.tigris.dev',
  bucket: 'beeline-objects',
  region: 'auto',
};

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest('hex') as unknown as Buffer;
}

describe('object-storage golden signatures (fixed clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('presignPost signs the base64 policy with the derived signing key', () => {
    const storage = new ObjectStorage(config, { now: () => FIXED_NOW });
    const { url, fields } = storage.presignPost('artifact/agent1/abc', {
      contentType: 'text/html',
      size: 1024,
      expiresIn: 600,
    });

    expect(url).toBe('https://fly.storage.tigris.dev/beeline-objects');
    expect(fields.key).toBe('artifact/agent1/abc');
    expect(fields['Content-Type']).toBe('text/html');
    expect(fields['x-amz-algorithm']).toBe('AWS4-HMAC-SHA256');
    expect(fields['x-amz-date']).toBe('20260914T120000Z');
    expect(fields['x-amz-credential']).toBe(
      'AKIDEXAMPLE/20260914/auto/s3/aws4_request',
    );

    // Recompute the policy and its signature independently: the policy pins
    // the exact content-length-range and expires ten minutes after the clock.
    const policy = JSON.parse(Buffer.from(fields.policy, 'base64').toString('utf8'));
    expect(policy.expiration).toBe('2026-09-14T12:10:00.000Z');
    expect(policy.conditions).toContainEqual(['content-length-range', 1024, 1024]);
    expect(policy.conditions).toContainEqual({ key: 'artifact/agent1/abc' });
    expect(policy.conditions).toContainEqual({ 'Content-Type': 'text/html' });

    const kDate = createHmac('sha256', `AWS4${config.secretAccessKey}`)
      .update('20260914')
      .digest();
    const kRegion = createHmac('sha256', kDate).update('auto').digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const expected = createHmac('sha256', kSigning).update(fields.policy).digest('hex');
    expect(fields['x-amz-signature']).toBe(expected);
  });

  it('presignGet signs the query and carries response-content-disposition inside the signature', async () => {
    const storage = new ObjectStorage(config, { now: () => FIXED_NOW });
    const url = new URL(
      await storage.presignGet('artifact/agent1/abc', {
        expiresIn: 600,
        responseContentDisposition: 'inline; filename="mock.html"',
        responseContentType: 'text/html',
      }),
    );

    expect(url.origin + url.pathname).toBe(
      'https://fly.storage.tigris.dev/beeline-objects/artifact/agent1/abc',
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'inline; filename="mock.html"',
    );
    expect(url.searchParams.get('response-content-type')).toBe('text/html');

    // Recompute the SigV4 query signature over the exact signed header set.
    const signedHeaders = 'host';
    const canonicalHeaders = 'host:fly.storage.tigris.dev\n';
    const payloadHash = 'UNSIGNED-PAYLOAD';
    const canonicalParams = [...url.searchParams.entries()]
      .filter(([k]) => k !== 'X-Amz-Signature')
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`)
      .join('&');
    const canonicalRequest = [
      'GET',
      '/beeline-objects/artifact/agent1/abc',
      canonicalParams,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = '20260914/auto/s3/aws4_request';
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      '20260914T120000Z',
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const kDate = createHmac('sha256', `AWS4${config.secretAccessKey}`)
      .update('20260914')
      .digest();
    const kRegion = createHmac('sha256', kDate).update('auto').digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const expected = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    expect(url.searchParams.get('X-Amz-Signature')).toBe(expected);
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIDEXAMPLE/20260914/auto/s3/aws4_request',
    );
  });

  it('maps get, head and delete: 404 is null/success, other errors surface', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: { method?: string }) => {
      if (init?.method === 'HEAD')
        return new Response(null, {
          status: 200,
          headers: { 'content-length': '2048', etag: '"etag-1"' },
        });
      if (init?.method === 'GET') return new Response(Buffer.from('bytes'), { status: 200 });
      return new Response(null, { status: 204 });
    });
    const storage = new ObjectStorage(config, { now: () => FIXED_NOW, fetch: fetchMock as never });
    await expect(storage.headObject('k')).resolves.toEqual({ size: 2048, etag: '"etag-1"' });
    await expect(storage.getObject('k')).resolves.toEqual(new Uint8Array(Buffer.from('bytes')));
    await expect(storage.deleteObject('k')).resolves.toBeUndefined();

    const missing = new ObjectStorage(config, {
      now: () => FIXED_NOW,
      fetch: (async () => new Response(null, { status: 404 })) as never,
    });
    await expect(missing.headObject('k')).resolves.toBeNull();
    await expect(missing.getObject('k')).resolves.toBeNull();
    await expect(missing.deleteObject('k')).resolves.toBeUndefined();

    const failing = new ObjectStorage(config, {
      now: () => FIXED_NOW,
      fetch: (async () => new Response(null, { status: 500 })) as never,
    });
    await expect(failing.headObject('k')).rejects.toThrow('HTTP 500');
    await expect(failing.getObject('k')).rejects.toThrow('HTTP 500');
    await expect(failing.deleteObject('k')).rejects.toThrow('HTTP 500');
  });
});

it('real AWS retry backoff cannot extend the outside-service deadline', async () => {
  const { createServer } = await import('node:http');
  const controller = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  vi.spyOn(Math, 'random').mockReturnValue(1);
  let requests = 0;
  let received!: () => void;
  const firstRequest = new Promise<void>(resolve => { received = resolve; });
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(429);
    response.end('retry');
    received();
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const storage = new ObjectStorage({ ...config,
      endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    let settled = false;
    const request = storage.putObject('deadline-proof', new Uint8Array([1]), 'text/plain');
    const checked = expect(request).rejects.toThrow('result is unknown').then(() => { settled = true; });
    await firstRequest;
    // Let AwsClient enter its real randomized retry sleep, then expire the
    // original deadline. Its sleep does not listen to the abort signal.
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort(new DOMException('deadline', 'TimeoutError'));
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(true);
    await checked;
    // Let the SDK's first sleep finish: an aborted retry must never reach HTTP.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(requests).toBe(1);
  } finally {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});
