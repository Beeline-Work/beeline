import { asRelayPublishError } from '@beeline/buzz-client';

export const RAW_PHOTO_FILE_GUIDANCE =
  'This RAW photo could not be converted on this device. Choose Files to preserve the original bytes.';

export class RawPhotoDecodeError extends Error {
  constructor(cause: unknown) {
    super(RAW_PHOTO_FILE_GUIDANCE, { cause });
    this.name = 'RawPhotoDecodeError';
  }
}

export type PublishFailurePresentation = {
  message: string;
  retryable: boolean;
};

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message.trim() || undefined;
  if (typeof error === 'string') return error.trim() || undefined;
  return undefined;
}
