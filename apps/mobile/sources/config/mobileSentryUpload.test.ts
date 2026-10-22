import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queueSentrySourcemaps, uploadSentrySourcemaps } from '../../scripts/upload-sentry-sourcemaps.mjs';
import { prepareWebSourcemaps } from '../../scripts/prepare-web-sourcemaps.mjs';

const directories: string[] = [];
function webExport() {
  const directory = mkdtempSync(join(tmpdir(), 'sentry-web-'));
  directories.push(directory);
  const bundles = join(directory, '_expo/static/js/web');
  mkdirSync(bundles, { recursive: true });
  const bundle = join(bundles, 'index-hash.js');
  const source = '//# debugId=12345678-1234-4234-8234-123456789abc';
  writeFileSync(bundle, source);
  writeFileSync(`${bundle}.map`, JSON.stringify({
    debugId: '12345678-1234-4234-8234-123456789abc', sources: ['sources/app.ts'], mappings: 'AAAA',
  }));
  return { directory, bundle, source };
}
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

it('starts an unreferenced worker without waiting for network completion', () => {
  vi.stubEnv('SENTRY_AUTH_TOKEN', 'test-only');
  const child = { on: vi.fn(), unref: vi.fn() };
  const launch = vi.fn(() => child);
  queueSentrySourcemaps('/export', 'a'.repeat(40), { launch });
  expect(launch.mock.calls[0]).toEqual([
    process.execPath, expect.arrayContaining(['/export', 'a'.repeat(40)]),
    { detached: true, stdio: ['ignore', 'inherit', 'inherit'] },
  ]);
  expect(child.unref).toHaveBeenCalledOnce();
  const warn = vi.fn();
  queueSentrySourcemaps('/export', 'a'.repeat(40), { launch: () => { throw new Error('spawn failed'); }, warn });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('::warning::'));
});

it('Reproduction missing-sourcemap: waits for web map processing before removing private maps', () => {
  vi.stubEnv('SENTRY_AUTH_TOKEN', 'test-only');
  const { directory, bundle, source } = webExport();
  const run = vi.fn(() => {
    expect(existsSync(`${bundle}.map`)).toBe(true);
    return { status: 0 };
  });
  prepareWebSourcemaps(directory, 'a'.repeat(40), { run });
  expect(run.mock.calls).toHaveLength(1);
  expect(run.mock.calls[0]).toEqual(expect.arrayContaining([expect.arrayContaining(['--wait', '--strict'])]));
  expect(existsSync(`${bundle}.map`)).toBe(false);
  expect(readFileSync(bundle, 'utf8')).toBe(source);
});

it('blocks web deployment on missing credentials, missing maps, mismatched IDs or upload failure', () => {
  const { directory, bundle } = webExport();
  vi.stubEnv('SENTRY_AUTH_TOKEN', '');
  expect(() => prepareWebSourcemaps(directory, 'a'.repeat(40))).toThrow(/SENTRY_AUTH_TOKEN/);
  vi.stubEnv('SENTRY_AUTH_TOKEN', 'test-only');
  expect(() => prepareWebSourcemaps(directory, 'a'.repeat(40), { run: () => ({ status: 1 }) })).toThrow(/upload failed/);
  expect(existsSync(`${bundle}.map`)).toBe(true);
  writeFileSync(bundle, 'bundle without a debug ID');
  expect(() => prepareWebSourcemaps(directory, 'a'.repeat(40))).toThrow(/do not match/);
  rmSync(`${bundle}.map`);
  expect(() => prepareWebSourcemaps(directory, 'a'.repeat(40))).toThrow(/ENOENT/);
});
