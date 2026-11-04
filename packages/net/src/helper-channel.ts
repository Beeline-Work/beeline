// A chunk is at most 192 KiB even if every UTF-16 unit needs JSON escaping.
// The logical result has no byte allowance; only active requests retain parts.
const CHUNK_CHARACTERS = 32 * 1024;
export function* helperFrames(frame: Record<string, unknown>): Generator<Record<string, unknown>> {
  const encoded = JSON.stringify(frame);
  if (encoded.length <= CHUNK_CHARACTERS) { yield frame; return; }
  for (let offset = 0, index = 0; offset < encoded.length; offset += CHUNK_CHARACTERS, index++) {
    yield { type: `${frame.type}-chunk`, requestId: frame.requestId, index,
      data: encoded.slice(offset, offset + CHUNK_CHARACTERS), final: offset + CHUNK_CHARACTERS >= encoded.length };
  }
}

/** Correlation and sequence are checked before a logical frame is dispatched.
 * The authenticated machine registration still owns identity and generation. */
export class HelperFrameReader {
  private readonly parts = new Map<string, { type: string; chunks: string[] }>();
  clear(): void { this.parts.clear(); }
  discard(id: string): void { this.parts.delete(id); }
  receive(frame: Record<string, unknown>): Record<string, unknown> | undefined {
    if (typeof frame.type !== 'string' || !frame.type.endsWith('-chunk')) return frame;
    if (typeof frame.requestId !== 'string' || typeof frame.data !== 'string' ||
        typeof frame.final !== 'boolean' || !Number.isSafeInteger(frame.index) || Number(frame.index) < 0)
      throw new Error('Invalid helper chunk');
    const type = frame.type.slice(0, -6), id = frame.requestId;
    let parts = this.parts.get(id);
    if (!parts && frame.index === 0) { parts = { type, chunks: [] }; this.parts.set(id, parts); }
    if (!parts || parts.type !== type || parts.chunks.length !== frame.index) throw new Error('Helper chunk sequence changed');
    parts.chunks.push(frame.data);
    if (!frame.final) return undefined;
    this.parts.delete(id);
    const result: unknown = JSON.parse(parts.chunks.join(''));
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        (result as Record<string, unknown>).type !== type || (result as Record<string, unknown>).requestId !== id)
      throw new Error('Helper chunk identity changed');
    return result as Record<string, unknown>;
  }
}

export function sendHelperFrame(send: (frame: Record<string, unknown>) => boolean, frame: Record<string, unknown>): boolean {
  for (const part of helperFrames(frame)) if (!send(part)) return false;
  return true;
}
