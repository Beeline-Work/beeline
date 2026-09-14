import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MIME_TYPES,
  isArtifactMime,
  sha256Hex,
  uploadObject,
  type CreateUploadRequest,
  type CreateUploadResult,
  type FinalizeUploadRequest,
  type FinalizeUploadResult,
  type UploadGateClient,
} from './artifacts.js';

class FakeGate implements UploadGateClient {
  readonly createCalls: CreateUploadRequest[] = [];
  readonly finalizeCalls: FinalizeUploadRequest[] = [];
  /** Captured by rewriting the signed POST url onto a local receiver. */
  constructor(
    private readonly receive: (url: string, init: RequestInit) => Response | Promise<Response>,
    private readonly state: 'ready' | 'pending' = 'ready',
  ) {}
  async createUpload(request: CreateUploadRequest): Promise<CreateUploadResult> {
    this.createCalls.push(request);
    return { objectId: 'obj-1', url: 'https://storage.example/presigned-post', fields: { policy: 'p', 'x-amz-signature': 's' } };
  }
  async finalizeUpload(request: FinalizeUploadRequest): Promise<FinalizeUploadResult> {
    this.finalizeCalls.push(request);
    return { objectId: request.objectId, state: this.state };
  }
}

describe('artifact contract constants', () => {
  it('caps artifacts at 2 MB and names the four plan mime types', () => {
    expect(ARTIFACT_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect([...ARTIFACT_MIME_TYPES]).toEqual([
      'text/html',
      'image/svg+xml',
      'application/pdf',
      'text/markdown',
    ]);
  });

  it('isArtifactMime accepts exactly the plan vocabulary', () => {
    for (const mime of ARTIFACT_MIME_TYPES) expect(isArtifactMime(mime)).toBe(true);
    expect(isArtifactMime('text/plain')).toBe(false);
    expect(isArtifactMime(42)).toBe(false);
  });
});

describe('uploadObject', () => {
  it('hashes the bytes, POSTs the policy fields plus the file, and finalizes', async () => {
    const bodies: string[] = [];
    const gate = new FakeGate(async (_url, init) => {
      const form = init.body as FormData;
      expect(form.get('policy')).toBe('p');
      expect(form.get('x-amz-signature')).toBe('s');
      const file = form.get('file') as File;
      bodies.push(file.name);
      expect(await file.text()).toBe('hello artifact');
      return new Response(null, { status: 204 });
    });
    const fetchCalls: { url: string; init: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return gate.receive(String(url), init ?? {});
    }) as typeof fetch;
    try {
      const bytes = new TextEncoder().encode('hello artifact');
      const result = await uploadObject(gate, bytes, { kind: 'media', mime: 'text/html' });
      expect(result.objectId).toBe('obj-1');
      expect(result.sha256).toBe(sha256Hex(bytes));
      expect(gate.createCalls).toEqual([
        { kind: 'media', mime: 'text/html', size: 14, sha256: result.sha256 },
      ]);
      expect(gate.finalizeCalls).toEqual([{ objectId: 'obj-1' }]);
      expect(bodies).toEqual(['blob']);
      expect(fetchCalls.map((call) => call.url)).toEqual(['https://storage.example/presigned-post']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('propagates a refused storage POST and never finalizes', async () => {
    const gate = new FakeGate(() => new Response('forbidden', { status: 403 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as typeof fetch;
    try {
      await expect(
        uploadObject(gate, new TextEncoder().encode('x'), { kind: 'artifact', mime: 'text/html' }),
      ).rejects.toThrow('object upload failed (403)');
      expect(gate.finalizeCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses an upload that did not finalize ready', async () => {
    const gate = new FakeGate(() => new Response(null, { status: 204 }), 'pending');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    try {
      await expect(
        uploadObject(gate, new TextEncoder().encode('x'), { kind: 'media', mime: 'image/png' }),
      ).rejects.toThrow('did not finalize');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
