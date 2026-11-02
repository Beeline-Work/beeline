// Additive gate: the original phone scanner and its manifest stay authoritative.
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';
import { scanSource, NETWORK_LIBRARIES } from './phone-network-channels.mjs';

export const INVENTORY = 'packages/net/migration-sites.json';
const ROOTS = ['apps/server/src', 'apps/body/src', 'apps/api/src', 'apps/auth/src', 'apps/mobile/sources', 'apps/mobile/modules',
  'apps/mobile/index.ts', 'apps/mobile/src-tauri/src', 'packages'];
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'target', 'Pods', '__tests__', 'fixtures']);
const SOURCE = /\.(?:[cm]?[jt]sx?|swift|kt|java|m|mm|rs)$/;
const TEST = /\.(?:test|spec|typecheck)\.[^.]+$|\.d\.ts$|\/test-support[^/]*\.[^.]+$/;
const LIBRARIES = [...NETWORK_LIBRARIES, 'node:http', 'node:https', 'node:http2', 'node:net',
  'node:tls', 'node:dgram', 'http', 'https', 'http2', 'net', 'tls', 'dgram', 'ws', 'pg',
  'undici', 'openai', '@anthropic-ai/sdk', '@google/genai', '@modelcontextprotocol/sdk',
  'firebase-admin', 'web-push', 'livekit-server-sdk', '@livekit/rtc-node', 'aws4fetch',
  '@sentry/node', '@sentry/bun'];

function imports(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const result = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && !node.isTypeOnly && !node.importClause?.isTypeOnly) {
        const clause = node.importClause?.namedBindings ?? node.exportClause;
        const allType = clause && ts.isNamedImports(clause) && clause.elements.length > 0 && clause.elements.every(x => x.isTypeOnly);
        if (!allType) result.push({ specifier: node.moduleSpecifier.text, dynamic: false });
      }
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const arg = node.arguments[0];
      result.push({ specifier: arg && ts.isStringLiteralLike(arg) ? arg.text : undefined, dynamic: true });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

export function inspectSource(file, text) {
  const errors = [];
  const inCore = file.startsWith('packages/net/src/');
  const hits = scanSource(file, text, LIBRARIES).filter(hit => !hit.kind.startsWith('origin:'));
  // Rust HTTP clients are native leaves too; imports remain explicit inventory.
  if (file.endsWith('.rs')) {
    for (const match of text.matchAll(/\b(?:reqwest|hyper|TcpStream|UdpSocket|tungstenite)\b/g))
      hits.push({ kind: 'rust-network', line: text.slice(0, match.index).split('\n').length });
  }
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    for (const entry of imports(file, text)) {
      if (entry.dynamic && !entry.specifier) hits.push({ kind: 'computed-import', line: 1 });
      const target = entry.specifier?.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(file), entry.specifier))
        : entry.specifier;
      if (inCore) {
        if (entry.dynamic || !target?.startsWith('packages/net/src/'))
          errors.push(`${file}: shared router core cannot load ${entry.specifier ?? 'computed module'}`);
        // A public barrel must never export private runtime factories, even indirectly.
        if (file === 'packages/net/src/index.ts' && target?.includes('/private/'))
          errors.push(`${file}: public API exposes private owner machinery`);
      } else if (target?.startsWith('@beeline/net/') || target?.startsWith('packages/net/')) {
        // No production owner has migrated yet. Add exact owners with their M2/M3
        // proofs rather than authorizing a directory of feature callers.
        errors.push(`${file}: private router import ${entry.specifier}`);
      }
    }
  }
  if (inCore && hits.length) errors.push(`${file}: router core must be transport-free (${hits.map(x => x.kind).join(', ')})`);
  return { hits, errors };
}

export function sourceFiles(root) {
  const files = new Set();
  function walk(relative) {
    let entries;
    try { entries = readdirSync(path.join(root, relative), { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (error.code === 'ENOTDIR') { if (SOURCE.test(relative) && !TEST.test(relative)) files.add(relative); return; }
      throw error;
    }
    for (const entry of entries) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) { if (!SKIP.has(entry.name)) walk(file); }
      else if (SOURCE.test(file) && !TEST.test(file)) files.add(file);
    }
  }
  for (const start of ROOTS) walk(start);
  return [...files].sort();
}

export function scanRouterTree(root) {
  const sites = new Map();
  const errors = [];
  const files = sourceFiles(root);
  const graph = new Map();
  for (const file of files) {
    const text = readFileSync(path.join(root, file), 'utf8');
    if (file.startsWith('packages/net/src/')) graph.set(file, imports(file, text));
    const result = inspectSource(file, text);
    errors.push(...result.errors);
    for (const hit of result.hits) {
      const id = `${file}::${hit.kind}`;
      const entry = sites.get(id) ?? { id, file, kind: hit.kind, count: 0, compatibility: 'legacy-only',
        phase: file.startsWith('apps/body/') ? 'M5' : file.startsWith('apps/server/') ? 'M2' : 'M4' };
      entry.count++;
      sites.set(id, entry);
    }
  }
  // A production import cannot hide transport in a skipped test-named file.
  for (const [file, edges] of graph) {
    for (const entry of edges) {
      if (!entry.specifier?.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), entry.specifier)).replace(/\.js$/, '.ts');
      if (!graph.has(target) && target.startsWith('packages/net/src/')) {
        let text;
        try { text = readFileSync(path.join(root, target), 'utf8'); }
        catch { errors.push(`${file}: unresolved core import ${entry.specifier}`); continue; }
        graph.set(target, imports(target, text));
        errors.push(...inspectSource(target, text).errors);
      }
    }
  }
  // Follow runtime imports/reexports from the public barrel, not just direct
  // exports: a harmless-looking proxy must not expose minting machinery.
  const seen = new Set();
  function publicReach(file) {
    if (seen.has(file)) return;
    seen.add(file);
    if (file.includes('/private/')) errors.push(`${file}: private owner reachable from public API`);
    for (const entry of graph.get(file) ?? []) {
      if (!entry.specifier?.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), entry.specifier));
      publicReach(target.replace(/\.js$/, '.ts'));
    }
  }
  publicReach('packages/net/src/index.ts');
  return { sites, errors };
}

export function judgeInventory(sites, inventory, baseline) {
  const errors = [];
  const entries = new Map();
  for (const entry of inventory.entries ?? []) {
    if (entries.has(entry.id)) errors.push(`duplicate migration entry: ${entry.id}`);
    entries.set(entry.id, entry);
    if (entry.id !== `${entry.file}::${entry.kind}` || !Number.isInteger(entry.count) || entry.count < 1 ||
      entry.compatibility !== 'legacy-only' || !['M2', 'M4', 'M5'].includes(entry.phase))
      errors.push(`invalid migration entry: ${entry.id}`);
    if (sites.get(entry.id)?.count !== entry.count) errors.push(`stale migration count: ${entry.id}`);
  }
  for (const [id, site] of sites) if (!entries.has(id)) errors.push(`undeclared network boundary: ${id} (${site.count})`);
  if (baseline) {
    const before = new Map(baseline.entries.map(entry => [entry.id, entry]));
    for (const entry of entries.values()) {
      const old = before.get(entry.id);
      if (!old || entry.count > old.count) errors.push(`migration debt cannot grow: ${entry.id}`);
    }
  }
  return errors;
}

export function baselineInventory(root, base, currentSites) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['rev-parse', '--verify', `${base}^{commit}`]); // invalid/unfetched base fails closed
  const present = git(['ls-tree', '--name-only', base, '--', INVENTORY]).trim();
  if (present) return JSON.parse(git(['show', `${base}:${INVENTORY}`]));
  // Bootstrap: existing unchanged files are from the trusted base. For every
  // changed/new file use its BASE source, so adding the inventory cannot launder
  // new network sites in the same PR. Deleted files cannot increase today's debt.
  const entries = new Map(currentSites);
  const changed = git(['diff', '--name-only', base, '--', ...ROOTS]).trim().split('\n').filter(Boolean);
  const tracked = new Set(git(['ls-tree', '-r', '--name-only', base, '--', ...ROOTS]).trim().split('\n'));
  for (const file of sourceFiles(root)) if (!tracked.has(file) && !changed.includes(file)) changed.push(file);
  for (const file of changed) {
    for (const [id, site] of entries) if (site.file === file) entries.delete(id);
    if (!tracked.has(file) || !SOURCE.test(file) || TEST.test(file)) continue;
    for (const hit of inspectSource(file, git(['show', `${base}:${file}`])).hits) {
      const id = `${file}::${hit.kind}`;
      const entry = entries.get(id) ?? { id, count: 0 };
      entry.count++;
      entries.set(id, entry);
    }
  }
  return { entries: [...entries.values()] };
}
