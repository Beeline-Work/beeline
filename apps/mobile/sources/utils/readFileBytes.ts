/** Read file bytes from a URI without expanding them through a base64 string. */
import { File } from 'expo-file-system';

export async function readFileBytes(uri: string): Promise<Uint8Array> {
  return new File(uri).bytes();
}
