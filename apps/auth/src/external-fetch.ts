/** Shared deadline for requests to outside services, including response bodies. */
export const EXTERNAL_REQUEST_TIMEOUT_MS = 20_000;

export async function externalFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  fetcher: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const deadline = AbortSignal.timeout(EXTERNAL_REQUEST_TIMEOUT_MS);
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
