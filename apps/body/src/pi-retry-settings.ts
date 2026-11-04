/** Disable both Pi conversation retries and provider SDK retries. */
export function piNoRetrySettings() {
  return { retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } } as const;
}

/** The owned-model extension authenticates retryable refusal evidence before
 * allowing Pi to retry. SDK retries remain disabled: they bypass the journal. */
export function piKnownRefusalRetrySettings() {
  return {retry:{enabled:true,maxRetries:3,baseDelayMs:250,provider:{maxRetries:0}}} as const;
}
