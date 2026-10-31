// Optional test-deployment routing through a vaulted Groq egress grant.
// Every audio upload reaches the real provider; no responses are replaced.
const { AsyncLocalStorage } = require('node:async_hooks');
const http = require('node:http');
const requestContext = new AsyncLocalStorage();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.groq.com/openai/v1/audio/transcriptions') return originalFetch(url, init);
  const base = process.env.DICTATION_GROQ_BASE;
  if (base && new URL(base).hostname !== 'trusty-squire-api.fly.dev') throw new Error('Unexpected test egress host');
  const started = performance.now();
  const response = await originalFetch(base ? `${base}/openai/v1/audio/transcriptions` : url, init);
  const elapsed = Math.round(performance.now() - started);
  requestContext.getStore()?.setHeader('x-dictation-groq-ms', String(elapsed));
  console.info('[dictation-provider]', JSON.stringify({ status: response.status, responseMs: elapsed }));
  return response;
};
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function(event, ...args) {
  if (event === 'request' && args[0].url === '/v1/phone/transcriptions') {
    return requestContext.run(args[1], () => emit.call(this, event, ...args));
  }
  return emit.call(this, event, ...args);
};
