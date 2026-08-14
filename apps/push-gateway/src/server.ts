import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { TokenRegistry } from './registry.js';

const MAX_BODY_BYTES = 32 * 1024;
const NON_PRODUCTION_ENVIRONMENTS = new Set(['test', 'emulator', 'simulator']);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export function createRegistrationServer(registry: TokenRegistry) {
  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        json(response, 200, {
          ok: true,
          registeredPubkeys: registry.pubkeyCount,
          registeredDevices: registry.tokenCount,
        });
        return;
      }

      if (request.method === 'POST' && request.url === '/registrations') {
        const body = await readJson(request);
        if (!body || typeof body !== 'object') throw new Error('expected JSON object');
        const { pubkey, token, platform, environment } = body as Record<string, unknown>;
        if (platform !== 'android') throw new Error('only android registrations are supported');
        if (typeof pubkey !== 'string' || !TokenRegistry.validPubkey(pubkey))
          throw new Error('invalid pubkey');
        if (typeof token !== 'string' || !TokenRegistry.validToken(token))
          throw new Error('invalid FCM token');
        if (environment !== undefined && typeof environment !== 'string') {
          throw new Error('invalid device environment');
        }
        if (environment && NON_PRODUCTION_ENVIRONMENTS.has(environment.toLowerCase())) {
          console.log(
            `[push] ignored non-production device pubkey=${pubkey.slice(0, 12)}… environment=${environment.toLowerCase()}`,
          );
          json(response, 202, { registered: false, ignored: 'non-production-device' });
          return;
        }
        await registry.register(pubkey, token);
        console.log(
          `[push] device registered pubkey=${pubkey.slice(0, 12)}… devices=${registry.tokenCount}`,
        );
        json(response, 201, { registered: true });
        return;
      }

      json(response, 404, { error: 'not found' });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : 'invalid request' });
    }
  });
}
