import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import type { BuzzClient } from '@beeline/buzz-client';
import { canonicalizeAvatarPng } from '@/buzz/avatar-png';
import { readFileBytes } from '@/utils/readFileBytes';

const AVATAR_EDGE = 256;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
/** Pick and crop an avatar. The workspace setter promotes the upload into
 * durable server-owned avatar storage before acknowledging the change. */
export async function pickAndUploadAvatar(client: BuzzClient): Promise<string | null> {
  // The system photo picker grants access to the selected image without a
  // broad library permission on iOS and Android.
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: false,
    quality: 1,
    exif: false,
  });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  const edge = Math.min(asset.width, asset.height);
  const normalized = await manipulateAsync(
    asset.uri,
    [
      {
        crop: {
          originX: Math.max(0, Math.floor((asset.width - edge) / 2)),
          originY: Math.max(0, Math.floor((asset.height - edge) / 2)),
          width: edge,
          height: edge,
        },
      },
      { resize: { width: AVATAR_EDGE, height: AVATAR_EDGE } },
    ],
    // PNG output is canonical and metadata-free on Android. The relay rejects
    // JPEG containers carrying EXIF/JFIF metadata to avoid leaking location or
    // device details through cosmetic profile images.
    { compress: 1, format: SaveFormat.PNG },
  );
  const bytes = canonicalizeAvatarPng(await readFileBytes(normalized.uri));
  if (bytes.byteLength > MAX_AVATAR_BYTES)
    throw new Error('Avatar image must be smaller than 5 MB.');
  return (await client.uploadMedia(bytes, 'image/png')).url;
}
