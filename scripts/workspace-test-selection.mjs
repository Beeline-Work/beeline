// Conservative file dependencies for Body/mobile; server coverage selection
// remains authoritative. Opaque loaders and source readers always run.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { readsSourceText } from '../apps/server/scripts/test-selection.mjs';

const roots = { server: 'apps/server', body: 'apps/body', mobile: 'apps/mobile' };
const code = /\.(?:[cm]?[jt]sx?)$/;
const fullInput = /^(?:\.github\/|scripts\/|packages\/api-contract\/|apps\/server\/scripts\/)|^apps\/body\/test-isolation\.ts$|^apps\/mobile\/sources\/test\/setupUnistyles\.ts$|(?:^|\/)(?:migrations?|schema)(?:\/|[.-])|(?:^|\/)[^/]*backfill[^/]*\.[cm]?[jt]s$|^apps\/server\/src\/database\.ts$|(?:^|\/)(?:package(?:-lock)?\.json|[^/]*config[^/]*\.[^/]+|\.npmrc)$/;
const own = file => Object.entries(roots).find(([, root]) => file.startsWith(root + '/'))?.[0];
const isDoc = file => file.startsWith('docs/') || /\.md$/.test(file);
const quietDoc = file => isDoc(file) && !own(file) && !file.startsWith('packages/');
const testPath = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function fullReason(changes) {
  if (!Array.isArray(changes)) return 'No trustworthy changed-file list';
  if (changes.some(change => change.status !== 'M' && !(change.status === 'A' && testPath.test(change.path)))) return 'Added production input, deleted or renamed input';
  const force = changes.find(change => fullInput.test(change.path) || (!own(change.path) && !change.path.startsWith('packages/') && !isDoc(change.path)));
  return force && `Shared contract, configuration, migration or unknown input: ${force.path}`;
}

export function discoverTests(root, groups = Object.keys(roots)) {
  return Object.fromEntries(groups.map(group => {
    const directory = roots[group];
    const vitest = join(root, group === 'mobile' ? 'apps/mobile/node_modules/vitest/vitest.mjs' : 'node_modules/vitest/vitest.mjs');
    const args = [vitest, 'list', '--filesOnly', '--json', '--maxWorkers=1', '--minWorkers=1'];
    if (group === 'mobile') args.push('--exclude', 'sources/config/nativeFingerprint.test.ts');
    const result = spawnSync(process.execPath, args, { cwd: join(root, directory), encoding: 'utf8', maxBuffer: 8 * 1024 ** 2 });
    assert.equal(result.status, 0, `Cannot discover ${group} tests: ${result.stderr}`);
    return [group, JSON.parse(result.stdout).map(item => relative(root, item.file)).sort()];
  }));
}

export function selectWorkspaceTests({ root, changes, testFiles, trackedFiles, requiredMobile = [] }) {
  const full = reason => ({ version: 1, mode: 'full', reason });
  const forced = fullReason(changes);
  if (forced) return full(forced);
  if (changes.every(change => quietDoc(change.path))) return { version: 1, mode: 'subset', reason: 'Documentation only', groups: { server: [], body: [], mobile: [] } };
  const files = new Set(trackedFiles);
  if (changes.some(change => !files.has(change.path))) return full('Changed input is absent from the tracked graph');
  if (changes.some(change => change.status === 'A' && !Object.values(testFiles).flat().includes(change.path))) return full('Added test is not in the actual suite discovery');
  const sources = [...files].filter(file => code.test(file));
  const workspaceManifests = [...files].filter(file => /^(?:apps|packages)\/[^/]+\/package\.json$/.test(file));
  const packages = workspaceManifests.map(file => ({ root: dirname(file), ...JSON.parse(readFileSync(join(root, file), 'utf8')) }));
  const reverse = new Map();
  const opaque = new Set();
  const textReaders = new Set();
  const add = (from, provider) => {
    if (!reverse.has(provider)) reverse.set(provider, new Set());
    reverse.get(provider).add(from);
  };
  const find = path => {
    for (const candidate of [path, path.replace(/\.js$/, '.ts'), path.replace(/\.js$/, '.tsx'),
      path.replace(/\.d\.ts$/, '.ts'), ...['.ts', '.tsx', '.js', '.json', '/index.ts', '/index.tsx', '/index.js'].map(extension => path + extension)]) {
      if (files.has(candidate)) return candidate;
    }
  };
  const resolveImport = (from, specifier) => {
    if (['node:child_process', 'child_process', 'node:vm', 'vm'].includes(specifier)) opaque.add(from);
    if (specifier.includes('${')) { opaque.add(from); return; }
    const group = own(from);
    if (specifier.startsWith('@/') && group === 'mobile') return find('apps/mobile/sources/' + specifier.slice(2));
    if (specifier.startsWith('.')) return find(relative(root, resolve(root, dirname(from), specifier)));
    if (isAbsolute(specifier)) return find(relative(root, specifier));
    const provider = packages.find(pkg => specifier === pkg.name || specifier.startsWith(pkg.name + '/'));
    if (provider) {
      // Conditional/public exports need not mirror source names. Depend on
      // the provider workspace rather than guessing an export's source file.
      for (const file of sources) if (file.startsWith(provider.root + '/') && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) add(from, file);
      return;
    }
    if (specifier.startsWith('@beeline/')) opaque.add(from);
  };
  const importEdge = (file, specifier) => {
    const target = resolveImport(file, specifier);
    if (target) add(file, target);
    else if (specifier.startsWith('.') || specifier.startsWith('@/') || isAbsolute(specifier)) opaque.add(file);
  };
  for (const file of sources) {
    const text = readFileSync(join(root, file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) opaque.add(file);
    // Always-run source scanners match the server selector's established rule.
    if (readsSourceText(ts, file, text)) textReaders.add(file);
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) importEdge(file, node.moduleSpecifier.text);
      if (ts.isExternalModuleReference(node) && ts.isStringLiteralLike(node.expression)) importEdge(file, node.expression.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || /^(?:require(?:\.resolve)?|vi\.(?:do)?(?:un)?mock|vi\.importActual|vi\.importMock)$/.test(node.expression.getText(source)))) {
        if (node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) importEdge(file, node.arguments[0].text);
        else opaque.add(file);
      }
      if (ts.isCallExpression(node) && /(?:^|\.)(?:createRequire|eval|Function)$/.test(node.expression.getText(source))) opaque.add(file);
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'Function') opaque.add(file);
      // Browser proofs compile source stored in strings; those imports are
      // dependencies even though they are not imports of the test module.
      if (ts.isStringLiteralLike(node) && /\b(?:import|export|require)\b/.test(node.text)) {
        for (const imported of ts.preProcessFile(node.text, true, true).importedFiles) importEdge(file, imported.fileName);
      }
      if (ts.isStringLiteralLike(node) && /(?:^|\/)[^/\s]+\.[A-Za-z\d]+$/.test(node.text)) {
        for (const candidate of [node.text, relative(root, resolve(root, dirname(file), node.text)),
          own(file) && relative(root, resolve(root, roots[own(file)], node.text))].filter(Boolean)) {
          const provider = find(candidate);
          if (provider) add(file, provider);
        }
      }
      if (ts.isTemplateExpression(node) && /\b(?:import|export|require)\b/.test(node.getText(source))) {
        const raw = node.getText(source).slice(1, -1);
        if (/(?:from\s*|import\s*\(|require\s*\()["']?\s*\$\{/.test(raw) || /["']\$\{/.test(raw)) opaque.add(file);
        for (const imported of ts.preProcessFile(raw, true, true).importedFiles) importEdge(file, imported.fileName);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  function dependents(inputs) {
    const seen = new Set(inputs), pending = [...inputs];
    for (let index = 0; index < pending.length; index++) for (const user of reverse.get(pending[index]) ?? []) {
      if (!seen.has(user)) { seen.add(user); pending.push(user); }
    }
    return seen;
  }
  const changed = changes.map(change => change.path);
  // A tracked asset/data file without a modeled reader must not silently
  // become an empty selection. Select its whole owning workspace instead.
  if (changed.some(file => !code.test(file) && !reverse.has(file))) return full('Asset/data input has no trustworthy dependency edge');
  const affected = dependents(changed);
  const uncertain = dependents(new Set([...opaque, ...textReaders]));
  const groups = Object.fromEntries(Object.entries(testFiles).map(([group, tests]) => [group,
    tests.filter(file => affected.has(file) || uncertain.has(file) || (group === 'mobile' && requiredMobile.includes(file))) ]));
  return { version: 1, mode: 'subset', reason: 'Reverse file imports, virtual entries, source readers and opaque-loader fallback', groups,
    counts: Object.fromEntries(Object.entries(groups).map(([group, tests]) => [group, { selected: tests.length, total: testFiles[group].length }])),
    opaqueModules: [...opaque].sort(), sourceReaders: [...textReaders].sort(),
    alwaysRun: [...new Set([...textReaders, ...Object.values(testFiles).flat().filter(file => uncertain.has(file))])].sort() };
}

function main() {
  const root = process.cwd();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const out = process.argv[process.argv.indexOf('--out') + 1];
  assert.ok(process.argv.includes('--out') && out, '--out is required');
  let selection;
  try {
    const event = process.env.GITHUB_EVENT_NAME || 'pull_request';
    if (event !== 'pull_request') selection = { version: 1, mode: 'full', reason: `${event} executes every suite` };
    else {
      const base = process.env.CI_BASE_SHA;
      assert.match(base ?? '', /^[a-f0-9]{40,64}$/, 'Missing exact PR base');
      const parts = execFileSync('git', ['diff', '--name-status', '-z', base, 'HEAD'], { encoding: 'utf8' }).split('\0');
      const changes = [];
      for (let index = 0; parts[index];) {
        const status = parts[index++], path = parts[index++];
        changes.push({ status, path });
        if (/^[RC]/.test(status)) index++;
      }
      const requiredMobile = [];
      if (process.env.CI_FRAME_BUDGET === 'true') requiredMobile.push('apps/mobile/sources/buzz/surface-runtime.frame-budget.test.ts');
      if (process.env.CI_STATE_UPGRADE === 'true') requiredMobile.push('apps/mobile/sources/buzz/surface-storage.upgrade.test.ts');
      const forced = fullReason(changes);
      if (forced) selection = { version: 1, mode: 'full', reason: forced };
      else if (changes.every(change => quietDoc(change.path))) selection = { version: 1, mode: 'subset', reason: 'Documentation only', groups: { server: [], body: [], mobile: [] } };
      else selection = selectWorkspaceTests({ root, changes, testFiles: discoverTests(root), requiredMobile,
          trackedFiles: execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 ** 2 }).split('\0').filter(Boolean) });
    }
  } catch (error) { selection = { version: 1, mode: 'full', reason: `Conservative fallback: ${error.message}` }; }
  selection.sha = sha;
  writeFileSync(out, JSON.stringify(selection));
  const summary = `Workspace selection: ${selection.mode}; ${selection.reason}; ${JSON.stringify(selection.counts ?? {})}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  if (process.env.GITHUB_OUTPUT) {
    const lines = [`mode=${selection.mode}`];
    for (const group of ['server', 'body', 'mobile']) lines.push(`${group}=${selection.mode === 'full' || selection.groups[group].length > 0}`);
    for (const group of ['body', 'mobile']) {
      let value = { version: 1, sha, mode: selection.mode, reason: selection.reason,
        ...(selection.mode === 'subset' ? { groups: { [group]: selection.groups[group] } } : {}) };
      if (Buffer.byteLength(JSON.stringify(value)) > 100_000) value = { version: 1, sha, mode: 'full', reason: 'Selection exceeds the safe environment size' };
      lines.push(`${group}-selection=${JSON.stringify(value)}`);
    }
    appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
