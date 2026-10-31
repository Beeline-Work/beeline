import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const hash = value => createHash('sha256').update(value).digest('hex');
const isTest = file => /^apps\/server\/src\/.*\.test\.tsx?$/.test(file);
const mandatoryGuards = ['apps/server/src/system-messages-lock.test.ts'];

function baseSourceHashes(base, files) {
  if (!files.length) return {};
  if (files.some(file => /[\r\n]/.test(file))) throw new Error('Invalid coverage source path');
  const buffer = execFileSync('git', ['cat-file', '--batch'], { cwd: root,
    input: files.map(file => `${base}:${file}\n`).join(''), maxBuffer: 32 * 1024 * 1024 });
  const hashes = {};
  let offset = 0;
  for (const file of files) {
    const end = buffer.indexOf('\n', offset);
    const [, type, length] = buffer.subarray(offset, end).toString('utf8').split(' ');
    const size = Number(length);
    if (end < 0 || type !== 'blob' || !Number.isInteger(size) || size < 0 || end + 1 + size >= buffer.length) {
      throw new Error('Coverage source unavailable at PR base');
    }
    offset = end + 1;
    hashes[file] = hash(buffer.subarray(offset, offset + size));
    offset += size + 1;
  }
  return hashes;
}

export function selectTests({ index, base, tests, baseTests = tests, changes, baseHashes }) {
  const full = reason => ({ mode: 'full', reason, tests: [...tests].sort() });
  if (!index || index.version !== 1) return full('missing or unsupported coverage map');
  if (index.revision !== base) return full('stale coverage map');
  if (!index.tests || !index.sources || !Array.isArray(index.alwaysRun)) return full('invalid coverage map');
  if (baseTests.some(test => !Array.isArray(index.tests[test]))) return full('base test missing from coverage map');
  for (const [file, digest] of Object.entries(index.sources)) {
    if (baseHashes[file] !== digest) return full(`stale source: ${file}`);
  }
  const selected = new Set([...index.alwaysRun, ...mandatoryGuards].filter(test => tests.includes(test)));
  for (const test of tests) if (!index.tests[test]?.length) selected.add(test);
  for (const { file, ranges } of changes) {
    if (file.endsWith('.md')) continue;
    if (isTest(file) && tests.includes(file)) {
      selected.add(file);
      continue;
    }
    // Test/config/dependency changes and code outside the measured server
    // deliberately invalidate selection, including the api-contract override.
    if (!file.startsWith('apps/server/src/') || !file.endsWith('.ts') || isTest(file) ||
        /(?:^|\/)(?:test-support|test-helpers?|test-fixtures|setup|harness)(?:[.\/]|$)/.test(file)) return full(`unmeasured input: ${file}`);
    if (!index.sources[file] || !ranges.length) return full(`unmapped source: ${file}`);
    for (const [start, end] of ranges) {
      const matching = tests.filter(test => index.tests[test]?.some(fn => fn.file === file && fn.start <= end && fn.end >= start));
      // Additions, deleted functions, top-level changes and unexecuted code
      // have no trustworthy coverage owner. Never silently select nothing.
      if (!matching.length) return full(`unmapped change: ${file}:${start}`);
      matching.forEach(test => selected.add(test));
      for (let line = start; line <= end; line++) {
        if (!matching.some(test => index.tests[test].some(fn => fn.file === file && fn.start <= line && fn.end >= line))) {
          return full(`partially unmapped change: ${file}:${line}`);
        }
      }
    }
  }
  return { mode: 'selected', reason: 'changed covered functions plus always-run tests', tests: [...selected].sort() };
}

export function changedRanges(diff) {
  const ranges = [];
  for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const line = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    // Insertions can change either adjacent function, or introduce top-level
    // behavior; include both adjacent old lines and fail closed if unowned.
    ranges.push(count ? [line, line + count - 1] : [Math.max(1, line), Math.max(1, line + 1)]);
  }
  return ranges;
}

export function currentSelection() {
  const tests = git('ls-files', 'apps/server/src').trim().split('\n').filter(isTest);
  const full = reason => ({ mode: 'full', reason, tests });
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return full('full suite outside pull requests');
  try {
    const base = process.env.BEELINE_TEST_BASE;
    if (!/^[a-f0-9]{40}$/.test(base ?? '')) return full('missing PR base');
    const index = JSON.parse(readFileSync(process.env.BEELINE_TEST_COVERAGE_MAP, 'utf8'));
    const baseTests = git('ls-tree', '-r', '--name-only', base, '--', 'apps/server/src').trim().split('\n').filter(isTest);
    const files = git('diff', '--name-only', '--no-renames', base, 'HEAD').trim().split('\n').filter(Boolean);
    const changes = files.map(file => ({ file, ranges: changedRanges(git('diff', '--no-ext-diff', '--no-renames', '--unified=0', base, 'HEAD', '--', file)) }));
    const baseHashes = baseSourceHashes(base, Object.keys(index.sources ?? {}));
    return selectTests({ index, base, tests, baseTests, changes, baseHashes });
  } catch (error) {
    return full(`coverage unavailable: ${error.message}`);
  }
}

// Tests can read source through a helper, launch a child process, or drive a
// browser without V8 recording that work. Follow local imports conservatively
// and keep every such test on the always-run list.
export function readsOutsideCoverage(file, read, seen = new Set(), followImports = true) {
  if (seen.has(file)) return false;
  seen.add(file);
  const source = read(file);
  if (/\b(?:readFile(?:Sync)?|readdir(?:Sync)?|readSource|readText|globSync|createSourceFile|createProgram)\b|['"](?:node:)?(?:fs(?:\/promises)?|child_process)['"]|playwright|puppeteer|webdriver|selenium|['"](?:typescript|ts-morph)['"]/.test(source)) return true;
  if (!followImports) return false;
  for (const match of source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"](\.[^'"]+)['"]/g)) {
    const specifier = /\.[a-z]+$/.test(match[1]) ? match[1].replace(/\.js$/, '.ts') : `${match[1]}.ts`;
    const imported = resolve(dirname(file), specifier);
    try {
      if (readsOutsideCoverage(imported, read, seen)) return true;
    } catch {
      // Unknown local dependencies are not evidence of an observable owner.
      return true;
    }
  }
  return false;
}

// Source reads are observed by the worker setup hook. Process/browser work
// outside V8 is detected at executed source locations as well as in test text.
export function executedExternalReads(source, locations) {
  const names = new Set();
  if (/['"](?:node:)?child_process['"]/.test(source)) {
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) names.add(name);
  }
  if (/['"](?:playwright|puppeteer)(?:-core)?['"]/.test(source)) {
    for (const name of ['chromium', 'firefox', 'webkit', 'puppeteer']) names.add(name);
  }
  if (!names.size) return false;
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](?:node:)?(?:fs(?:\/promises)?|child_process|playwright|puppeteer)['"]/g)) {
    for (const item of match[1].split(',')) {
      const [name, alias] = item.trim().split(/\s+as\s+/);
      if (names.has(name) && alias) names.add(alias);
    }
  }
  const lines = source.split('\n');
  const calls = new RegExp(`\\b(?:${[...names].join('|')})\\s*(?:\\?\\.)?\\s*(?:\\(|\\.)|['"](?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?)['"]\\s*\\]\\s*\\(`);
  return locations.some(({ start, end }) => calls.test(lines.slice(start - 1, end).join('\n')));
}

export function mergeCoverage(directory) {
  const tests = git('ls-files', 'apps/server/src').trim().split('\n').filter(isTest);
  const index = { version: 1, revision: git('rev-parse', 'HEAD').trim(), tests: {}, sources: {}, alwaysRun: [] };
  for (const filename of readdirSync(directory).filter(file => file.endsWith('.json'))) {
    for (const entry of JSON.parse(readFileSync(resolve(directory, filename), 'utf8'))) {
      index.tests[entry.test] ??= [];
      index.tests[entry.test].push(...entry.functions.filter(fn => fn.covered).map(({ file, start, end }) => ({ file, start, end })));
      if (entry.external && !index.alwaysRun.includes(entry.test)) index.alwaysRun.push(entry.test);
    }
  }
  for (const test of tests) {
    if (!index.tests[test]) throw new Error(`Incomplete full run: ${test} has no coverage packet`);
    if ((mandatoryGuards.includes(test) || !index.tests[test].length || readsOutsideCoverage(resolve(root, test), file => readFileSync(file, 'utf8'), new Set(), false)) &&
        !index.alwaysRun.includes(test)) index.alwaysRun.push(test);
    index.tests[test] = [...new Map(index.tests[test].map(fn => [JSON.stringify(fn), fn])).values()];
    for (const fn of index.tests[test]) index.sources[fn.file] = hash(readFileSync(resolve(root, fn.file), 'utf8'));
  }
  return index;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'merge') writeFileSync(process.argv[4], JSON.stringify(mergeCoverage(process.argv[3])));
  else console.log(JSON.stringify(currentSelection(), null, 2));
}
