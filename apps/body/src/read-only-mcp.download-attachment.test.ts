import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callAgentTool } from './read-only-mcp.js';

const MESSAGE_ID = '81431c68109a0d5f8d726dcfddb9bed215392897ded9bb2ec3aadbc9b1babe0f';
const IMAGE_ID = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const REPORT_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const REPORT = '# Findings\n\nThe stall is a missed heartbeat.\n';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function failure(error: unknown): { error: string; message: string } {
  return JSON.parse(error instanceof Error ? error.message : String(error));
}

describe('download_attachment', () => {
  let root: string;
  let server: Server;
  let base: string;
  let messageStatus: number;
  let messageError: string;
  let imageMetadata: Record<string, unknown>;
  let mediaStatus: number;
  const downloads: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'beeline-download-attachment-'));
    const context = join(root, 'turn.json');
    await writeFile(
      context,
      JSON.stringify({ roomId: 'corner-room', requestId: 'turn-1', generationId: 'g1' }),
    );
    messageStatus = 200;
    messageError = '';
    imageMetadata = {};
    mediaStatus = 200;
    downloads.length = 0;
    server = createServer(async (req, res) => {
      if (req.url === '/v1/daemon/operations/getRoomMessage') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString());
        expect(input).toMatchObject({ roomId: 'corner-room', requestId: 'turn-1' });
        expect(req.headers.authorization).toBe('Bearer fixture-token');
        res.writeHead(messageStatus, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            messageStatus !== 200
              ? { error: messageError }
              : {
                  messageId: input.messageId,
                  body: 'Screenshot and findings',
                  attachments: [
                    {
                      // A stored URL on another host is never fetched: bytes come
                      // from the daemon's own server.
                      url: `https://elsewhere.example/v1/media/${IMAGE_ID}`,
                      name: '24419.jpg',
                      mimeType: 'image/jpeg',
                      size: IMAGE.length,
                      sha256: sha256(IMAGE),
                      ...imageMetadata,
                    },
                    {
                      url: `${base}/v1/media/${REPORT_ID}`,
                      name: '../findings.md',
                      mimeType: 'text/markdown',
                      size: REPORT.length,
                      sha256: sha256(REPORT),
                    },
                  ],
                },
          ),
        );
      } else if (req.url === `/v1/media/${IMAGE_ID}` || req.url === `/v1/media/${REPORT_ID}`) {
        downloads.push(req.url);
        if (mediaStatus !== 200) {
          res.writeHead(mediaStatus).end();
          return;
        }
        const image = req.url.endsWith(IMAGE_ID);
        res.writeHead(200, { 'content-type': image ? 'image/jpeg' : 'text/markdown' });
        res.end(image ? IMAGE : REPORT);
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

  const download = (attachmentId: string, messageId = MESSAGE_ID) =>
    callAgentTool('download_attachment', { messageId, attachmentId }, 'call').then(JSON.parse);

  it('returns readable local paths for an image and a markdown artifact', async () => {
    const image = await download(IMAGE_ID);
    expect(image).toEqual({
      path: join(root, 'attachments', MESSAGE_ID, '24419.jpg'),
      mimeType: 'image/jpeg',
      size: IMAGE.length,
    });
    expect(await readFile(image.path)).toEqual(IMAGE);
    const report = await download(REPORT_ID);
    // The traversal in the stored name is sanitized away.
    expect(report.path).toBe(join(root, 'attachments', MESSAGE_ID, 'findings.md'));
    expect(report.mimeType).toBe('text/markdown');
    expect(await readFile(report.path, 'utf8')).toBe(REPORT);
    expect(downloads).toEqual([`/v1/media/${IMAGE_ID}`, `/v1/media/${REPORT_ID}`]);
  });

  it('does not download a file again when the same sha256 is already there', async () => {
    const first = await download(IMAGE_ID);
    const second = await download(IMAGE_ID.toUpperCase());
    expect(second).toEqual(first);
    expect(downloads).toEqual([`/v1/media/${IMAGE_ID}`]);
  });

  it('downloads again when the local copy no longer matches', async () => {
    const first = await download(IMAGE_ID);
    await writeFile(first.path, 'edited');
    await download(IMAGE_ID);
    expect(downloads).toHaveLength(2);
    expect(await readFile(first.path)).toEqual(IMAGE);
  });

  it('answers forbidden for a message the agent cannot read', async () => {
    messageStatus = 403;
    messageError = 'message access denied from this Room';
    const error = await download(IMAGE_ID).catch((caught) => caught);
    expect(failure(error).error).toBe('forbidden');
    expect(downloads).toHaveLength(0);
  });

  it('answers not_found for a missing message, an unknown attachment id, and expired bytes', async () => {
    messageStatus = 404;
    messageError = 'message not found in this Room';
    expect(failure(await download(IMAGE_ID).catch((caught) => caught)).error).toBe('not_found');
    messageStatus = 200;
    const unknown = await download('9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e').catch(
      (caught) => caught,
    );
    expect(failure(unknown).error).toBe('not_found');
    imageMetadata = { expired: true };
    const expired = failure(await download(IMAGE_ID).catch((caught) => caught));
    expect(expired).toMatchObject({
      error: 'not_found',
      message: expect.stringContaining('expired'),
    });
    imageMetadata = {};
    mediaStatus = 410;
    const gone = failure(await download(IMAGE_ID).catch((caught) => caught));
    expect(gone).toMatchObject({ error: 'not_found', message: expect.stringContaining('expired') });
  });

  it('answers too_large past the size cap without fetching', async () => {
    imageMetadata = { size: 26 * 1024 * 1024 };
    const error = await download(IMAGE_ID).catch((caught) => caught);
    expect(failure(error).error).toBe('too_large');
    expect(downloads).toHaveLength(0);
  });

  it('answers download_failed for a server error or bytes that do not match', async () => {
    mediaStatus = 503;
    expect(failure(await download(IMAGE_ID).catch((caught) => caught))).toEqual({
      error: 'download_failed',
      message: 'HTTP 503',
    });
    mediaStatus = 200;
    imageMetadata = { sha256: sha256('other bytes') };
    expect(failure(await download(IMAGE_ID).catch((caught) => caught)).error).toBe(
      'download_failed',
    );
  });

  it('get_room_message names each attachment id for download_attachment', async () => {
    const message = JSON.parse(
      await callAgentTool('get_room_message', { messageId: MESSAGE_ID }, 'read'),
    );
    expect(message.attachments.map((attachment: { id: string }) => attachment.id)).toEqual([
      IMAGE_ID,
      REPORT_ID,
    ]);
  });
});
