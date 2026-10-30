import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Check } from 'typebox/value';
import { callAgentTool, agentToolsFor } from './read-only-mcp.js';

it('Reproduction report-schema: accepts complete multi-paragraph reports on every surface', () => {
  const text = 'blocked: ' + 'Synthetic paragraph for report delivery.\n\n'.repeat(150);
  for (const tools of [agentToolsFor(true, false), agentToolsFor(true, true), agentToolsFor(true, false, true)]) {
    const schema = tools.find(tool => tool.name === 'report')!.inputSchema;
    expect(Check(schema, { status: 'blocked', text })).toBe(true);
    expect(Check(schema, { status: 'blocked', text, to: '@ruby' })).toBe(true);
    // Constrained generation clients may require patterns to match the entire value.
    expect(schema.properties.text).not.toHaveProperty('pattern');
    expect(Check(schema, { status: 'blocked', text: 'blocked: ' + 'x'.repeat(16000) })).toBe(false);
  }
  console.info(`Demonstrated report-schema: shipped schemas accept all ${text.length} characters across multiple paragraphs`);
});

const scratch = mkdtempSync(join(tmpdir(), 'report-artifacts-'));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));

function setupTurn(generation: string) {
  const context = join(scratch, 'turn.json');
  writeFileSync(join(scratch, 'evidence.txt'), 'evidence');
  writeFileSync(context, JSON.stringify({ roomId: 'room', requestId: 'request', generationId: generation }));
  for (const [key, value] of Object.entries({
    BEELINE_TURN_CONTEXT_FILE: context, BEELINE_DAEMON_ROOM_ID: 'room',
    BEELINE_DAEMON_BASE_URL: 'http://daemon.test', BEELINE_DAEMON_TOKEN: 'test',
    BEELINE_ATTACH_ROOT: scratch,
  })) vi.stubEnv(key, value);
}

it.each(['report', 'post'])('Reproduction ARTIFACT-REPORT: %s waits for an in-flight artifact', async (delivery) => {
  setupTurn('upload-success-' + delivery);
  let release!: () => void;
  const uploading = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const startedUpload = new Promise<void>(resolve => { started = resolve; });
  const attachments: unknown[] = [];
  let delivered: unknown[] | undefined;
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    if (url.pathname === '/v1/daemon/artifacts') {
      started(); await uploading;
      return Response.json({ url: 'http://daemon.test/v1/media/00000000-0000-4000-8000-000000000001' });
    }
    if (url.pathname.endsWith('/postAgentAttachment')) attachments.push(JSON.parse(String(init.body)).attachment);
    if (url.pathname.endsWith('/report') || url.pathname.endsWith('/postCornerMessage')) delivered = [...attachments];
    return Response.json({ delivered: true });
  });
  const upload = callAgentTool('post_artifact', { path: join(scratch, 'evidence.txt'), mime: 'text/plain', title: 'evidence.txt' }, 'upload');
  await startedUpload;
  const report = callAgentTool(delivery, { ...(delivery === 'report' ? { status: 'done' } : {}), text: 'done: evidence ready' }, 'report');
  await new Promise(resolve => setTimeout(resolve, 20));
  const reportedEarly = delivered !== undefined;
  release();
  await Promise.all([upload, report]);
  expect(reportedEarly).toBe(false);
  expect(delivered).toEqual([expect.objectContaining({ name: 'evidence.txt' })]);
});

it('Reproduction ARTIFACT-REPORT refuses done after an upload failed', async () => {
  setupTurn('upload-failure');
  const fetchMock = vi.fn(async () => Response.json({ error: 'storage_unavailable' }, { status: 503 }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(callAgentTool('post_artifact', { path: join(scratch, 'evidence.txt'), mime: 'text/plain', title: 'evidence.txt' }, 'upload')).rejects.toThrow('storage_unavailable');
  await expect(callAgentTool('report', { status: 'done', text: 'done: evidence ready' }, 'report')).rejects.toThrow('storage_unavailable');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('keeps a queue failure visible to report and clears it for the next generation', async () => {
  setupTurn('queue-failure');
  const fetchMock = vi.fn(async (url: URL) => {
    if (url.pathname === '/v1/daemon/artifacts') return Response.json({ url: 'http://daemon.test/v1/media/00000000-0000-4000-8000-000000000001' });
    if (url.pathname.endsWith('/postAgentAttachment')) return Response.json({ error: 'queue_failed' }, { status: 500 });
    return Response.json({ delivered: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  await expect(callAgentTool('post_artifact', { path: join(scratch, 'evidence.txt') }, 'upload')).rejects.toThrow('queue_failed');
  await expect(callAgentTool('report', { status: 'done', text: 'done: evidence ready' }, 'report')).rejects.toThrow('queue_failed');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  setupTurn('next-generation');
  await expect(callAgentTool('report', { status: 'done', text: 'done: next assignment' }, 'report-next')).resolves.toContain('delivered');
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('forwards an explicit report recipient through the tool to the daemon', async () => {
  setupTurn('report-to');
  let input: unknown;
  vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
    input = JSON.parse(String(init.body));
    return Response.json({ delivered: true });
  });
  await callAgentTool('report', { status: 'done', text: 'done: release finished', to: '@ruby' }, 'report-to');
  expect(input).toMatchObject({ to: '@ruby', status: 'done', text: 'done: release finished' });
});

it('Reproduction upload-1: a successfully queued replacement unblocks the report', async () => {
  setupTurn('replacement');
  let fail = true;
  let reported = false;
  vi.stubGlobal('fetch', async (url: URL) => {
    if (url.pathname === '/v1/daemon/artifacts') {
      if (fail) return Response.json({ error: 'storage_unavailable' }, { status: 503 });
      return Response.json({ url: 'http://daemon.test/v1/media/00000000-0000-4000-8000-000000000001' });
    }
    if (url.pathname.endsWith('/report')) reported = true;
    return Response.json({ delivered: true });
  });
  await expect(callAgentTool('post_artifact', { path: join(scratch, 'evidence.txt') }, 'failed')).rejects.toThrow();
  fail = false;
  await callAgentTool('post_artifact', { path: join(scratch, 'evidence.txt') }, 'replacement');
  await expect(callAgentTool('report', { status: 'done', text: 'done: evidence.txt attached' }, 'report')).resolves.toContain('delivered');
  expect(reported).toBe(true);
});

for (const name of ['order', 'report', 'post']) {
  it(`Reproduction files-1: ${name} refuses a foreign workspace temp path before sending`, async () => {
    setupTurn(`foreign-${name}`);
    const fetchMock = vi.fn(async () => Response.json({ delivered: true }));
    vi.stubGlobal('fetch', fetchMock);
    const text = 'done: read /tmp/another-agent-workspace/evidence.txt';
    await expect(callAgentTool(name, { text, ...(name === 'order' ? { address: '22222222-2222-4222-8222-222222222222', agent: 'worker' } : name === 'report' ? { status: 'done' } : {}) }, 'foreign')).rejects.toThrow(/attach|upload/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
}

it('Reproduction upload-1: an unrelated successful file cannot hide missing evidence', async () => {
  setupTurn('unrelated-success');
  let fail = true;
  vi.stubGlobal('fetch', async (url: URL) => {
    if (url.pathname === '/v1/daemon/artifacts') {
      if (fail) return Response.json({ error: 'storage_unavailable' }, { status: 503 });
      return Response.json({ url: 'http://daemon.test/v1/media/00000000-0000-4000-8000-000000000001' });
    }
    return Response.json({ delivered: true });
  });
  await expect(callAgentTool('post_artifact', { path: join(scratch, 'evidence.txt') }, 'failed')).rejects.toThrow();
  fail = false;
  await callAgentTool('post_artifact', { path: join(scratch, 'evidence.txt'), title: 'unrelated.txt' }, 'unrelated');
  await expect(callAgentTool('report', { status: 'done', text: 'done: evidence attached' }, 'report')).rejects.toThrow('storage_unavailable');
});
