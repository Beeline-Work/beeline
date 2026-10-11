/** Picker data stays free of native upload modules so viewer chrome can load on web. */
export const MAX_MESSAGE_ATTACHMENTS = 10;

export type PickedChatAttachment = {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  source: 'photo' | 'file';
  width?: number;
  height?: number;
};

type PickedPhotoAsset = {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number;
  width: number;
  height: number;
};

/** Preserves the picker order and gives unnamed assets stable, distinct labels. */
export function pickedPhotoAttachments(
  assets: readonly PickedPhotoAsset[],
  pickedAt = Date.now(),
): PickedChatAttachment[] {
  return assets.map((asset, index) => ({
    uri: asset.uri,
    name: asset.fileName?.trim() || `photo-${pickedAt}-${index + 1}.jpg`,
    mimeType: asset.mimeType ?? 'image/jpeg',
    size: asset.fileSize ?? 0,
    source: 'photo',
    width: asset.width,
    height: asset.height,
  }));
}
