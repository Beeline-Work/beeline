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
export function canonicalizeAvatarPng(bytes: Uint8Array): Uint8Array {
  if (
    bytes.byteLength < PNG_SIGNATURE.byteLength ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
  ) {
    throw new Error('Avatar conversion did not produce a valid PNG image.');
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
      throw new Error('Avatar conversion produced a malformed PNG image.');
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
    throw new Error('Avatar conversion produced an incomplete PNG image.');
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
