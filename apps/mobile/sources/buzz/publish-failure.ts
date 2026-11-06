import { asRelayPublishError } from '@beeline/buzz-client';

export const RAW_PHOTO_FILE_GUIDANCE =
  'This RAW photo could not be converted on this device. Choose Files to preserve the original bytes.';

export class RawPhotoDecodeError extends Error {
  constructor(cause: unknown) {
    super(RAW_PHOTO_FILE_GUIDANCE, { cause });
    this.name = 'RawPhotoDecodeError';
  }
}
