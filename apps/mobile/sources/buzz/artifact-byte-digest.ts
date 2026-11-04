import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { requireByteWork, runByteChunks } from './artifact-byte-work';

/** The existing runtime40 crypto ABI hashes bytes directly. Older native
 * cohorts retain a finite, cancellable local implementation, never a server
 * hash request or an integrity bypass. */
export async function artifactByteDigest(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  requireByteWork(signal);
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error('The file exceeds 25 MiB.');
  if (!(bytes.buffer instanceof ArrayBuffer)) throw new Error('Unsupported local file buffer.');
  const input = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let crypto: typeof import('expo-crypto') | undefined;
  try { crypto = await import('expo-crypto'); } catch { /* Older local binary. */ }
  requireByteWork(signal);
  let output: ArrayBuffer | undefined;
  if (typeof crypto?.digest === 'function') {
    try { output = await crypto.digest(crypto.CryptoDigestAlgorithm.SHA256, input); }
    catch { /* Missing native digest retains the exact local algorithm below. */ }
    requireByteWork(signal);
  }
  if (output !== undefined) {
    if (!(output instanceof ArrayBuffer) || output.byteLength !== 32) throw new Error('Invalid local file digest.');
    return bytesToHex(new Uint8Array(output));
  }
  const hash = sha256.create();
  try {
    await runByteChunks(bytes.byteLength, 1024, (offset, length) => hash.update(bytes.subarray(offset, offset + length)), signal);
    return bytesToHex(hash.digest());
  } finally { hash.destroy(); }
}
