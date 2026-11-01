// Picks the server test files a pull request must run.
//
// A coverage map from a full run on main records, per test file, which
// repository functions ran and which repository files it read. A PR runs the
// tests whose recorded functions or files its diff touches, plus every test
// that reads source code as text. Anything this cannot reason about runs the
// full suite. Main and the merge queue always run the full suite.
//
//   node scripts/test-selection.mjs build-map --records DIR --commit SHA --out MAP
//   node scripts/test-selection.mjs check-map MAP
//   node scripts/test-selection.mjs select --map MAP --out SELECTION
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAP_VERSION = 2;
// A map older than this, or this many commits behind, is too stale to trust.
export const MAX_MAP_AGE_DAYS = 7;
export const MAX_MAP_DISTANCE = 300;

const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const serverRoot = 'apps/server/';
const codePattern = /\.(?:[cm]?[jt]sx?)$/;
const testPattern = /\.test\.[cm]?[jt]sx?$/;

// Changes here alter how every test runs or what the map means. Other
// workflows do not run the server suite; tests that read them are in the map.
const fullSuitePatterns = [
  /^packages\/api-contract\//,
  /^\.github\/workflows\/(?:checks|server-coverage-map)\.yml$/,
  /^\.github\/actions\//,
  /^apps\/server\/scripts\//,
  /^apps\/server\/vitest\.config\./,
  /^apps\/server\/src\/test-support\.ts$/,
  /^apps\/server\/(?:package\.json|tsconfig[^/]*\.json)$/,
  /^(?:package\.json|package-lock\.json|tsconfig[^/]*\.json|turbo\.json|\.npmrc)$/,
];

// Paths that cannot start the server suite on their own (see `changes` in
// checks.yml). If no test ran or read them on main, they cannot affect it.
const outsideServerSuite = [/^apps\/mobile\//, /^apps\/body\//, /^docs\//, /\.md$/];

const rootManifest = 'package.json';
// CI setup runs these root scripts before the server suite.
const setupScripts = ['preinstall', 'install', 'postinstall', 'prepare', 'build'];

export function fullSuiteReason({ path, scriptsOnly }) {
  if (scriptsOnly) return undefined;
  return fullSuitePatterns.some((pattern) => pattern.test(path)) ? `${path} changes how every server test runs` : undefined;
}

// True when a root package.json edit changes only npm scripts that the server
// suite never runs; dependency, workspace or setup-script edits run everything.
export function scriptsOnlyChange(before, after) {
  try {
    const [old, next] = [JSON.parse(before), JSON.parse(after)];
    const kept = (manifest) => JSON.stringify({ ...manifest,
      scripts: Object.fromEntries(setupScripts.map((name) => [name, manifest.scripts?.[name]])) });
    return kept(old) === kept(next);
  } catch {
    return false;
  }
}

// ---- Tests that read source code as text -----------------------------------

const readCalls = new Set(['readFileSync', 'readFile', 'readdirSync', 'readdir', 'globSync', 'glob', 'opendirSync', 'opendir']);

function moduleSpecifier(ts, node) {
  const parent = node.parent;
  if (!parent) return false;
  if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) return true;
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) return true;
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    const callee = parent.expression.getText();
    return parent.expression.kind === ts.SyntaxKind.ImportKeyword || /^(?:require|vi\.(?:do)?(?:un)?mock|vi\.importActual|vi\.importMock)$/.test(callee);
  }
  return false;
}

const codePathText = /(?:^|[^\w])(?:[\w.-]*\/)*[\w.-]*\.(?:[cm]?[jt]sx?)$/;
const codeExtensionText = /^\.(?:[cm]?[jt]sx?)$/;
const codeExtensionRegExp = /\\\.(?:\[cm\]\?)?(?:\[jt\]|j|t)(?:sx\?|s|sx)?\b/;

function stringText(ts, node) {
  return ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
    ? node.text : undefined;
}

function insideReadCall(ts, node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent)) {
      const callee = parent.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (name && readCalls.has(name)) return true;
    }
    if (ts.isStatement(parent)) return false;
  }
  return false;
}

// True when a test reads files and either names a code file inside the read,
// filters a directory by code extension, or parses what it read with the
// TypeScript compiler: the shapes of every guard that scans source text.
export function readsSourceText(ts, fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  let reads = false;
  let scansCode = false;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (name && readCalls.has(name)) reads = true;
    }
    const value = stringText(ts, node);
    if (value !== undefined && !moduleSpecifier(ts, node)) {
      if (codeExtensionText.test(value) || (codePathText.test(value) && insideReadCall(ts, node))) scansCode = true;
    }
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral && codeExtensionRegExp.test(node.text)) scansCode = true;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'typescript'
      && !node.importClause?.isTypeOnly) scansCode = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads && scansCode;
}

export function serverTestFiles(root = repo) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(path);
      } else if (testPattern.test(entry.name)) {
        found.push(path);
      }
    }
  };
  walk('apps/server/src');
  return found.sort();
}

export function sourceTextTests(ts, root = repo) {
  return serverTestFiles(root).filter((file) => readsSourceText(ts, file, readFileSync(join(root, file), 'utf8')));
}

// ---- Coverage map ------------------------------------------------------------

// Shared packages and the auth app run from their built output.
export function sourcePath(file, exists = (path) => existsSync(join(repo, path))) {
  const built = file.match(/^((?:packages|apps)\/[^/]+)\/dist\/(.*)\.js$/);
  if (!built) return file;
  for (const extension of ['.ts', '.tsx', '.js', '.mjs']) {
    const candidate = `${built[1]}/src/${built[2]}${extension}`;
    if (exists(candidate)) return candidate;
  }
  return file;
}

// `files` lists every tracked path at the map's commit, so a changed file the
// map knows but no test ran or read selects nothing instead of everything.
export function buildMap(records, { commit, createdAt, exists, files = [] } = {}) {
  const tests = [...new Set(records.map((record) => record.test))].sort();
  const index = new Map(tests.map((test, position) => [test, position]));
  const sources = {};
  const reads = {};
  const add = (list, value) => { if (!list.includes(value)) list.push(value); };
  for (const record of records) {
    const id = index.get(record.test);
    for (const [file, names] of Object.entries(record.sources)) {
      const entry = sources[sourcePath(file, exists)] ??= { tests: [], functions: {} };
      add(entry.tests, id);
      for (const name of names) add(entry.functions[name] ??= [], id);
    }
    for (const file of record.reads) add(reads[file] ??= [], id);
  }
  const sourceReaders = tests.filter((test) => records.some((record) => record.test === test
    && record.reads.some((file) => codePattern.test(file) && !testPattern.test(file))));
  return { version: MAP_VERSION, commit, createdAt, tests, sources, reads, sourceReaders, files: [...files].sort() };
}

// Tests seen reading source on main that the static scan did not find.
export function unscannedSourceReaders(map, alwaysRun) {
  return map.sourceReaders.filter((test) => !alwaysRun.includes(test));
}

// ---- Which functions a diff changes ----------------------------------------

export function parseHunks(diff) {
  const hunks = [];
  for (const line of diff.split('\n')) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match) hunks.push({ oldStart: +match[1], oldCount: +(match[2] ?? 1), newStart: +match[3], newCount: +(match[4] ?? 1) });
  }
  return hunks;
}

function propertyName(ts, name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

// The name V8 reports for a function, matching what the coverage map holds.
function runtimeName(ts, node) {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node)) return propertyName(ts, node.name);
  if (ts.isGetAccessorDeclaration(node)) return propertyName(ts, node.name) && `get ${propertyName(ts, node.name)}`;
  if (ts.isSetAccessorDeclaration(node)) return propertyName(ts, node.name) && `set ${propertyName(ts, node.name)}`;
  if (ts.isConstructorDeclaration(node)) return node.parent.name?.text;
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return propertyName(ts, parent.name);
  return undefined;
}

function typeOnly(ts, statement) {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return true;
  if (ts.isImportDeclaration(statement)) return Boolean(statement.importClause?.isTypeOnly);
  if (ts.isExportDeclaration(statement)) return statement.isTypeOnly;
  return Boolean(ts.getModifiers?.(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword));
}

// What importers can see or what runs on import: exports, re-exports,
// side-effect imports and top-level statements other than declarations.
function loadLevel(ts, statement) {
  if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) return true;
  if (ts.isImportDeclaration(statement)) return !statement.importClause;
  if (ts.getModifiers?.(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return true;
  return !(ts.isVariableStatement(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)
    || ts.isFunctionDeclaration(statement) || ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement));
}

const ANONYMOUS = '(anonymous)';

// `export const|function|class|enum`, whose importers see the new value.
function exportedDeclaration(ts, statement) {
  return (ts.isVariableStatement(statement) || ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
    || ts.isEnumDeclaration(statement))
    && Boolean(ts.getModifiers?.(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    && !ts.getModifiers?.(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

// Local names a private top-level statement declares.
function declaredNames(ts, statement) {
  const names = [];
  const bind = (name) => {
    if (!name) return;
    if (ts.isIdentifier(name)) names.push(name.text);
    else for (const element of name.elements ?? []) if (!ts.isOmittedExpression(element)) bind(element.name);
  };
  if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) bind(declaration.name);
  else if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    bind(clause?.name);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) bind(bindings.name);
    else for (const element of bindings?.elements ?? []) bind(element.name);
  } else bind(statement.name);
  return names;
}

function insideType(ts, node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isTypeNode(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)) return true;
    if (ts.isStatement(parent)) return false;
  }
  return false;
}

// The functions that use top-level bindings, following bindings that other
// top-level declarations build from them, and the exported bindings among
// those. Undefined when module code that runs on import uses one, since any
// test that loads the file sees that.
function bindingUsers(ts, source, bindings, nameOf, hasBody) {
  const pending = [...bindings];
  const seen = new Set(pending);
  const users = new Set();
  const exported = new Set(source.statements.filter((statement) => exportedDeclaration(ts, statement))
    .flatMap((statement) => declaredNames(ts, statement)).filter((name) => seen.has(name)));
  while (pending.length) {
    const binding = pending.pop();
    let loadTime = false;
    const visit = (node) => {
      if (loadTime) return;
      if (ts.isIdentifier(node) && node.text === binding && !insideType(ts, node)) {
        const parent = node.parent;
        const declares = (ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)
          || ts.isEnumDeclaration(parent) || ts.isImportSpecifier(parent) || ts.isImportClause(parent)
          || ts.isNamespaceImport(parent) || ts.isBindingElement(parent)) && parent.name === node;
        // `other.name`, `{ name: 1 }` and `import { name as alias }` name no binding.
        const property = (ts.isPropertyAccessExpression(parent) && parent.name === node)
          || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
            || ts.isImportSpecifier(parent)) && parent.name !== node && parent.propertyName === node)
          || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
            || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node);
        if (!declares && !property) {
          let fn;
          for (let up = parent; up; up = up.parent) if (hasBody(up)) { fn = up; break; }
          if (fn) users.add(nameOf(fn) ?? ANONYMOUS);
          else {
            const statement = source.statements.find((top) => node.pos >= top.pos && node.end <= top.end);
            const declaration = statement && (exportedDeclaration(ts, statement) || (!loadLevel(ts, statement)
              && (ts.isVariableStatement(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement))));
            if (!declaration) loadTime = true;
            else for (const name of declaredNames(ts, statement)) {
              if (exportedDeclaration(ts, statement)) exported.add(name);
              if (!seen.has(name)) { seen.add(name); pending.push(name); }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (loadTime) return undefined;
  }
  return { users: [...users], exported: [...exported] };
}

// Returns the runtime names of changed functions. A change to a private
// top-level declaration or import counts as a change to the functions that
// use it. Other changes outside functions (exports, code that runs on import)
// are fileLevel.
export function changedFunctions(ts, fileName, text, lines, { existing, existingFunctions } = {}) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const starts = source.getLineStarts();
  const names = new Set();
  let fileLevel = false;
  let moduleLevel = false;
  const hasBody = (node) => ts.isFunctionLike(node) && 'body' in node && node.body;
  // The nearest named function around fn; with existingFunctions, the
  // nearest one the old file had, so code added inside it counts for it.
  const nameOf = (fn) => {
    for (let node = fn; node; node = node.parent) {
      const name = hasBody(node) && runtimeName(ts, node);
      if (name && (!existingFunctions || existingFunctions.has(name))) return name;
    }
    return undefined;
  };
  const bindings = new Set();
  for (const line of lines) {
    if (line < 1 || line > starts.length) continue;
    const lineText = text.slice(starts[line - 1], starts[line] ?? text.length);
    const trimmed = lineText.trim();
    if (!trimmed || /^(?:\/\/|\/\*|\*)/.test(trimmed)) continue;
    const position = starts[line - 1] + lineText.indexOf(trimmed[0]);
    const lineEnd = starts[line] ?? text.length;
    // The innermost function around the line, else functions the line opens
    // (`load = () => 2`, `const listRooms = async () => {`).
    let innermost;
    const opened = [];
    const visit = (node) => {
      const start = node.getStart(source);
      if (hasBody(node) && start >= position && start < lineEnd) {
        opened.push(node);
        return;
      }
      if (position < start || position >= node.end) return;
      if (hasBody(node)) innermost = node;
      ts.forEachChild(node, visit);
    };
    visit(source);
    const found = (innermost ? [innermost] : opened).map(nameOf);
    if (found.length && found.every(Boolean)) {
      for (const name of found) names.add(name);
      continue;
    }
    const statement = source.statements.find((node) => position >= node.getStart(source) && position < node.end);
    if (!statement || typeOnly(ts, statement)) continue;
    // A declaration the old file did not have: only changed code can use it.
    const declared = declaredNames(ts, statement);
    if (existing && declared.length && declared.every((name) => !existing.has(name))) continue;
    if (exportedDeclaration(ts, statement) && declared.length) for (const name of declared) bindings.add(name);
    else if (loadLevel(ts, statement)) fileLevel = true;
    else {
      if (declared.length) for (const name of declared) bindings.add(name);
      else moduleLevel = true;
    }
  }
  const exports = [];
  if (bindings.size && !fileLevel) {
    const found = bindingUsers(ts, source, bindings, nameOf, hasBody);
    if (found) {
      for (const name of found.users) names.add(name);
      exports.push(...found.exported);
    } else fileLevel = true;
  }
  return { fileLevel, moduleLevel, names: [...names].sort(), ...(exports.length ? { exports: exports.sort() } : {}) };
}

function changedLines(start, count) {
  return Array.from({ length: count }, (_, offset) => start + offset);
}

// Top-level declared names and every function's runtime name in a file.
function fileNames(ts, fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const declarations = new Set(source.statements.flatMap((statement) => declaredNames(ts, statement)));
  const functions = new Set();
  const visit = (node) => {
    if (ts.isFunctionLike(node) && 'body' in node && node.body) {
      const name = runtimeName(ts, node);
      if (name) functions.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { declarations, functions };
}

// One entry per changed path: status, and for code, the changed functions.
// Functions and declarations new in this diff ran in no test on main, and
// whatever calls them changed too, so they add nothing to select.
export function describeChange(ts, { path, status, before, after, hunks }) {
  if (status !== 'M' || !codePattern.test(path)) return { path, status, fileLevel: true, names: [] };
  const previous = fileNames(ts, path, before);
  const old = changedFunctions(ts, path, before, hunks.flatMap((hunk) => changedLines(hunk.oldStart, hunk.oldCount)));
  const next = changedFunctions(ts, path, after, hunks.flatMap((hunk) => changedLines(hunk.newStart, hunk.newCount)),
    { existing: previous.declarations, existingFunctions: previous.functions });
  const exports = [...new Set([...old.exports ?? [], ...next.exports ?? []])].sort();
  return { path, status, fileLevel: old.fileLevel || next.fileLevel, moduleLevel: old.moduleLevel || next.moduleLevel,
    names: [...new Set([...old.names, ...next.names])].sort(), ...(exports.length ? { exports } : {}) };
}

// ---- Selection --------------------------------------------------------------

export function selectTests({ map, changes, alwaysRun, testFiles }) {
  const full = (reason) => ({ mode: 'full', reason });
  if (!map || map.version !== MAP_VERSION) return full('no usable coverage map');
  const selected = new Set(alwaysRun);
  for (const test of map.sourceReaders) selected.add(test);
  const reasons = {};
  // Tests main ran in other jobs, or new ones, have no coverage to go by.
  for (const test of testFiles) if (!map.tests.includes(test)) {
    selected.add(test);
    reasons[test] = 'no coverage recorded on main';
  }
  const known = new Set(map.files);
  const pick = (tests, reason) => {
    for (const test of tests) {
      if (!selected.has(test)) reasons[test] = reason;
      selected.add(test);
    }
  };
  for (const change of changes) {
    const { path, status } = change;
    const always = fullSuiteReason(change);
    if (always) return full(always);
    if (path.startsWith(serverRoot) && testPattern.test(path)) {
      if (status !== 'D') pick([path], `${path} changed`);
      continue;
    }
    const source = map.sources[path];
    const readers = (map.reads[path] ?? []).map((id) => map.tests[id]);
    pick(readers, `reads ${path}`);
    if (!source) {
      if (readers.length) continue;
      // New files, code included, may be loaded or read at runtime by paths
      // the map cannot see, so they run everything.
      if (outsideServerSuite.some((pattern) => pattern.test(path))) continue;
      // On main no test ran or read this file, in process or in a child.
      if (status !== 'A' && known.has(path)) continue;
      return full(`${path} is not in the coverage map`);
    }
    // Only types or comments changed: nothing that runs is different.
    if (status === 'M' && !change.fileLevel && !change.moduleLevel && !change.names.length && !change.exports) continue;
    // Changed exported values: the importers' functions that use them.
    if (status === 'M' && !change.fileLevel && change.exports) {
      if (!change.exportUsers) {
        pick(source.tests.map((id) => map.tests[id]), `loads ${path}`);
        continue;
      }
      for (const user of change.exportUsers) {
        if (user.test) { pick([user.path], `uses ${change.exports.join(', ')} from ${path}`); continue; }
        const importer = map.sources[user.path];
        if (!importer) continue;
        const ran = (user.names ?? []).filter((name) => importer.functions[name]);
        if (user.load || ran.length < (user.names ?? []).length) {
          pick(importer.tests.map((id) => map.tests[id]), `loads ${user.path}, which uses ${path}`);
          continue;
        }
        for (const name of ran) pick(importer.functions[name].map((id) => map.tests[id]), `runs ${name} in ${user.path}, which uses ${path}`);
      }
    }
    const ran = change.names.filter((name) => source.functions[name]);
    // A name no test ran may be a name V8 reports differently; use the file.
    if (change.fileLevel || status !== 'M' || ran.length < change.names.length) {
      pick(source.tests.map((id) => map.tests[id]), `loads ${path}`);
      continue;
    }
    // Module code only this file's functions see: every test that ran any.
    if (change.moduleLevel) pick([...new Set(Object.values(source.functions).flat())].map((id) => map.tests[id]), `runs code in ${path}`);
    for (const name of ran) pick(source.functions[name].map((id) => map.tests[id]), `runs ${name} in ${path}`);
  }
  const files = [...selected].filter((test) => testFiles.includes(test)).sort();
  return { mode: 'subset', reason: `${files.length} of ${testFiles.length} test files`, files, reasons };
}

// Server-relative paths for Vitest, which runs from apps/server.
export function serverRelative(file) {
  return relative(serverRoot, file);
}

// ---- Git and CLI ---------------------------------------------------------------

function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function resolveImport(from, specifier, exists) {
  if (!specifier.startsWith('.')) return undefined;
  const target = join(from.split('/').slice(0, -1).join('/'), specifier).replace(/\.(?:[cm]?js)$/, '');
  return ['.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts'].map((extension) => target + extension).find(exists);
}

// Files at head that import the changed exports of path, with the functions
// that use them, following exports those files build from them. Undefined
// when an importer cannot be traced statically (namespace or dynamic imports,
// re-exports, package-name imports), so the caller falls back to the file.
export function exportUsers(ts, { path, names, read, list, depth = 0 }) {
  if (depth > 3 || !path.startsWith(serverRoot)) return undefined;
  const base = path.split('/').pop().replace(/\.[^.]+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const users = [];
  for (const file of list(names)) {
    if (file === path || !codePattern.test(file)) continue;
    const text = read(file);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const locals = new Set();
    let staticImports = 0;
    for (const statement of source.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier) continue;
      if (resolveImport(file, statement.moduleSpecifier.text, (candidate) => candidate === path) !== path) continue;
      staticImports += 1;
      if (ts.isExportDeclaration(statement)) return undefined;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) return undefined;
      for (const element of bindings?.elements ?? []) if (names.includes((element.propertyName ?? element.name).text)) locals.add(element.name.text);
    }
    // The module named any other way (import(), vi.mock, require) may hand
    // over every export.
    const mentions = (text.match(new RegExp(`['"\`][^'"\`]*\\b${base}(?:\\.[cm]?[jt]sx?)?['"\`]`, 'g')) ?? []).length;
    if (mentions > staticImports) return undefined;
    if (!locals.size) continue;
    if (testPattern.test(file)) { users.push({ path: file, test: true }); continue; }
    const hasBody = (node) => ts.isFunctionLike(node) && 'body' in node && node.body;
    const nameOf = (fn) => {
      for (let node = fn; node; node = node.parent) if (hasBody(node) && runtimeName(ts, node)) return runtimeName(ts, node);
      return undefined;
    };
    const found = bindingUsers(ts, source, locals, nameOf, hasBody);
    if (!found) { users.push({ path: file, load: true }); continue; }
    users.push({ path: file, names: found.users.sort() });
    if (found.exported.length) {
      const next = exportUsers(ts, { path: file, names: found.exported, read, list, depth: depth + 1 });
      if (!next) return undefined;
      users.push(...next);
    }
  }
  return users;
}

export function gitChanges(ts, base, head = 'HEAD') {
  const changes = [];
  for (const line of git(['diff', '--name-status', '--no-renames', base, head]).trim().split('\n').filter(Boolean)) {
    const [status, path] = line.split('\t');
    const change = { path, status: status[0], before: '', after: '', hunks: [] };
    if (change.status === 'M' && path === rootManifest) {
      changes.push({ path, status: 'M', fileLevel: true, names: [],
        scriptsOnly: scriptsOnlyChange(git(['show', `${base}:${path}`]), git(['show', `${head}:${path}`])) });
      continue;
    }
    if (change.status === 'M' && codePattern.test(path)) {
      change.before = git(['show', `${base}:${path}`]);
      change.after = git(['show', `${head}:${path}`]);
      change.hunks = parseHunks(git(['diff', '-U0', '--no-renames', '--no-ext-diff', base, head, '--', path]));
    }
    const described = describeChange(ts, change);
    if (described.exports && !described.fileLevel) {
      described.exportUsers = exportUsers(ts, {
        path, names: described.exports,
        read: (file) => git(['show', `${head}:${file}`]),
        list: (words) => {
          try {
            return git(['grep', '-l', '-w', ...words.flatMap((word) => ['-e', word]), head, '--', '*.ts', '*.tsx', '*.mts', '*.js', '*.mjs'])
              .trim().split('\n').filter(Boolean).map((line) => line.slice(head.length + 1));
          } catch (error) {
            if (error.status === 1) return [];
            throw error;
          }
        },
      });
    }
    changes.push(described);
  }
  return changes;
}

// Why the map cannot describe HEAD, or undefined when it can.
export function staleMapReason(map, { now = Date.now(), isAncestor, distance }) {
  if (!map) return 'no coverage map';
  if (map.version !== MAP_VERSION) return `coverage map version ${map.version} is not ${MAP_VERSION}`;
  if (!map.commit || !isAncestor(map.commit)) return `coverage map commit ${map.commit} is not in this branch's history`;
  const age = (now - Date.parse(map.createdAt)) / 86_400_000;
  if (!(age <= MAX_MAP_AGE_DAYS)) return `coverage map is ${age.toFixed(1)} days old`;
  const behind = distance(map.commit);
  if (behind > MAX_MAP_DISTANCE) return `coverage map is ${behind} commits behind`;
  return undefined;
}

function loadTypeScript() {
  return createRequire(join(repo, 'package.json'))('typescript');
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function main() {
  const command = process.argv[2];
  const ts = loadTypeScript();
  if (command === 'build-map') {
    const directory = argument('--records');
    assert.ok(directory && argument('--commit') && argument('--out'), 'build-map needs --records, --commit and --out');
    const records = readdirSync(directory).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')));
    assert.ok(records.length > 0, 'no coverage records');
    const files = git(['ls-tree', '-r', '--full-tree', '--name-only', argument('--commit')]).trim().split('\n');
    const map = buildMap(records, { commit: argument('--commit'), createdAt: new Date().toISOString(), files });
    writeFileSync(argument('--out'), JSON.stringify(map));
    console.log(`coverage map: ${map.tests.length} tests, ${Object.keys(map.sources).length} source files, ${Object.keys(map.reads).length} read files`);
    return;
  }
  if (command === 'check-map') {
    const map = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const missing = unscannedSourceReaders(map, sourceTextTests(ts));
    if (missing.length) {
      console.error(`These tests read source code as text but the source-text scan missed them:\n${missing.join('\n')}`);
      console.error('Extend readsSourceText() in apps/server/scripts/test-selection.mjs so it finds them.');
      process.exit(1);
    }
    console.log(`source-text scan covers all ${map.sourceReaders.length} tests seen reading source on main`);
    return;
  }
  if (command === 'select') {
    const out = argument('--out');
    assert.ok(out, 'select needs --out');
    const mapPath = argument('--map');
    const map = mapPath && existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, 'utf8')) : undefined;
    const stale = staleMapReason(map, {
      isAncestor: (commit) => {
        try { git(['merge-base', '--is-ancestor', commit, 'HEAD']); return true; } catch { return false; }
      },
      distance: (commit) => Number(git(['rev-list', '--count', `${commit}..HEAD`]).trim()),
    });
    let selection;
    if (stale) {
      selection = { mode: 'full', reason: stale };
    } else {
      const testFiles = serverTestFiles();
      // Diff from the map's commit: changes merged since then count too.
      selection = selectTests({ map, changes: gitChanges(ts, map.commit), alwaysRun: sourceTextTests(ts), testFiles });
    }
    selection.mapCommit = map?.commit;
    writeFileSync(out, JSON.stringify(selection, null, 2));
    console.log(`server test selection: ${selection.mode} (${selection.reason})`);
    if (selection.files) for (const file of selection.files) console.log(`  ${file}${selection.reasons[file] ? ` — ${selection.reasons[file]}` : ''}`);
    return;
  }
  throw new Error('usage: test-selection.mjs build-map|check-map|select');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
