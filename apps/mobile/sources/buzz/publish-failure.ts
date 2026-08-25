import { asRelayPublishError } from '@beeline/buzz-client';

export type PublishFailurePresentation = {
  message: string;
  retryable: boolean;
};

/** Safe copy for send/reply dialogs. Relay response bodies never cross this boundary. */
export function publishFailurePresentation(error: unknown): PublishFailurePresentation {
  const failure = asRelayPublishError(error);
  return {
    message: failure.recoveryAction
      ? `${failure.sentence}\n\n${failure.recoveryAction}`
      : failure.sentence,
    retryable: failure.retryable,
  };
}
