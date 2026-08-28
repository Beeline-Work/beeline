export type RelayPublishErrorKind =
  | 'CLIENT_VALIDATION'
  | 'THREAD_ANCESTRY_MISMATCH'
  | 'ROOM_ARCHIVED'
  | 'INVALID_EVENT'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'TRANSIENT'
  | 'UNAUTHORIZED'
  | 'NEGATIVE_ACK'
  | 'NETWORK'
  | 'UNKNOWN';

/** Never let untrusted relay prose schedule one retry more than 15 minutes out. */
export const RELAY_RETRY_AFTER_MAX_MS = 15 * 60_000;

export type RelayPublishErrorOptions = {
  kind: RelayPublishErrorKind;
  sentence: string;
  recoveryAction?: string;
  retryable: boolean;
  retryAfterMs?: number;
  status?: number;
  eventKind?: number;
  cause?: unknown;
};

/** A safe, user-renderable relay publish failure. Raw relay bodies stay out of the error. */
export class RelayPublishError extends Error {
  readonly kind: RelayPublishErrorKind;
  readonly sentence: string;
  readonly recoveryAction?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly eventKind?: number;

  constructor(options: RelayPublishErrorOptions) {
    super(options.sentence, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RelayPublishError';
    this.kind = options.kind;
    this.sentence = options.sentence;
    this.recoveryAction = options.recoveryAction;
    this.retryable = options.retryable;
    this.retryAfterMs = boundedRetryAfterMs(options.retryAfterMs);
    this.status = options.status;
    this.eventKind = options.eventKind;
  }
}

function boundedRetryAfterMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(RELAY_RETRY_AFTER_MAX_MS, Math.ceil(value));
}

function retryAfterMsFromReason(reason: string): number | undefined {
  const seconds = [...reason.matchAll(/retry in\s+(\d+(?:\.\d+)?)s/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  if (seconds.length === 0) return undefined;
  return boundedRetryAfterMs(Math.max(...seconds) * 1_000);
}

function relayReason(body: unknown): string {
  if (typeof body !== 'string') return '';
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === 'string') return error;
    }
  } catch {
    // Legacy relays also return plain text. It is classified below but never rendered.
  }
  return body;
}

function invalidRelayError(
  reason: string,
  status: number,
  eventKind?: number,
  retryAfterMs?: number,
): RelayPublishError {
  const normalized = reason.toLowerCase();
  if (
    normalized.includes('thread ancestry') ||
    normalized.includes('root tag does not match') ||
    (normalized.includes('root') && normalized.includes('thread'))
  ) {
    return new RelayPublishError({
      kind: 'THREAD_ANCESTRY_MISMATCH',
      sentence: 'This reply no longer matches its conversation thread.',
      recoveryAction: 'Refresh the Room and choose Reply again.',
      retryable: false,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      status,
      eventKind,
    });
  }
  if (normalized.includes('channel is archived') || normalized.includes('room is archived')) {
    return new RelayPublishError({
      kind: 'ROOM_ARCHIVED',
      sentence: 'This Room is archived and no longer accepts messages.',
      retryable: false,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      status,
      eventKind,
    });
  }
  return new RelayPublishError({
    kind: 'INVALID_EVENT',
    sentence: 'The relay rejected this message as invalid.',
    recoveryAction: 'Review the message and try again.',
    retryable: false,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    status,
    eventKind,
  });
}

/** Convert one HTTP relay refusal into the closed publish-failure taxonomy. */
export function relayPublishErrorFromResponse(
  status: number,
  body: unknown,
  eventKind?: number,
): RelayPublishError {
  const reason = relayReason(body);
  const retryAfterMs = retryAfterMsFromReason(reason);
  if (status === 400) return invalidRelayError(reason, status, eventKind, retryAfterMs);
  if (status === 408) {
    return new RelayPublishError({
      kind: 'TIMEOUT',
      sentence: 'The relay timed out while sending your message.',
      recoveryAction: 'Try sending it again.',
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      status,
      eventKind,
    });
  }
  if (status === 429) {
    return new RelayPublishError({
      kind: 'RATE_LIMITED',
      sentence: 'The relay is receiving too many messages right now.',
      recoveryAction: 'Wait a moment, then try again.',
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      status,
      eventKind,
    });
  }
  if (status >= 500 && status <= 599) {
    return new RelayPublishError({
      kind: 'TRANSIENT',
      sentence: 'The relay is temporarily unavailable.',
      recoveryAction: 'Try sending the message again.',
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      status,
      eventKind,
    });
  }
  if (status === 401 || status === 403) {
    return new RelayPublishError({
      kind: 'UNAUTHORIZED',
      sentence: 'The relay did not allow this message.',
      recoveryAction: 'Refresh your access and try again.',
      retryable: false,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      status,
      eventKind,
    });
  }
  return new RelayPublishError({
    kind: 'UNKNOWN',
    sentence: 'The relay could not accept this message.',
    recoveryAction: 'Try again after refreshing the Room.',
    retryable: false,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    status,
    eventKind,
  });
}

export function relayPublishErrorFromNetwork(
  error: unknown,
  eventKind?: number,
): RelayPublishError {
  return new RelayPublishError({
    kind: 'NETWORK',
    sentence: 'The relay could not be reached.',
    recoveryAction: 'Check your connection and try again.',
    retryable: true,
    eventKind,
    cause: error,
  });
}

export function relayPublishNegativeAck(body: unknown, eventKind?: number): RelayPublishError {
  const reason = relayReason(body);
  if (/invalid:/i.test(reason)) return invalidRelayError(reason, 200, eventKind);
  return new RelayPublishError({
    kind: 'NEGATIVE_ACK',
    sentence: 'The relay did not accept this message.',
    recoveryAction: 'Refresh the Room before trying again.',
    retryable: false,
    eventKind,
  });
}

/**
 * Central compatibility adapter for errors produced before the typed client boundary.
 * It may inspect legacy strings, but callers only receive safe typed output.
 */
export function asRelayPublishError(error: unknown): RelayPublishError {
  if (error instanceof RelayPublishError) return error;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/channel is archived|room is archived/i.test(message)) {
    return invalidRelayError(message, 400);
  }
  const legacyHttp = /publishEvent kind=(\d+).*?HTTP (\d{3})(?:\s+([\s\S]*))?/i.exec(message);
  if (legacyHttp) {
    return relayPublishErrorFromResponse(
      Number(legacyHttp[2]),
      legacyHttp[3] ?? '',
      Number(legacyHttp[1]),
    );
  }
  if (/publishEvent kind=\d+ was not accepted/i.test(message)) {
    return relayPublishNegativeAck(message, Number(/kind=(\d+)/.exec(message)?.[1]));
  }
  const retryAfterMs = retryAfterMsFromReason(message);
  if (retryAfterMs !== undefined) {
    return new RelayPublishError({
      kind: 'RATE_LIMITED',
      sentence: 'The relay is receiving too many messages right now.',
      recoveryAction: 'Wait a moment, then try again.',
      retryable: true,
      retryAfterMs,
      cause: error,
    });
  }
  if (/publishEvent|network|fetch|timed out|aborted/i.test(message)) {
    return relayPublishErrorFromNetwork(error);
  }
  return new RelayPublishError({
    kind: 'UNKNOWN',
    sentence: 'The message could not be sent.',
    recoveryAction: 'Try again after refreshing the Room.',
    retryable: false,
    cause: error,
  });
}

export function isRetryableRelayPublishError(error: unknown): boolean {
  return asRelayPublishError(error).retryable;
}
