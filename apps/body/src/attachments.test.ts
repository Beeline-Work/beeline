import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  attachmentPathsFromText,
  attachmentPrompt,
  canonicalizeImageForUpload,
  generatedImageCandidates,
  sanitizeActivityUpdate,
  stripAttachmentDirectives,
} from './attachments.js';

describe('Body attachment boundary', () => {
  it('projects inbound attachments as links and bounded metadata only', () => {
    const giantPayload = 'A'.repeat(2_000_000);
    const prompt = attachmentPrompt('f'.repeat(64), 'Review this', [
      {
        url: 'https://relay.example/media/large.pdf',
        name: 'large.pdf',
        mimeType: 'application/pdf',
        size: 24 * 1024 * 1024,
      },
    ]);
    expect(prompt).toContain('https://relay.example/media/large.pdf');
    expect(prompt).toContain('25165824 bytes');
    expect(prompt).not.toContain(giantPayload);
    expect(prompt.length).toBeLessThan(500);
  });

  it('attributes a Room participant by display name, handle, and stable key prefix', () => {
    expect(
      attachmentPrompt('f'.repeat(64), 'Mushroom works for me.', [], {
        kind: 'Agent',
        name: 'Joy',
        handle: 'joy',
      }),
    ).toBe('[Agent Joy (@joy) · ffffffffffff]: Mushroom works for me.');
  });

  it('extracts agent file directives and removes them from visible prose', () => {
    const text = 'Here it is. [[buzz-attachment:art/mushroom.png]] data:image/png;base64,ZmFrZQ==';
    expect(attachmentPathsFromText(text)).toEqual(['art/mushroom.png']);
    expect(stripAttachmentDirectives(text)).toBe('Here it is.\n[inline binary omitted]');
  });

  it('extracts generated ACP images while sanitizing the activity payload', () => {
    const data = Buffer.from('fake-png').toString('base64');
    const update = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'image-1',
        content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data } }],
      },
    };
    expect(generatedImageCandidates([update])).toEqual([
      expect.objectContaining({ name: 'generated-image-image-1.png', mimeType: 'image/png' }),
    ]);
    const sanitized = JSON.stringify(sanitizeActivityUpdate(update.update));
    expect(sanitized).not.toContain(data);
    expect(sanitized).toContain('binary omitted');
  });
});

/** CRC32 as PNG chunks require it — keeps the fixtures byte-faithful. */
function crc32(bytes: Uint8Array): number {
  let table = crc32Table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crc32Table = table;
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
let crc32Table: Uint32Array | undefined;

function pngChunk(name: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(12 + data.byteLength);
  const view = new DataView(body.buffer);
  view.setUint32(0, data.byteLength);
  for (let i = 0; i < 4; i += 1) body[4 + i] = name.charCodeAt(i);
  body.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(body.subarray(4, 8 + data.byteLength)));
  return body;
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function minimalPngChunks(): Uint8Array[] {
  const ihdr = new Uint8Array([0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
  const idat = new Uint8Array([
    0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x02,
  ]);
  return [pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array([]))];
}

function assemblePng(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    PNG_SIGNATURE.byteLength + chunks.reduce((t, c) => t + c.byteLength, 0),
  );
  out.set(PNG_SIGNATURE);
  let offset = PNG_SIGNATURE.byteLength;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** matplotlib/Pillow-shaped metadata: tEXt + eXIf + tIME ancillary chunks. */
function pngWithMetadata(): Uint8Array {
  return assemblePng([
    ...minimalPngChunks().slice(0, 2),
    pngChunk('tEXt', new TextEncoder().encode('Software\0matplotlib version=3.8')),
    pngChunk('eXIf', new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08])),
    pngChunk('tIME', new Uint8Array([0x07, 0xe8, 0x08, 0x17, 0x0c, 0x1d, 0x2a])),
    ...minimalPngChunks().slice(2),
  ]);
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.byteLength);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = ((payload.byteLength + 2) >> 8) & 0xff;
  out[3] = (payload.byteLength + 2) & 0xff;
  out.set(payload, 4);
  return out;
}

function assembleJpeg(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((t, p) => t + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Camera/phone-shaped JPEG: EXIF APP1 + COM comment before the frame, then a
 *  scan whose entropy data uses 0xFF 0x00 stuffing. */
function jpegWithMetadata(): Uint8Array {
  return assembleJpeg([
    new Uint8Array([0xff, 0xd8]),
    segment(0xe0, new Uint8Array([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00])),
    segment(0xe1, new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d])),
    segment(0xfe, new TextEncoder().encode('created by an agent')),
    segment(0xdb, new Uint8Array([0x00, 0x01, 0x02]).fill(0x43)),
    segment(0xda, new Uint8Array([0x01, 0x00, 0x02, 0x00, 0x00, 0x3f, 0x00])),
    new Uint8Array([0x12, 0xff, 0x00, 0x34, 0x56, 0xff, 0xd9]),
  ]);
}

describe('canonicalizeImageForUpload', () => {
  it('strips every metadata channel from a metadata-bearing agent PNG', () => {
    const dirty = pngWithMetadata();
    expect(dirty.byteLength).toBeGreaterThan(0);
    const clean = canonicalizeImageForUpload(dirty, 'image/png');
    // The output is exactly the critical-chunk-only reconstruction.
    expect(Buffer.from(clean).equals(Buffer.from(assemblePng(minimalPngChunks())))).toBe(true);
    expect(clean.byteLength).toBeLessThan(dirty.byteLength);
  });

  it('leaves an already-canonical PNG byte-identical', () => {
    const canonical = assemblePng(minimalPngChunks());
    expect(Buffer.from(canonicalizeImageForUpload(canonical, 'image/png')).equals(canonical)).toBe(
      true,
    );
  });

  it('strips EXIF APP1 and COM markers from a JPEG while keeping the scan intact', () => {
    const clean = canonicalizeImageForUpload(jpegWithMetadata(), 'image/jpeg');
    const text = Buffer.from(clean).toString('latin1');
    expect(text).not.toContain('Exif');
    expect(text).not.toContain('created by an agent');
    expect(text).not.toContain('JFIF');
    // Frame tables survive, and the stuffed 0xFF 0x00 inside the scan is preserved.
    expect(clean[2]).toBe(0xff);
    expect(clean[3]).toBe(0xdb);
    const tail = Buffer.from(clean.subarray(clean.byteLength - 7));
    expect(tail.equals(Buffer.from([0x12, 0xff, 0x00, 0x34, 0x56, 0xff, 0xd9]))).toBe(true);
    expect(clean[clean.byteLength - 1]).toBe(0xd9);
  });

  it('sniffs PNG bytes when the agent hands over no recognizable image extension', () => {
    const dirty = pngWithMetadata();
    const clean = canonicalizeImageForUpload(dirty, 'application/octet-stream');
    expect(Buffer.from(clean).equals(Buffer.from(assemblePng(minimalPngChunks())))).toBe(true);
  });

  it('passes non-image payloads through untouched', () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(Buffer.from(canonicalizeImageForUpload(pdf, 'application/pdf')).equals(pdf)).toBe(true);
  });

  it('fails open on unparseable image bytes so the upload decides, as before', () => {
    const truncated = assemblePng(minimalPngChunks()).subarray(0, 20);
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(
      Buffer.from(canonicalizeImageForUpload(truncated, 'image/png')).equals(truncated),
    ).toBe(true);
    expect(
      Buffer.from(canonicalizeImageForUpload(garbage, 'image/png')).equals(garbage),
    ).toBe(true);
    const headlessJpeg = new Uint8Array([0x00, 0x01, 0xff, 0xd8, 0x00, 0x00]);
    expect(
      Buffer.from(canonicalizeImageForUpload(headlessJpeg, 'image/jpeg')).equals(headlessJpeg),
    ).toBe(true);
  });
});

describe('the daemon upload path canonicalizes before upload (source assertion)', () => {
  it('uploadAgentOutputs strips image metadata before client.uploadMedia', async () => {
    const bodySource = await readFile(new URL('./body.ts', import.meta.url), 'utf8');
    const uploadBlock = bodySource.match(/candidateBytes\(session, candidate\);[\s\S]{0,600}?client\.uploadMedia/);
    expect(uploadBlock?.[0]).toContain('canonicalizeImageForUpload(');
    expect(uploadBlock![0].indexOf('canonicalizeImageForUpload(')).toBeLessThan(
      uploadBlock![0].indexOf('client.uploadMedia'),
    );
  });
});
