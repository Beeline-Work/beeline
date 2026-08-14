const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);

function readChunkLength(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function chunkName(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset + 4]!,
    bytes[offset + 5]!,
    bytes[offset + 6]!,
    bytes[offset + 7]!,
  );
}

/**
 * Relay avatar storage accepts canonical PNG containers only. Expo's image
 * manipulator can retain ancillary color, time, and text chunks even after a
 * crop. Keep the lossless image chunks and drop every metadata channel.
 */
export function canonicalizePng(bytes: Uint8Array): Uint8Array {
  if (
    bytes.byteLength < PNG_SIGNATURE.byteLength ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
  ) {
    throw new Error('Image conversion did not produce a valid PNG image.');
  }

  const chunks: Uint8Array[] = [bytes.slice(0, PNG_SIGNATURE.byteLength)];
  let offset = PNG_SIGNATURE.byteLength;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = readChunkLength(bytes, offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) {
      throw new Error('Image conversion produced a malformed PNG image.');
    }
    const name = chunkName(bytes, offset);
    if (name === 'IHDR') sawHeader = true;
    if (name === 'IDAT') sawImageData = true;
    if (name === 'IEND') sawEnd = true;
    if (PNG_CRITICAL_CHUNKS.has(name)) chunks.push(bytes.slice(offset, end));
    offset = end;
    if (name === 'IEND') break;
  }
  if (!sawHeader || !sawImageData || !sawEnd) {
    throw new Error('Image conversion produced an incomplete PNG image.');
  }

  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const canonical = new Uint8Array(byteLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    canonical.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  return canonical;
}

export const canonicalizeAvatarPng = canonicalizePng;

/**
 * Keep JPEG rendering data while removing every descriptive metadata channel.
 * Expo's native encoder may emit APP markers even when the picker was opened
 * with `exif: false`; that option only controls picker result metadata.
 */
export function canonicalizeJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Image conversion did not produce a valid JPEG image.');
  }

  const parts: Uint8Array[] = [bytes.slice(0, 2)];
  let offset = 2;
  let inScan = false;
  let sawEnd = false;
  while (offset < bytes.byteLength) {
    if (inScan && bytes[offset] !== 0xff) {
      const start = offset;
      while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1;
      parts.push(bytes.slice(start, offset));
      continue;
    }
    if (bytes[offset] !== 0xff) {
      throw new Error('Image conversion produced a malformed JPEG image.');
    }

    const markerStart = offset;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) {
      throw new Error('Image conversion produced a malformed JPEG image.');
    }
    const marker = bytes[offset]!;
    offset += 1;

    if (inScan && marker === 0x00) {
      parts.push(bytes.slice(markerStart, offset));
      continue;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(bytes.slice(markerStart, offset));
      continue;
    }
    if (marker === 0xd9) {
      if (offset !== bytes.byteLength) {
        throw new Error('Image conversion produced a malformed JPEG image.');
      }
      parts.push(bytes.slice(markerStart, offset));
      sawEnd = true;
      break;
    }
    if (marker === 0xd8 || offset + 2 > bytes.byteLength) {
      throw new Error('Image conversion produced a malformed JPEG image.');
    }

    const length = bytes[offset]! * 0x100 + bytes[offset + 1]!;
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > bytes.byteLength) {
      throw new Error('Image conversion produced a malformed JPEG image.');
    }

    // APP0-APP15 and COM can carry EXIF, XMP, ICC, Photoshop records,
    // comments, thumbnails, or arbitrary private metadata. A freshly decoded
    // RGB encode needs none of them, so remove the whole class fail-closed.
    const metadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!metadata) parts.push(bytes.slice(markerStart, segmentEnd));
    offset = segmentEnd;
    inScan = marker === 0xda;
  }

  if (!sawEnd) throw new Error('Image conversion produced an incomplete JPEG image.');

  const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const canonical = new Uint8Array(byteLength);
  let writeOffset = 0;
  for (const part of parts) {
    canonical.set(part, writeOffset);
    writeOffset += part.byteLength;
  }
  return canonical;
}
