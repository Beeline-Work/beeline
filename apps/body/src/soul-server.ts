import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { generateSoul } from './soul.js';

const MAX_BODY_BYTES = 4 * 1024;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid JSON body');
  return value as Record<string, unknown>;
}

export function createSoulServer(
  agentEnv: Record<string, string>,
  generate: typeof generateSoul = generateSoul,
) {
  return createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      json(response, 204, {});
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/souls/generate') {
      json(response, 404, { error: 'not found' });
      return;
    }
    try {
      const body = await readJson(request);
      if (typeof body.intent !== 'string') throw new Error('intent is required');
      const soul = await generate(body.intent, agentEnv);
      json(response, 200, soul);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'generation failed';
      const status = /intent|required|JSON|large/.test(message) ? 400 : 502;
      json(response, status, { error: message });
    }
  });
}
