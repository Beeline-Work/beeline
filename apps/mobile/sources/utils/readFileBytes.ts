/**
 * Read file bytes from a URI — native implementation.
 * Uses expo-file-system/legacy to read file:// URIs on iOS/Android.
 */
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { toByteArray } from 'react-native-quick-base64';

export async function readFileBytes(uri: string): Promise<Uint8Array> {
    const base64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
    return toByteArray(base64);
}
