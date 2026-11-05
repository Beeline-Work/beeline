import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectStorage } from './object-storage.js';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const KEY = 'artifact/synthetic-owner/synthetic-digest';
const BODY = new Uint8Array([0, 1, 2, 255]);
const CONFIG = {
  accessKeyId: 'synthetic-access',
  secretAccessKey: 'synthetic-secret',
  endpoint: 'https://objects.example.test',
  bucket: 'proof-bucket',
  region: 'auto',
};

type Method = 'PUT' | 'HEAD' | 'GET' | 'DELETE';
const METHODS: readonly Method[] = ['PUT', 'HEAD', 'GET', 'DELETE'];
function operation(storage: ObjectStorage, method: Method): Promise<unknown> {
  switch (method) {
    case 'PUT': return storage.putObject(KEY, BODY, 'application/octet-stream');
    case 'HEAD': return storage.headObject(KEY);
    case 'GET': return storage.getObject(KEY);
    case 'DELETE': return storage.deleteObject(KEY);
  }
}

describe('object storage admits one actual SDK transport attempt', () => {
  beforeEach(() => {
    // Keep the next-turn barrier real while advancing every retry/loop timer.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    // If status retries return, their backoff must advance deterministically.
    vi.spyOn(Math, 'random').mockReturnValue(1);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(METHODS.flatMap(method => [429, 503].map(status => ({ method, status }))))(
    '$method surfaces HTTP $status after one signed request and never retries on elapsed time',
    async ({ method, status }) => {
      let received!: () => void;
      const firstRequest = new Promise<void>(resolve => { received = resolve; });
      const requests: Request[] = [];
      const transport = vi.fn(async (input: RequestInfo | URL) => {
        // ObjectStorageOptions.fetch replaces AwsClient.fetch entirely. Stub
        // the underlying global instead so the real SDK signs and dispatches.
        expect(input).toBeInstanceOf(Request);
        requests.push(input as Request);
        received();
        return new Response(null, { status });
      });
      vi.stubGlobal('fetch', transport);
      const storage = new ObjectStorage(CONFIG);
      let settled = false;
      const outcome = operation(storage, method).then(
        () => { settled = true; return undefined; },
        error => { settled = true; return error; },
      );
      await firstRequest;
      // A returned failure ends this attempt without waiting for any backoff.
      await nextTurn();
      expect(settled).toBe(true);
      await vi.advanceTimersByTimeAsync(DAY_MS);
      const error: unknown = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`HTTP ${status}`);
      expect(transport).toHaveBeenCalledTimes(1);
      const request = requests[0];
      expect(request.url).toBe(`${CONFIG.endpoint}/${CONFIG.bucket}/${KEY}`);
      expect(request.method).toBe(method);
      expect(request.headers.get('authorization')).toContain(
        'AWS4-HMAC-SHA256 Credential=synthetic-access/20261102/auto/s3/aws4_request',
      );
      expect(request.headers.get('x-amz-date')).toBe('20261102T120000Z');
      if (method === 'PUT') {
        expect(request.headers.get('content-type')).toBe('application/octet-stream');
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(BODY);
      }
    },
  );

  it.each(METHODS)('%s preserves an uncertain network rejection without another attempt', async method => {
    let received!: () => void;
    const firstRequest = new Promise<void>(resolve => { received = resolve; });
    const failure = new TypeError('synthetic connection lost after dispatch');
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      expect(input).toBeInstanceOf(Request);
      received();
      throw failure;
    });
    vi.stubGlobal('fetch', transport);
    const storage = new ObjectStorage(CONFIG);
    const outcome = operation(storage, method).then(() => undefined, error => error);
    await firstRequest;
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(await outcome).toBe(failure);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
