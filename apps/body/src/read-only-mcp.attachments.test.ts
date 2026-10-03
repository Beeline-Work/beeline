import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callAgentTool } from './read-only-mcp.js';

describe('historical attachment tool delivery', () => {
  let root: string;
  let server: Server;
  let base: string;
  let denied: boolean;
  let downloads: number;
  let metadata: Record<string, unknown>;
  let mediaStatus: number;
  const messageId = 'f40758972c4d6761c71e71250448fc1bb596bbcf519b3a4cb16529ea98335fcc';
  const content = 'Earlier message audit plan';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'beeline-historical-'));
    const context = join(root, 'turn.json');
    await writeFile(
      context,
      JSON.stringify({
        roomId: 'corner-room',
        requestId: 'trigger-without-attachments',
        generationId: 'generation-1',
      }),
    );
    denied = false;
    downloads = 0;
    metadata = {};
    mediaStatus = 200;
    server = createServer(async (req, res) => {
      if (req.url === '/v1/daemon/operations/getRoomMessage') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({
          roomId: 'corner-room',
          requestId: 'trigger-without-attachments',
          messageId,
        });
        expect(req.headers.authorization).toBe('Bearer fixture-token');
        res.writeHead(denied ? 403 : 200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            denied
              ? { error: 'FORBIDDEN' }
              : {
                  messageId,
                  body: 'Plan attached to an earlier authorized message',
                  nextOffset: 4000,
                  attachments: [
                    {
                      url: `${base}/v1/media/plan`,
                      name: 'plan.txt',
                      mimeType: 'text/plain',
                      size: content.length,
                      ...metadata,
                    },
                  ],
                },
          ),
        );
      } else if (req.url === '/v1/media/plan') {
        downloads += 1;
        expect(req.headers.authorization).toBeUndefined();
        res.writeHead(mediaStatus, { 'content-type': 'text/plain' });
        res.end(content);
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no fixture port');
    base = `http://127.0.0.1:${address.port}`;
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', context);
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', base);
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'fixture-token');
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'parent-room');
    vi.stubEnv('BEELINE_ATTACH_SCRATCH_ROOT', root);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });

  it('Reproduction R1: reads an earlier message file through get_room_message with an attachment-free trigger', async () => {
    const result = JSON.parse(await callAgentTool('get_room_message', { messageId }, 'R1'));
    expect(result.nextOffset).toBe(4000);
    expect(result.attachments[0].path).toEqual(expect.any(String));
    const observed = await readFile(result.attachments[0].path, 'utf8');
    expect(observed).toBe(content);
    expect(downloads).toBe(1);
    console.info(
      `R1 demonstrated: get_room_message returned a local file; readFile read "${observed}"`,
    );
  });

  it('does not download or return files after an unauthorized message read', async () => {
    denied = true;
    await expect(callAgentTool('get_room_message', { messageId }, 'denied')).rejects.toThrow(
      '403: FORBIDDEN',
    );
    expect(downloads).toBe(0);
  });

  it.each([
    [{ expired: true }, 'expired'],
    [{ size: 26 * 1024 * 1024 }, 'exceeds'],
  ])('returns a reason instead of a path for unavailable metadata %j', async (value, reason) => {
    metadata = value;
    const result = JSON.parse(
      await callAgentTool('get_room_message', { messageId }, 'unavailable'),
    );
    expect(result.attachments[0].path).toBeUndefined();
    expect(result.attachments[0].reason).toContain(reason);
    expect(downloads).toBe(0);
  });

  it('reports a media failure after three attempts without dropping message text or references', async () => {
    mediaStatus = 503;
    const result = JSON.parse(await callAgentTool('get_room_message', { messageId }, 'failed'));
    expect(result.attachments[0].reason).toBe('download failed: HTTP 503');
    expect(result.attachments[0].url).toBe(`${base}/v1/media/plan`);
    expect(result.body).toBe('Plan attached to an earlier authorized message');
    expect(downloads).toBe(3);
  });

  it('returns a stated reason when the session has no scratch directory', async () => {
    vi.stubEnv('BEELINE_ATTACH_SCRATCH_ROOT', '');
    const result = JSON.parse(await callAgentTool('get_room_message', { messageId }, 'no-scratch'));
    expect(result.attachments[0].reason).toBe('download failed: no session scratch directory');
    expect(downloads).toBe(0);
  });
});
