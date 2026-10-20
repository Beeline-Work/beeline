/** Keep a small Room JSON body in memory instead of scheduling a native Blob read. */
export const fetchOpeningRoom: typeof globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  if (request.method !== 'GET') return globalThis.fetch(input, init);
  return new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const cleanup = () => request.signal?.removeEventListener('abort', abort);
    const failure = (error: Error) => { cleanup(); reject(error); };
    const aborted = () => {
      const error = new Error('The request was aborted.');
      error.name = 'AbortError';
      failure(error);
    };
    const abort = () => { xhr.abort(); aborted(); };
    if (request.signal?.aborted) { aborted(); return; }
    xhr.open('GET', request.url, true);
    xhr.responseType = 'text';
    request.headers.forEach((value, name) => xhr.setRequestHeader(name, value));
    xhr.onload = () => {
      cleanup();
      try {
        const headers = new Headers();
        for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
          const colon = line.indexOf(':');
          if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
        }
        resolve(new Response(xhr.responseText, { status: xhr.status, statusText: xhr.statusText, headers }));
      } catch (error) { reject(error); }
    };
    xhr.onerror = () => failure(new TypeError('Network request failed'));
    xhr.ontimeout = () => failure(new TypeError('Network request timed out'));
    xhr.onabort = aborted;
    request.signal?.addEventListener('abort', abort);
    xhr.send();
  });
};
