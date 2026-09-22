import { asRelayPublishError } from '@beeline/buzz-client';

export const RAW_PHOTO_FILE_GUIDANCE =
  'This RAW photo could not be converted on this device. Choose Send as file to preserve the original bytes.';

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

/** Actionable copy plus the original failure detail for on-device diagnosis. */
export function publishFailurePresentation(error: unknown): PublishFailurePresentation {
  if (error instanceof RawPhotoDecodeError) {
    return { message: error.message, retryable: false };
  }
  const failure = asRelayPublishError(error);
  const summary = failure.recoveryAction
    ? `${failure.sentence}\n\n${failure.recoveryAction}`
    : failure.sentence;
  const directMessage = errorMessage(error);
  const causeMessage = error instanceof Error ? errorMessage(error.cause) : undefined;
  const details = [directMessage, causeMessage]
    .filter(
      (message): message is string => typeof message === 'string' && !summary.includes(message),
    )
    .filter((message, index, messages) => messages.indexOf(message) === index);
  return {
    message:
      details.length === 0
        ? summary
        : `${summary}\n\nTechnical detail: ${details.join('\nCaused by: ')}`,
    retryable: failure.retryable,
  };
}
