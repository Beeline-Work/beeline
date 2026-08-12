import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Platform } from 'react-native';
import type { BuzzClient } from '@beeline/buzz-client';
import { canonicalizeAvatarPng } from '@/buzz/avatar-png';
import { readFileBytes } from '@/utils/readFileBytes';

const AVATAR_EDGE = 512;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
/** Pick, square-crop, compress, and upload a cosmetic avatar through Buzz media. */
export async function pickAndUploadAvatar(client: BuzzClient): Promise<string | null> {
  // Android's system photo picker grants access to the selected URI without a
  // broad media-library permission. The app intentionally blocks READ_MEDIA_*.
  if (Platform.OS === 'ios') {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (permission.status !== 'granted')
      throw new Error('Photo access is required to choose a picture.');
  }
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
