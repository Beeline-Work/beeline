import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { boundToolResult } from './tool-output-budget.js';

it('Reproduction TOKEN-OUTPUT: caps a giant result, keeps head and tail and saves all bytes for paging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tool-budget-'));
  try {
    const result = { content: [{ type: 'text', text: 'HEAD ' + '🐝'.repeat(100_000) + ' TAIL' }], isError: true };
    const bounded = await boundToolResult(result, root);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(32_768);
    expect(bounded.isError).toBe(true);
    const text = bounded.content[0]!.text!;
    expect(text).toContain('HEAD ');
    expect(text).toContain(' TAIL');
    expect(text).toContain(`${Buffer.byteLength(JSON.stringify(result))} UTF-8 bytes`);
    expect(text).toContain('skip=OFFSET count=4096');
    const files = await readdir(join(root, 'tool-output'));
    expect(JSON.parse(await readFile(join(root, 'tool-output', files[0]!), 'utf8'))).toEqual(result);
    expect(await boundToolResult({ content: [] }, root)).toEqual({ content: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('preserves media while bounding model-facing text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tool-media-budget-'));
  const image = { type: 'image', mimeType: 'image/png', data: 'a'.repeat(100_000) };
  try {
    const result = { content: [image] };
    expect(await boundToolResult(result, root)).toEqual(result);
    const bounded = await boundToolResult({ content: [{ type: 'text', text: 'x'.repeat(100_000) }, image] }, root);
    expect(bounded.content[1]).toEqual(image);
    expect(bounded.content[0]!.text!.length).toBeLessThan(16_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});
