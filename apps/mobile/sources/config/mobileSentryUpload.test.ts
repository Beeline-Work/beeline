import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadSentrySourcemaps } from '../../scripts/upload-sentry-sourcemaps.mjs';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

it('uploads the matching Hermes bundle and composed map with the full release SHA', () => {
  vi.stubEnv('SENTRY_AUTH_TOKEN', 'test-only');
  const directory = mkdtempSync(join(tmpdir(), 'sentry-upload-'));
  directories.push(directory);
  writeFileSync(join(directory, 'index.hbc'), 'bytecode fixture');
  writeFileSync(join(directory, 'index.hbc.map'), JSON.stringify({
    debugId: '12345678-1234-4234-8234-123456789abc', sources: ['sources/app.ts'], mappings: 'AAAA',
  }));
  const run = vi.fn((_executable: string, _args: string[], _options: unknown) => ({ status: 0 }));
  const release = 'a'.repeat(40);
  expect(uploadSentrySourcemaps(directory, release, { run })).toBe(true);
  expect(JSON.parse(readFileSync(join(directory, 'index.hbc.map'), 'utf8')).debug_id)
    .toBe('12345678-1234-4234-8234-123456789abc');
  expect(uploadSentrySourcemaps(directory, release, { run: () => ({ status: 1 }), warn: vi.fn() })).toBe(false);
  expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining([
    '--release', release, '--debug-id-reference', join(directory, 'index.hbc'), join(directory, 'index.hbc.map'),
  ]));
});

it('warns and returns without aborting OTA when authentication or upload fails', () => {
  const warn = vi.fn();
  vi.stubEnv('SENTRY_AUTH_TOKEN', '');
  expect(uploadSentrySourcemaps('/unused', 'a'.repeat(40), { warn })).toBe(false);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('::warning::'));
});

it('refuses maps without their matching bundle rather than claiming a successful upload', () => {
  vi.stubEnv('SENTRY_AUTH_TOKEN', 'test-only');
  const directory = mkdtempSync(join(tmpdir(), 'sentry-upload-'));
  directories.push(directory);
  writeFileSync(join(directory, 'index.hbc.map'), JSON.stringify({
    debug_id: '12345678-1234-4234-8234-123456789abc', sources: ['app.ts'], mappings: 'AAAA',
  }));
  const run = vi.fn();
  expect(uploadSentrySourcemaps(directory, 'a'.repeat(40), { run, warn: vi.fn() })).toBe(false);
  expect(run).not.toHaveBeenCalled();
});
