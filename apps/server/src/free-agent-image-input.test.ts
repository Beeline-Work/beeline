import { afterEach, describe, expect, it, vi } from 'vitest';
import { freeAgentModelTakesImages, imageInput, withoutImageData, IMAGE_TOKEN_RESERVATION } from './free-agent-image-input.js';

const body = (url: string) => ({ messages: [{ content: [{ type: 'image_url', image_url: { url } }] }] });
afterEach(() => vi.unstubAllGlobals());

describe('free agent image input', () => {
  it('reads and caches advertised modalities for the pinned model without model-id rules', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: { architecture: { input_modalities: ['file', 'image', 'text'] } } }));
    vi.stubGlobal('fetch', fetcher);
    expect(await freeAgentModelTakesImages('provider/new-image-model')).toBe(true);
    expect(await freeAgentModelTakesImages('provider/new-image-model')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(Response.json({ data: { architecture: { input_modalities: ['text'] } } }));
    expect(await freeAgentModelTakesImages('provider/text-model')).toBe(false);
    fetcher.mockRejectedValue(new Error('offline'));
    expect(await freeAgentModelTakesImages('provider/unavailable')).toBe(false);
  });

  it('bounds aggregate embedded image bytes and image count; rejects other binary parts', () => {
    expect(() => imageInput(body('data:image/jpeg;base64,' + Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64')), true)).toThrow('too large');
    const many = { messages: [{ content: Array(9).fill({ type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } }) }] };
    expect(() => imageInput(many, true)).toThrow('too large');
    expect(() => imageInput({ messages: [{ content: [{ type: 'input_audio' }] }] }, true)).toThrow();
    expect(() => imageInput(body('http://example.com/photo.jpg'), true)).toThrow();
    expect(() => imageInput(body('data:text/plain;base64,AAAA'), true)).toThrow();
    expect(() => imageInput(body('https://example.com/photo.jpg'), false)).toThrow();
  });

  it('reserves image tokens independently of binary transport size without retaining binary text', () => {
    const photo = body('data:image/jpeg;base64,' + Buffer.alloc(200_000).toString('base64'));
    expect(imageInput(photo, true)).toBe(IMAGE_TOKEN_RESERVATION);
    expect(JSON.stringify(withoutImageData(photo)).length).toBeLessThan(100);
  });
});
