import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { externalFetch, githubFetch, EXTERNAL_REQUEST_TIMEOUT_MS } from './external-fetch';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('supplies the shared deadline and preserves an earlier caller cancellation', async () => {
  const original = AbortSignal.timeout.bind(AbortSignal);
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => original(30));
  const server = createServer(() => {});
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  try {
    await expect(externalFetch(`http://127.0.0.1:${port}`)).rejects.toThrow('result is unknown');
    expect(timeout).toHaveBeenCalledWith(EXTERNAL_REQUEST_TIMEOUT_MS);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      externalFetch(`http://127.0.0.1:${port}`, { signal: cancelled.signal }),
    ).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
it('keeps the signal alive after headers so a stalled body aborts too', async () => {
  const original = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => original(1_000));
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.write('{');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const response = await externalFetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
    await expect(response.json()).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it('uses GitHub’s documented processing bound plus transport time', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
  await githubFetch('https://api.github.example/user');
  expect(timeout).toHaveBeenCalledWith(15_000);
});
