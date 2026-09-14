import { describe, expect, it } from 'vitest';
import { sha256Hex, uploadObject, type UploadGateClient } from './upload-object.js';
import type { CreateUploadResult, FinalizeUploadResult } from './artifacts.js';

class FakeGate implements UploadGateClient {
  readonly createCalls: unknown[] = [];
  readonly finalizeCalls: { objectId: string }[] = [];
  constructor(
    private readonly deduped: boolean = false,
    private readonly state: 'ready' | 'pending' = 'ready',
  ) {}
  async createUpload(input: {
    kind: string;
    mimeType: string;
    size: number;
    sha256: string;
    title?: string;
  }): Promise<CreateUploadResult> {
    this.createCalls.push(input);
    if (this.deduped) {
      return {
        objectId: 'obj-1',
        deduped: true,
        url: '/v1/media/obj-1',
        expiresAt: Date.now() + 3_600_000,
      };
    }
    return {
      objectId: 'obj-1',
      deduped: false,
      url: '/v1/media/obj-1',
      upload: {
        url: 'https://storage.example/presigned-post',
        fields: { policy: 'p', 'x-amz-signature': 's' },
      },
      expiresAt: Date.now() + 3_600_000,
    };
  }
  async finalizeUpload(input: { objectId: string }): Promise<FinalizeUploadResult> {
    this.finalizeCalls.push(input);
    return { state: this.state };
  }
}

describe('uploadObject', () => {
  it('hashes the bytes, POSTs the policy fields plus the file, and finalizes', async () => {
    const gate = new FakeGate();
    const fetchCalls: { url: string; init: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      const form = init?.body as FormData;
      expect(form.get('policy')).toBe('p');
      expect(form.get('x-amz-signature')).toBe('s');
      const file = form.get('file') as File;
      expect(await file.text()).toBe('hello artifact');
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      const bytes = new TextEncoder().encode('hello artifact');
      const result = await uploadObject(gate, bytes, { kind: 'media', mimeType: 'text/html' });
      expect(result.objectId).toBe('obj-1');
      expect(result.url).toBe('/v1/media/obj-1');
      expect(result.sha256).toBe(sha256Hex(bytes));
      expect(gate.createCalls).toEqual([
        { kind: 'media', mimeType: 'text/html', size: 14, sha256: result.sha256, title: undefined },
      ]);
      expect(gate.finalizeCalls).toEqual([{ objectId: 'obj-1' }]);
      expect(fetchCalls.map((call) => call.url)).toEqual(['https://storage.example/presigned-post']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('skips the upload and finalize round trips when the server dedupes', async () => {
    const gate = new FakeGate(true);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('fetch must not be called on a dedupe');
    }) as typeof fetch;
    try {
      const result = await uploadObject(gate, new TextEncoder().encode('x'), {
        kind: 'artifact',
        mimeType: 'text/html',
      });
      expect(result).toEqual({ objectId: 'obj-1', url: '/v1/media/obj-1', sha256: sha256Hex(new TextEncoder().encode('x')) });
      expect(gate.finalizeCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('propagates a refused storage POST and never finalizes', async () => {
    const gate = new FakeGate();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as typeof fetch;
    try {
      await expect(
        uploadObject(gate, new TextEncoder().encode('x'), { kind: 'artifact', mimeType: 'text/html' }),
      ).rejects.toThrow('object upload failed (403)');
      expect(gate.finalizeCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses an upload that did not finalize ready', async () => {
    const gate = new FakeGate(false, 'pending');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    try {
      await expect(
        uploadObject(gate, new TextEncoder().encode('x'), { kind: 'media', mimeType: 'image/png' }),
      ).rejects.toThrow('did not finalize');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
