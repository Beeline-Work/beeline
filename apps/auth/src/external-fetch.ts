/** Shared deadline for requests to outside services, including response bodies. */
export const EXTERNAL_REQUEST_TIMEOUT_MS = 20_000;

export async function externalFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  fetcher: typeof fetch = globalThis.fetch,
  timeoutMs = EXTERNAL_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  try {
    return await fetcher(input, { ...init, signal });
  } catch (error) {
    if (deadline.aborted)
      throw new Error(
        'The outside service did not answer in time. The result is unknown; check before retrying.',
        { cause: error },
      );
    throw error;
  }
}

/** GitHub terminates provider processing after 10s; allow 5s for transport. */
export function githubFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  return externalFetch(input, init, globalThis.fetch, 15_000);
}
