// This route sits in front of EAS Hosting's SPA fallback, after origin lookup.
export default {
  async fetch(request, _env, context) {
    const pathname = new URL(request.url).pathname;
    // Hashed scripts are immutable. Retain successful requests across EAS alias
    // promotions; edge cache eviction still falls through to origin and recovery.
    const cache = typeof caches !== 'undefined' && request.method === 'GET' &&
      /^\/_expo\/static\/js\/.*-[a-f0-9]{32}\.js$/.test(pathname) &&
      !request.headers.has('range') && !request.headers.has('if-none-match') && !request.headers.has('if-modified-since')
      ? caches.default : null;
    const cacheKey = cache ? new Request(request.url) : null;
    if (cache) {
      const cached = await cache.match(cacheKey).catch(() => null);
      if (cached) return cached;
    }
    const response = await fetch(request);
    if ((response.ok || response.status === 404) &&
        (request.method === 'GET' || request.method === 'HEAD') &&
        /^\/_expo\/static\/js\/.*\.js$/.test(pathname) &&
        /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      return new Response(request.method === 'HEAD' ? null : 'JavaScript asset not found\n', {
        status: 404,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (cache && context && response.status === 200 &&
        /^(?:application|text)\/(?:javascript|ecmascript)(?:;|$)/i.test(response.headers.get('content-type') ?? '') &&
        !response.headers.has('set-cookie') &&
        !/private|no-store/i.test(response.headers.get('cache-control') ?? '')) {
      const retained = new Response(response.clone().body, response);
      retained.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      context.waitUntil(cache.put(cacheKey, retained).catch(() => {}));
    }
    return response;
  },
};
