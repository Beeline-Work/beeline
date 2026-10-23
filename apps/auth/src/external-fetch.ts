/** Shared deadline for requests to outside services, including response bodies. */
export const EXTERNAL_REQUEST_TIMEOUT_MS = 20_000;

export class ExternalServiceTimeoutError extends Error {
  constructor(message = 'The outside service did not answer in time. The result is unknown; check before retrying.') {
    super(message);
    this.name = 'ExternalServiceTimeoutError';
  }
}

export async function externalFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  fetcher: typeof fetch = globalThis.fetch,
  timeoutMs = EXTERNAL_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  // SDK retry sleeps may ignore abort. Race each stage against the original
  // deadline as well as passing the signal to the underlying transport.
  const bounded = <T>(work: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const aborted = () => reject(deadline.aborted ? new ExternalServiceTimeoutError() : signal.reason);
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(work).then(resolve, (error) => {
      reject(deadline.aborted ? new ExternalServiceTimeoutError() : error);
    }).finally(() => signal.removeEventListener('abort', aborted));
  });
  const wrap = (response: Response): Response => new Proxy(response, {
    get(target, key) {
      if (key === 'clone') return () => wrap(target.clone());
      const value = Reflect.get(target, key, target);
      // Keep native streaming and Response metadata intact. Decoders retain
      // the same deadline after headers and return the unknown-result error.
      if (['json', 'text', 'arrayBuffer', 'blob', 'formData', 'bytes'].includes(String(key)) && typeof value === 'function')
        return (...args: unknown[]) => bounded(() => Promise.resolve(Reflect.apply(value, target, args)));
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return wrap(await bounded(() => fetcher(input, { ...init, signal })));
}

/** GitHub terminates provider processing after 10s; allow 5s for transport. */
export function githubFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  return externalFetch(input, init, globalThis.fetch, 15_000);
}
