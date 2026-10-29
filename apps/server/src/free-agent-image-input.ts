/** Public model metadata, keyed by the server-pinned model, never caller input. */
const models = new Map<string, { expires: number; images: boolean }>();

export async function freeAgentModelTakesImages(model: string): Promise<boolean> {
  const cached = models.get(model);
  if (cached && cached.expires > Date.now()) return cached.images;
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const payload = await response.json() as { data?: { architecture?: { input_modalities?: unknown } } };
    const input = payload.data?.architecture?.input_modalities;
    const images = Array.isArray(input) && input.includes('image');
    if (models.size >= 100) models.clear();
    models.set(model, { expires: Date.now() + 5 * 60_000, images });
    return images;
  } catch {
    return false;
  }
}

export const IMAGE_TOKEN_RESERVATION = 131_072;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 8;

/** Images reserve a conservative fixed input estimate; settlement uses provider usage.
 * A remote URL is forwarded, never fetched by the server. The wire-body cap still applies. */
export function imageInput(body: Record<string, unknown>, acceptsImages: boolean): number {
  let count = 0;
  let bytes = 0;
  for (const message of (Array.isArray(body.messages) ? body.messages : []) as Array<{ content?: unknown }>) {
    if (!message || typeof message !== 'object') throw new Error('invalid message');
    const content = message.content;
    if (!Array.isArray(content)) {
      if (typeof content === 'string' && /data:[^\s,]+;base64,[a-z0-9+/=]{64}/i.test(content))
        throw new Error('free agent model requests do not support inline binary data');
      continue;
    }
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        if (/data:[^\s,]+;base64,[a-z0-9+/=]{64}/i.test(part.text))
          throw new Error('free agent model requests do not support inline binary data');
        continue;
      }
      if (!acceptsImages || part?.type !== 'image_url')
        throw new Error('free agent model requests support text content only for this model');
      if (Object.keys(part).some(key => !['type', 'image_url'].includes(key)) ||
          !part.image_url || typeof part.image_url !== 'object' ||
          Object.keys(part.image_url).some(key => !['url', 'detail'].includes(key)) ||
          (part.image_url.detail !== undefined && !['auto', 'low', 'high'].includes(part.image_url.detail)))
        throw new Error('invalid image part');
      const url = part.image_url?.url;
      if (typeof url !== 'string') throw new Error('invalid image URL');
      if (url.startsWith('data:')) {
        const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([a-z0-9+/]*={0,2})$/i.exec(url);
        if (!match || !match[1] || match[1].length % 4 !== 0) throw new Error('invalid image data URI');
        bytes += Buffer.from(match[1], 'base64').length;
      } else {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('invalid image URL');
      }
      if (++count > MAX_IMAGES || bytes > MAX_IMAGE_BYTES) throw new Error('image input too large');
    }
  }
  return count * IMAGE_TOKEN_RESERVATION;
}

/** Binary strings are not text tokens. Retain structure for the text bound. */
export function withoutImageData(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, messages: Array.isArray(body.messages) ? body.messages.map(message =>
    message && Array.isArray(message.content) ? { ...message, content: message.content.map((part: { type?: string }) =>
      part?.type === 'image_url' ? { type: 'image_url' } : part) } : message) : body.messages };
}
