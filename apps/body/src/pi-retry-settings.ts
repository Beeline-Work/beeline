/** Disable both Pi conversation retries and provider SDK retries. */
export function piNoRetrySettings() {
  return { retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } } as const;
}
