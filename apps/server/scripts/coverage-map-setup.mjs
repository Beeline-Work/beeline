// Records, per server test file, which repository functions ran and which
// repository files the test (or code it ran in-process) read from disk. Loaded only when
// SERVER_COVERAGE_MAP_DIR is set (see vitest.config.ts); test-selection.mjs
// merges the per-file records into the coverage map PR selection reads.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Session } from 'node:inspector/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect } from 'vitest';

const output = process.env.SERVER_COVERAGE_MAP_DIR;
const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const sourcePattern = /\.(?:[cm]?[jt]sx?)$/;
const ANONYMOUS = '(anonymous)';

function repositoryFile(location) {
  let path = String(location);
  if (path.startsWith('file://')) path = fileURLToPath(path);
  if (!path.startsWith('/')) return undefined;
  const file = relative(repo, path);
  if (file.startsWith('..') || file.startsWith('.git/') || file.includes('node_modules/')) return undefined;
  return file;
}

function readPath(path) {
  if (path instanceof URL) return repositoryFile(path.href);
  return typeof path === 'string' ? repositoryFile(resolve(path)) : undefined;
}

// One session per worker process; a reused worker resets counters per file.
const state = globalThis.__beelineCoverageMap ??= { session: undefined, reads: new Set() };
if (!state.session) {
  state.session = new Session();
  state.session.connect();
  await state.session.post('Profiler.enable');
  await state.session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
  for (const name of ['readFileSync', 'readFile']) {
    const original = fs[name];
    fs[name] = function (path, ...rest) {
      const file = readPath(path);
      if (file) state.reads.add(file);
      return original.call(this, path, ...rest);
    };
  }
  const originalPromise = fs.promises.readFile;
  fs.promises.readFile = function (path, ...rest) {
    const file = readPath(path);
    if (file) state.reads.add(file);
    return originalPromise.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
} else {
  await state.session.post('Profiler.takePreciseCoverage');
}
state.reads.clear();
// Node child processes this file starts inherit the variable and write their
// own coverage here on exit, so code a test runs out of process counts too.
const childCoverage = fs.mkdtempSync(join(tmpdir(), 'server-child-coverage-'));
process.env.NODE_V8_COVERAGE = childCoverage;

afterAll(async () => {
  const testPath = expect.getState().testPath;
  if (!output || !testPath) return;
  const { result } = await state.session.post('Profiler.takePreciseCoverage');
  for (const name of fs.readdirSync(childCoverage)) {
    try {
      result.push(...JSON.parse(fs.readFileSync(join(childCoverage, name), 'utf8')).result);
    } catch {
      // A child killed mid-write leaves a partial file; skip it.
    }
  }
  fs.rmSync(childCoverage, { recursive: true, force: true });
  delete process.env.NODE_V8_COVERAGE;
  const sources = {};
  for (const script of result) {
    const file = repositoryFile(script.url);
    if (!file || !sourcePattern.test(file) || file.startsWith('apps/server/scripts/')) continue;
    const ran = script.functions.filter((fn) => fn.ranges[0]?.count > 0);
    if (!ran.length) continue;
    const names = new Set(sources[file] ?? []);
    // The unnamed function at offset 0 is the module body, which runs on
    // import; any other unnamed function means the test ran code in the file.
    for (const fn of ran) {
      if (fn.functionName) names.add(fn.functionName);
      else if (fn.ranges[0].startOffset > 0) names.add(ANONYMOUS);
    }
    sources[file] = [...names].sort();
  }
  const test = relative(repo, testPath);
  const record = { test, sources, reads: [...state.reads].filter((file) => file !== test).sort() };
  fs.mkdirSync(output, { recursive: true });
  const name = createHash('sha256').update(test).digest('hex').slice(0, 16);
  fs.writeFileSync(join(output, `${name}-${process.pid}.json`), JSON.stringify(record));
});
