/** Pure fallback for older installed native runtimes; no new native primitive. */
export function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const chunks: string[] = [];
  for (let start = 0; start < bytes.byteLength; start += 12_288) {
    let chunk = '';
    const end = Math.min(bytes.byteLength, start + 12_288);
    for (let index = start; index < end; index += 3) {
      const a = bytes[index]!; const b = bytes[index + 1]; const c = bytes[index + 2];
      chunk += chars[a >> 2]! + chars[((a & 3) << 4) | ((b ?? 0) >> 4)]! +
        (b === undefined ? '=' : chars[((b & 15) << 2) | ((c ?? 0) >> 6)]!) + (c === undefined ? '=' : chars[c & 63]!);
    }
    chunks.push(chunk);
  }
  return chunks.join('');
}
export function base64ToBytes(value: string): Uint8Array {
  if (value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid cached file bytes.');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(value.length / 4 * 3 - padding);
  let offset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const bits = chars.indexOf(value[index]!) << 18 | chars.indexOf(value[index + 1]!) << 12 |
      Math.max(0, chars.indexOf(value[index + 2]!)) << 6 | Math.max(0, chars.indexOf(value[index + 3]!));
    if (offset < bytes.length) bytes[offset++] = bits >> 16 & 255;
    if (offset < bytes.length) bytes[offset++] = bits >> 8 & 255;
    if (offset < bytes.length) bytes[offset++] = bits & 255;
  }
  return bytes;
}
